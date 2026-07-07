import { computeNextCronRunAt, computeNextRunAt, isTaskDue } from "./cron.js";
import { ScheduledTaskExecutor } from "./executor.js";
import type { ScheduledResultSink } from "./result-sink.js";
import {
  deleteTask,
  getTask,
  listEnabledTasks,
  markError,
  markRunning,
  markSuccess,
  reapInterruptedRuns,
  recordReportHistory,
  setNextRunAt,
} from "./store.js";
import type { ScheduledResultPayload, ScheduledTask } from "./types.js";

// setTimeout silently clamps delays > ~24.8 days. When a task is that far out
// we schedule a stub timer that re-resolves the next fire when it expires.
const MAX_SAFE_TIMEOUT_MS = 2_147_483_000; // ~24.8 days
const RESCHEDULE_CHECK_FLOOR_MS = 1000;

export interface RuntimeDeps {
  executor: ScheduledTaskExecutor;
  resultSink: ScheduledResultSink;
}

export class SchedulerRuntime {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runningTaskIds = new Set<string>();
  private started = false;
  private shuttingDown = false;
  // In-flight task runs plus their result-delivery emails, so graceful
  // shutdown can wait for a firing scheduled task to finish and deliver.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: RuntimeDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;

    reapInterruptedRuns();

    let scheduled = 0;
    for (const task of listEnabledTasks()) {
      this.refreshTimerFor(task.id);
      scheduled++;
    }
    console.log(`[scheduler] recovered ${scheduled} task(s)`);
  }

  async stop(): Promise<void> {
    for (const taskId of [...this.timers.keys()]) this.clearTimer(taskId);
  }

  // Cancel all pending fire timers so no new scheduled run starts, while
  // leaving any in-flight run to complete. Call waitForInFlight() to drain.
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const taskId of [...this.timers.keys()]) this.clearTimer(taskId);
  }

  // Wait for any firing scheduled task — and its result email — to finish.
  async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private trackInFlight(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  // Cancel any existing timer for the task and re-register based on its
  // current state. Called from the API layer after create/update/resume.
  refreshTimerFor(taskId: string): void {
    this.clearTimer(taskId);

    const task = getTask(taskId);
    if (!task || !task.enabled) return;

    if (task.kind === "once") {
      const nextRunAt = computeNextRunAt(task);
      if (!nextRunAt) {
        // One-off tasks are not replayed after their original wall-clock time.
        deleteTask(taskId);
        return;
      }

      if (task.nextRunAt !== nextRunAt) {
        setNextRunAt(taskId, nextRunAt);
      }

      this.scheduleTimer(taskId, nextRunAt);
      return;
    }

    let nextRunAt = task.nextRunAt;
    if (!nextRunAt) {
      nextRunAt = computeNextRunAt(task);
      if (!nextRunAt) {
        // Once task whose runAt is already in the past — discard.
        deleteTask(taskId);
        return;
      }
      setNextRunAt(taskId, nextRunAt);
    }

    this.scheduleTimer(taskId, nextRunAt);
  }

  // Fire a task immediately, ignoring its scheduled cadence. Returns false if
  // the task is already running (per-task overlap protection).
  fireNow(taskId: string): boolean {
    const task = getTask(taskId);
    if (!task) return false;
    if (this.shuttingDown) return false;
    if (this.runningTaskIds.has(taskId)) return false;
    this.clearTimer(taskId);
    this.trackInFlight(this.runTaskNow(task));
    return true;
  }

  private clearTimer(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (!existing) return;
    clearTimeout(existing);
    this.timers.delete(taskId);
  }

  private scheduleTimer(taskId: string, nextRunAt: string): void {
    const delayMs = Math.max(
      RESCHEDULE_CHECK_FLOOR_MS,
      Date.parse(nextRunAt) - Date.now(),
    );

    if (delayMs > MAX_SAFE_TIMEOUT_MS) {
      const stub = setTimeout(() => {
        this.timers.delete(taskId);
        this.refreshTimerFor(taskId);
      }, MAX_SAFE_TIMEOUT_MS);
      this.timers.set(taskId, stub);
      return;
    }

    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.handleFire(taskId);
    }, delayMs);
    this.timers.set(taskId, timer);
  }

  private handleFire(taskId: string): void {
    if (this.shuttingDown) return;
    const task = getTask(taskId);
    if (!task) return;
    if (!task.enabled) return;

    // Defensive: don't fire if drift means we're not actually due yet.
    if (task.nextRunAt && !isTaskDue(task)) {
      this.scheduleTimer(taskId, task.nextRunAt);
      return;
    }

    if (this.runningTaskIds.has(taskId)) {
      // Previous run still in flight; skip this fire and let completion
      // reschedule. Matches telegram-bot's no-stack-of-same-task policy.
      console.warn(
        `[scheduler] skipping fire of ${taskId} — previous run still active`,
      );
      this.scheduleNextAfterRun(task);
      return;
    }

    this.trackInFlight(this.runTaskNow(task));
  }

  private async runTaskNow(task: ScheduledTask): Promise<void> {
    const fireTime = new Date().toISOString();
    this.runningTaskIds.add(task.id);
    markRunning(task.id, fireTime);

    try {
      await this.deps.executor.dispatch(task, fireTime, {
        onSuccess: (text) => this.handleCompletion(task, fireTime, text, null),
        onFailure: (err) => this.handleCompletion(task, fireTime, "", err),
      });
    } catch (error) {
      // Failure to even dispatch — surface and reschedule.
      const message = error instanceof Error ? error.message : String(error);
      this.handleCompletion(task, fireTime, "", message);
    }
  }

  private handleCompletion(
    task: ScheduledTask,
    fireTime: string,
    text: string,
    error: string | null,
  ): void {
    this.runningTaskIds.delete(task.id);

    if (error) {
      // Compute next run BEFORE marking, so cron tasks keep their cadence
      // even when individual fires fail.
      const next = this.computeNextOrNull(task);
      markError(task.id, error, next);
      this.sendScheduledResult({
        taskId: task.id,
        summary: task.summary,
        fireTime,
        body: error,
        isError: true,
      });

      if (task.kind === "once") {
        // One-off failed; drop it so the user doesn't get retried at next boot.
        deleteTask(task.id);
        return;
      }

      if (next) this.scheduleTimer(task.id, next);
      return;
    }

    // Success: persist the final output so a later fire of this same task can be
    // handed its own recent history (continuity / de-dup across runs).
    recordReportHistory({
      taskId: task.id,
      fireTime,
      summary: task.summary,
      body: text,
    });

    if (task.kind === "once") {
      markSuccess(task.id, null);
      this.sendScheduledResult({
        taskId: task.id,
        summary: task.summary,
        fireTime,
        body: text,
        isError: false,
      });
      deleteTask(task.id);
      return;
    }

    const next = this.computeNextOrNull(task);
    markSuccess(task.id, next);
    this.sendScheduledResult({
      taskId: task.id,
      summary: task.summary,
      fireTime,
      body: text,
      isError: false,
    });
    if (next) this.scheduleTimer(task.id, next);
  }

  private scheduleNextAfterRun(task: ScheduledTask): void {
    if (task.kind === "once") return;
    const next = computeNextCronRunAt(task.cronExpr, task.timezone);
    setNextRunAt(task.id, next);
    this.scheduleTimer(task.id, next);
  }

  private computeNextOrNull(task: ScheduledTask): string | null {
    if (task.kind === "once") return null;
    try {
      return computeNextCronRunAt(task.cronExpr, task.timezone);
    } catch (error) {
      console.error(`[scheduler] failed to compute next run for ${task.id}`, error);
      return null;
    }
  }

  private sendScheduledResult(payload: ScheduledResultPayload): void {
    // Tracked so a shutdown drain waits for the result email to be delivered,
    // not just for the run to compute its output.
    this.trackInFlight(
      this.deps.resultSink.sendScheduledResult(payload).catch((error) => {
        console.error(
          `[scheduler] failed to deliver scheduled result for ${payload.taskId}`,
          error,
        );
      }),
    );
  }
}
