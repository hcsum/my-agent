import fs from "node:fs";
import path from "node:path";

import type { WorkflowJobKind } from "./types.js";

const DEFAULT_MAX_EVENTS = 100;
const SKILL_ALLOWLIST = new Set([
  "check-keyword",
  "explain-code",
  "llm-wiki",
  "morning-report",
  "serp-inspection",
  "skill-authoring",
  "summarization",
  "use-ahrefs",
  "use-google-trends",
  "use-semrush",
  "use-webcafe",
  "web-access",
  "x-home-feed",
  "x-search",
]);

export type PublicEventType =
  | "deployment"
  | "agent_idle"
  | "task_received"
  | "task_queued"
  | "task_started"
  | "skill_loaded"
  | "research_started"
  | "web_data_started"
  | "draft_started"
  | "knowledge_update_started"
  | "scheduled_report_started"
  | "task_completed"
  | "task_failed"
  | "report_delivered";

export type PublicSource = "gmail" | "scheduler" | "workflow";

export interface PublicTaskContext {
  activityKey: string;
  source: PublicSource;
  taskType: string;
  publicTitle: string;
}

export type PublicDomainEvent =
  | {
      type: "deployment";
      commitSha?: string;
      commitMessage?: string;
      runId?: string;
      actor?: string;
      deployedAt?: string;
    }
  | { type: "agent_idle" }
  | { type: "task_received"; task: PublicTaskContext }
  | { type: "task_queued"; task: PublicTaskContext }
  | { type: "task_started"; task: PublicTaskContext }
  | { type: "skill_loaded"; task: PublicTaskContext; skillName: string }
  | { type: "research_started"; task: PublicTaskContext }
  | { type: "web_data_started"; task: PublicTaskContext }
  | { type: "draft_started"; task: PublicTaskContext }
  | { type: "knowledge_update_started"; task: PublicTaskContext }
  | { type: "scheduled_report_started"; task: PublicTaskContext }
  | { type: "task_completed"; task: PublicTaskContext; durationMs?: number }
  | { type: "task_failed"; task: PublicTaskContext; error?: string }
  | { type: "report_delivered"; task: PublicTaskContext };

export interface PublicActivityEntry {
  id: string;
  ts: string;
  type: PublicEventType;
  status: string;
  title: string;
  summary?: string;
  source?: PublicSource;
  taskType?: string;
  skillName?: string;
  durationMs?: number;
  commitSha?: string;
  commitMessage?: string;
  runId?: string;
  actor?: string;
}

export interface PublicCurrentState {
  status: string;
  title: string;
  summary?: string;
  updatedAt: string;
  activeCount: number;
  stats: PublicActivityStats;
  source?: PublicSource;
  taskType?: string;
}

export interface PublicActivityStats {
  tasksHandled: number;
  tasksCompleted: number;
  tasksFailed: number;
}

export interface PublicActivityFile {
  updatedAt: string;
  events: PublicActivityEntry[];
  meta?: {
    deploymentFingerprint?: string;
  };
}

export interface PublicActivitySnapshot {
  current: PublicCurrentState;
  eventsFile: PublicActivityFile;
}

interface DeploymentInfo {
  commitSha?: string;
  commitMessage?: string;
  runId?: string;
  actor?: string;
  deployedAt?: string;
}

const DEFAULT_STATS: PublicActivityStats = {
  tasksHandled: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
};

export class PublicEventPublisher {
  private readonly currentPath: string;
  private readonly eventsPath: string;
  private readonly activeRuns = new Set<string>();
  private readonly maxEvents: number;
  private readonly deploymentInfo?: DeploymentInfo;
  private readonly snapshotListener?: (snapshot: PublicActivitySnapshot) => void;
  private events: PublicActivityEntry[] = [];
  private current: PublicCurrentState;
  private sequence = 0;
  private deploymentFingerprint?: string;

  constructor(
    dir: string,
    maxEvents = DEFAULT_MAX_EVENTS,
    deploymentInfo?: DeploymentInfo,
    snapshotListener?: (snapshot: PublicActivitySnapshot) => void,
  ) {
    this.maxEvents = maxEvents > 0 ? maxEvents : DEFAULT_MAX_EVENTS;
    this.deploymentInfo = deploymentInfo;
    this.snapshotListener = snapshotListener;
    fs.mkdirSync(dir, { recursive: true });
    this.currentPath = path.join(dir, "current.json");
    this.eventsPath = path.join(dir, "events.json");
    this.current = this.buildIdleState(new Date().toISOString());
    this.loadSnapshot();
    this.recordDeploymentIfNeeded();
    this.writeSnapshot();
  }

  emit(event: PublicDomainEvent): void {
    if ("task" in event) {
      if (event.type === "task_started") {
        this.activeRuns.add(event.task.activityKey);
      }
      if (event.type === "task_completed" || event.type === "task_failed") {
        this.activeRuns.delete(event.task.activityKey);
      }
    }

    const entry = this.renderEvent(event);
    if (!entry) return;
    this.appendEntry(entry);
  }

  setIdleIfNoActiveRuns(): void {
    if (this.activeRuns.size > 0) return;
    const last = this.events.at(-1);
    if (last?.type === "agent_idle") {
      this.current = {
        ...this.buildIdleState(last.ts),
        // Preserve the cumulative counters; rebuilding idle state must not
        // reset tasksHandled/tasksCompleted/tasksFailed (which would zero the
        // counts on every restart/deploy).
        stats: this.current.stats,
        activeCount: this.activeRuns.size,
      };
      this.writeSnapshot();
      return;
    }
    this.emit({ type: "agent_idle" });
  }

  private appendEntry(entry: PublicActivityEntry): void {
    const stats = nextStats(this.current.stats, entry.type);
    this.events.push(entry);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    this.current = {
      status: entry.status,
      title: entry.title,
      ...(entry.summary ? { summary: entry.summary } : {}),
      updatedAt: entry.ts,
      activeCount: this.activeRuns.size,
      stats,
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.taskType ? { taskType: entry.taskType } : {}),
    };
    this.writeSnapshot();
  }

  private renderEvent(event: PublicDomainEvent): PublicActivityEntry | undefined {
    const ts = new Date().toISOString();

    switch (event.type) {
      case "deployment":
        return {
          id: this.nextId("deployment"),
          ts: event.deployedAt || ts,
          type: event.type,
          status: "deployment",
          title: buildDeploymentTitle(event.commitSha),
          ...(buildDeploymentSummary(event) ? { summary: buildDeploymentSummary(event) } : {}),
          ...(event.commitSha ? { commitSha: event.commitSha } : {}),
          ...(event.commitMessage ? { commitMessage: event.commitMessage } : {}),
          ...(event.runId ? { runId: event.runId } : {}),
          ...(event.actor ? { actor: event.actor } : {}),
        };
      case "agent_idle":
        return {
          id: this.nextId("idle"),
          ts,
          type: event.type,
          status: "idle",
          title: "Agent idle",
        };
      case "task_received":
        return this.buildTaskEntry(
          ts,
          event.type,
          "received",
          event.task,
          `Incoming task: ${event.task.publicTitle}`,
        );
      case "task_queued":
        return this.buildTaskEntry(ts, event.type, "queued", event.task, "Task queued");
      case "task_started":
        return this.buildTaskEntry(ts, event.type, "running", event.task, "Task started");
      case "skill_loaded":
        if (!SKILL_ALLOWLIST.has(event.skillName)) return undefined;
        return {
          id: this.nextId("skill"),
          ts,
          type: event.type,
          status: "running",
          title: `Loaded skill: ${event.skillName}`,
          source: event.task.source,
          taskType: event.task.taskType,
          skillName: event.skillName,
        };
      case "research_started":
        return this.buildTaskEntry(
          ts,
          event.type,
          "researching",
          event.task,
          "Researching sources",
        );
      case "web_data_started":
        return this.buildTaskEntry(
          ts,
          event.type,
          "researching",
          event.task,
          "Gathering web data",
        );
      case "draft_started":
        return this.buildTaskEntry(
          ts,
          event.type,
          "drafting",
          event.task,
          "Drafting response",
        );
      case "knowledge_update_started":
        return this.buildTaskEntry(
          ts,
          event.type,
          "knowledge",
          event.task,
          "Updating knowledge",
        );
      case "scheduled_report_started":
        return this.buildTaskEntry(
          ts,
          event.type,
          "running",
          event.task,
          "Preparing scheduled report",
        );
      case "task_completed":
        return this.buildTaskEntry(
          ts,
          event.type,
          "completed",
          event.task,
          "Task completed",
          event.durationMs ? `Completed in ${formatDuration(event.durationMs)}.` : undefined,
          event.durationMs,
        );
      case "task_failed":
        return this.buildTaskEntry(
          ts,
          event.type,
          "failed",
          event.task,
          "Task failed",
          sanitizeFailure(event.error),
        );
      case "report_delivered":
        return this.buildTaskEntry(
          ts,
          event.type,
          "delivered",
          event.task,
          "Report delivered",
        );
    }
  }

  private buildTaskEntry(
    ts: string,
    type: PublicEventType,
    status: string,
    task: PublicTaskContext,
    title: string,
    summary?: string,
    durationMs?: number,
  ): PublicActivityEntry {
    return {
      id: this.nextId(type),
      ts,
      type,
      status,
      title,
      ...(summary ? { summary } : {}),
      source: task.source,
      taskType: task.taskType,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  private buildIdleState(ts: string): PublicCurrentState {
    return {
      status: "idle",
      title: "Agent idle",
      updatedAt: ts,
      activeCount: 0,
      stats: { ...DEFAULT_STATS },
    };
  }

  private writeSnapshot(): void {
    const eventsFile = this.buildEventsFile();
    writeJsonAtomic(this.currentPath, this.current);
    writeJsonAtomic(this.eventsPath, eventsFile);
    if (!this.snapshotListener) return;

    try {
      this.snapshotListener({
        current: cloneCurrentState(this.current),
        eventsFile: cloneEventsFile(eventsFile),
      });
    } catch (error) {
      console.error("[public-activity] snapshot listener failed", error);
    }
  }

  private buildEventsFile(): PublicActivityFile {
    return {
      updatedAt: new Date().toISOString(),
      events: this.events,
      meta: {
        ...(this.deploymentFingerprint
          ? { deploymentFingerprint: this.deploymentFingerprint }
          : {}),
      },
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${Date.now()}-${this.sequence}`;
  }

  private loadSnapshot(): void {
    const eventsFile = readJsonFile<PublicActivityFile>(this.eventsPath);
    const current = readJsonFile<PublicCurrentState>(this.currentPath);

    if (eventsFile?.events) {
      this.events = eventsFile.events.slice(-this.maxEvents);
      this.sequence = this.events.length;
      this.deploymentFingerprint = eventsFile.meta?.deploymentFingerprint;
    }

    if (current) {
      this.current = normalizeCurrentState(current);
      // Older snapshots predate the stats field. Recover the counters from the
      // retained event log instead of falling back to zeros.
      if (!current.stats && this.events.length > 0) {
        this.current.stats = deriveStatsFromEvents(this.events);
      }
    } else if (this.events.length > 0) {
      const last = this.events.at(-1);
      if (last) {
        this.current = {
          status: last.status,
          title: last.title,
          ...(last.summary ? { summary: last.summary } : {}),
          updatedAt: last.ts,
          activeCount: 0,
          stats: deriveStatsFromEvents(this.events),
          ...(last.source ? { source: last.source } : {}),
          ...(last.taskType ? { taskType: last.taskType } : {}),
        };
      }
    }
  }

  private recordDeploymentIfNeeded(): void {
    if (!this.deploymentInfo) return;
    const fingerprint = buildDeploymentFingerprint(this.deploymentInfo);
    if (!fingerprint) return;
    if (this.deploymentFingerprint === fingerprint) return;

    this.deploymentFingerprint = fingerprint;
    this.appendEntry(
      this.renderEvent({
        type: "deployment",
        ...this.deploymentInfo,
      }) as PublicActivityEntry,
    );
  }
}

export function buildPublicTaskContext(input: {
  activityKey: string;
  source: PublicSource;
  subject?: string;
  textBody?: string;
  summary?: string;
  workflowKind?: WorkflowJobKind;
}): PublicTaskContext {
  const text = [input.subject, input.textBody, input.summary]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  if (input.workflowKind === "ingest") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-ingest",
      publicTitle: "Knowledge ingest",
    };
  }

  if (input.workflowKind === "query") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-query",
      publicTitle: "Knowledge query",
    };
  }

  if (input.workflowKind === "lint") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-lint",
      publicTitle: "Knowledge lint",
    };
  }

  if (/morning report/.test(text)) {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: input.source === "scheduler" ? "scheduled-report" : "morning-report",
      publicTitle: "Morning report",
    };
  }

  if (/keyword|seo|serp|search the web|search web|research/.test(text)) {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "research",
      publicTitle: "Research task",
    };
  }

  if (input.source === "scheduler") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "scheduled-task",
      publicTitle: "Scheduled task",
    };
  }

  if (input.source === "workflow") {
    return {
      activityKey: input.activityKey,
      source: input.source,
      taskType: "knowledge-task",
      publicTitle: "Knowledge task",
    };
  }

  return {
    activityKey: input.activityKey,
    source: input.source,
    taskType: "email-task",
    publicTitle: "Email task",
  };
}

export function extractLoadedSkillName(label: string): string | undefined {
  const match = label.match(/^Loaded skill:\s+([a-z0-9-]+)$/i);
  if (!match) return undefined;
  const skillName = match[1].trim();
  return SKILL_ALLOWLIST.has(skillName) ? skillName : undefined;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function sanitizeFailure(input?: string): string | undefined {
  if (!input?.trim()) return undefined;
  if (/permission/i.test(input)) {
    return "Waiting for permission was not possible for this task.";
  }
  if (/question/i.test(input)) {
    return "This task required an unavailable follow-up question.";
  }
  if (/idle/i.test(input)) {
    return "The task timed out after going idle.";
  }
  return "The task ended with an internal error.";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function normalizeCurrentState(current: PublicCurrentState): PublicCurrentState {
  return {
    ...current,
    stats: current.stats
      ? {
          tasksHandled: current.stats.tasksHandled || 0,
          tasksCompleted: current.stats.tasksCompleted || 0,
          tasksFailed: current.stats.tasksFailed || 0,
        }
      : { ...DEFAULT_STATS },
  };
}

function cloneCurrentState(current: PublicCurrentState): PublicCurrentState {
  return {
    ...current,
    stats: { ...current.stats },
  };
}

function cloneEventsFile(eventsFile: PublicActivityFile): PublicActivityFile {
  return {
    updatedAt: eventsFile.updatedAt,
    events: eventsFile.events.map((entry) => ({ ...entry })),
    ...(eventsFile.meta ? { meta: { ...eventsFile.meta } } : {}),
  };
}

function deriveStatsFromEvents(events: PublicActivityEntry[]): PublicActivityStats {
  return events.reduce(
    (stats, entry) => nextStats(stats, entry.type),
    { ...DEFAULT_STATS },
  );
}

function nextStats(
  current: PublicActivityStats,
  eventType: PublicEventType,
): PublicActivityStats {
  if (eventType === "task_completed") {
    return {
      tasksHandled: current.tasksHandled + 1,
      tasksCompleted: current.tasksCompleted + 1,
      tasksFailed: current.tasksFailed,
    };
  }

  if (eventType === "task_failed") {
    return {
      tasksHandled: current.tasksHandled + 1,
      tasksCompleted: current.tasksCompleted,
      tasksFailed: current.tasksFailed + 1,
    };
  }

  return current;
}

function buildDeploymentFingerprint(info: DeploymentInfo): string | undefined {
  const parts = [info.commitSha, info.runId, info.deployedAt]
    .filter(Boolean)
    .map((item) => item?.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(":");
}

function buildDeploymentTitle(commitSha?: string): string {
  return commitSha
    ? `Deployment: ${commitSha.slice(0, 7)}`
    : "Deployment completed";
}

function buildDeploymentSummary(event: DeploymentInfo): string | undefined {
  const meta: string[] = [];
  if (event.actor) meta.push(`by ${event.actor}`);
  if (event.runId) meta.push(`run ${event.runId}`);
  const metaLine = meta.join(" · ");

  // Lead with the concrete commit message so the event stream reads like a
  // changelog rather than just an opaque SHA; fall back to the actor/run line.
  const message = event.commitMessage?.trim();
  if (message) {
    return metaLine ? `${message} · ${metaLine}` : message;
  }
  return metaLine || undefined;
}
