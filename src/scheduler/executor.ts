import type { ExecutionSlot } from "../execution-slot.js";
import type { GmailRunRequest, RuntimeCallbacks } from "../opencode-runtime.js";
import type { OpencodeSession } from "../opencode.js";
import {
  buildPublicTaskContext,
  type PublicEventPublisher,
} from "../public-activity.js";
import type { SerialQueue } from "../queue.js";
import type { AppConfig } from "../types.js";
import { getRecentReports } from "./store.js";
import type { ScheduledTask } from "./types.js";

// How many past outputs of the same task to replay into the fire-time prompt,
// and a per-report cap so two large prior reports can't blow up the context.
const PRIOR_REPORT_COUNT = 2;
const PRIOR_REPORT_MAX_CHARS = 12000;

export interface ExecutorDeps {
  config: AppConfig;
  opencode: OpencodeSession;
  queue: SerialQueue;
  publicActivity: PublicEventPublisher;
  executionSlot: ExecutionSlot;
}

export interface ExecutorCallbacks {
  onSuccess(text: string): void;
  onFailure(error: string): void;
}

export class ScheduledTaskExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  // Dispatch a scheduled task into the OpencodeRuntime via the same serial queue
  // the inbound Gmail bridge uses. The promise resolves once the prompt has been
  // dispatched; success/failure flows through the callbacks below.
  async dispatch(
    task: ScheduledTask,
    fireTime: string,
    callbacks: ExecutorCallbacks,
  ): Promise<void> {
    const request = this.buildSyntheticRequest(task, fireTime);
    const lease = this.deps.executionSlot.begin(request.threadId);
    const runtimeCallbacks = this.buildRuntimeCallbacks(callbacks, lease.release);
    const publicTask = buildPublicTaskContext({
      activityKey: `scheduled:${task.id}`,
      source: "scheduler",
      summary: task.summary,
      textBody: task.prompt,
    });

    this.deps.publicActivity.emit({
      type: "scheduled_report_started",
      task: publicTask,
    });

    await this.deps.queue.enqueue(`scheduled ${task.id}`, async () => {
      try {
        const started = await this.deps.opencode.startGmailRun(request, runtimeCallbacks);
        if (!started.started || started.status !== "running") {
          lease.release();
        }
        await lease.wait();
      } catch (error) {
        lease.release();
        throw error;
      }
    }, publicTask);
  }

  private buildSyntheticRequest(
    task: ScheduledTask,
    fireTime: string,
  ): GmailRunRequest {
    const senderEmail =
      this.deps.config.userEmail ||
      this.deps.config.agentInboxEmail ||
      this.deps.config.gmailTo ||
      "scheduler@localhost";
    return {
      threadId: `scheduled-task:${task.id}:${fireTime}`,
      sourceChannel: "scheduler",
      messageId: `scheduled-task:${task.id}:${fireTime}`,
      senderEmail,
      senderName: "Scheduler",
      subject: task.summary,
      rfcMessageId: "",
      textBody: this.composePrompt(task),
      timestamp: new Date(fireTime),
      sessionKey: `scheduled-task:${task.id}:${fireTime}`,
      sessionTitle: `Scheduled: ${task.summary}`,
      publicTask: buildPublicTaskContext({
        activityKey: `scheduled:${task.id}`,
        source: "scheduler",
        summary: task.summary,
        textBody: task.prompt,
      }),
    };
  }

  // Prepend the task's most recent prior outputs to the prompt so the model can
  // see what it produced on earlier fires — enabling it to lead with what
  // changed and avoid repeating itself. Returns the bare prompt when there is no
  // history yet (e.g. a one-off task or the very first cron fire).
  private composePrompt(task: ScheduledTask): string {
    const priors = getRecentReports(task.id, PRIOR_REPORT_COUNT);
    if (priors.length === 0) return task.prompt;

    const blocks = priors
      .map((report) => {
        const body =
          report.body.length > PRIOR_REPORT_MAX_CHARS
            ? `${report.body.slice(0, PRIOR_REPORT_MAX_CHARS)}\n…(truncated)`
            : report.body;
        return `--- Previous output (${report.fireTime}) ---\n${body}`;
      })
      .join("\n\n");

    return [
      "<prior_runs>",
      "Below are your most recent previous outputs for this same scheduled task, oldest first.",
      "Use them for continuity: lead with what has changed since then, and do not re-explain stories or items already covered unless there is a genuine new development.",
      "",
      blocks,
      "</prior_runs>",
      "",
      "<current_request>",
      task.prompt,
      "</current_request>",
    ].join("\n");
  }

  private buildRuntimeCallbacks(
    callbacks: ExecutorCallbacks,
    releaseExecution: () => void,
  ): RuntimeCallbacks {
    return {
      onComplete: async (text) => {
        callbacks.onSuccess(text);
      },
      onFailed: async (error) => {
        callbacks.onFailure(error);
      },
      // Scheduled runs have no live conversation to drive interactive flow.
      // Surface the situation as a failure so the user gets a result email.
      onPermission: async () => {
        releaseExecution();
        callbacks.onFailure(
          "Scheduled run aborted: required interactive permission approval, which is not available for scheduled tasks.",
        );
      },
      onQuestion: async () => {
        releaseExecution();
        callbacks.onFailure(
          "Scheduled run aborted: required a follow-up question, which is not available for scheduled tasks.",
        );
      },
      onTerminal: async () => {
        releaseExecution();
      },
    };
  }
}
