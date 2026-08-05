import {
  createOpencodeClient,
  type Message,
  type OpencodeClient,
  type Part,
  type PermissionRequest,
} from "@opencode-ai/sdk/v2/client";

import {
  buildPublicTaskContext,
  extractLoadedSkillName,
  type PublicEventPublisher,
  type PublicTaskContext,
} from "./public-activity.js";
import type { OpencodeProviderConfig } from "./types.js";

// Only abort a quiet stream while we believe something is running — an idle
// server legitimately sends nothing for hours, and reconnecting through that
// would be pure churn.
const STREAM_IDLE_TIMEOUT_MS = 45_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 1_000;

interface ObservedSession {
  task: PublicTaskContext;
  startedAtMs: number;
  loadedSkills: Set<string>;
}

interface StreamEventPayload {
  type: string;
  properties: unknown;
}

/**
 * Watches an OpenCode server that this process does not drive, and republishes
 * what it sees onto the public activity feed.
 *
 * The bridge spawns an OpenCode server so external clients (the Telegram bot,
 * a local TUI) have something to connect to. Those sessions are nobody's run
 * as far as this process is concerned, so without an observer they are
 * invisible on the public status page — which is what happened whenever the
 * bridge itself ran on the Claude provider: `OpencodeRuntime`, the only thing
 * that used to carry this logic, was never constructed, so nothing subscribed
 * to the event stream at all.
 *
 * Every session on that server is external by definition here, so unlike the
 * copy inside `OpencodeRuntime` this one needs no "is it mine?" test. It
 * deliberately cannot tell Telegram from a TUI session: both surface as the
 * `session` source, since the server does not report which client opened a
 * session.
 */
export class ExternalSessionObserver {
  private readonly client: OpencodeClient;
  private readonly sessions = new Map<string, ObservedSession>();
  private streamAbort?: AbortController;
  private watchdog?: NodeJS.Timeout;
  private lastEventAt = Date.now();
  private started = false;
  private stopped = false;

  constructor(
    opencode: OpencodeProviderConfig,
    private readonly publicActivity: PublicEventPublisher,
  ) {
    this.client = createOpencodeClient({
      baseUrl: opencode.baseUrl,
      fetch: buildAuthenticatedFetch(opencode),
    });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;

    this.watchdog = setInterval(() => {
      if (this.sessions.size === 0) return;
      if (Date.now() - this.lastEventAt < STREAM_IDLE_TIMEOUT_MS) return;
      console.warn("[external-session] event stream idle; reconnecting");
      this.streamAbort?.abort();
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();

    void this.streamLoop();
    console.log("[external-session] observing sessions on the OpenCode server");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.streamAbort?.abort();
  }

  private async streamLoop(): Promise<void> {
    while (!this.stopped) {
      const controller = new AbortController();
      this.streamAbort = controller;

      try {
        const stream = await this.client.event.subscribe(undefined, {
          signal: controller.signal,
        });

        // Reset on reconnect — otherwise the watchdog aborts again on its next tick.
        this.lastEventAt = Date.now();

        for await (const rawEvent of stream.stream) {
          this.lastEventAt = Date.now();
          this.handleEvent(rawEvent as unknown as StreamEventPayload);
        }
      } catch (error) {
        if (!controller.signal.aborted && !this.stopped) {
          console.error("[external-session] event stream failed", error);
        }
      }

      if (this.stopped) return;
      await sleep(RECONNECT_DELAY_MS);
    }
  }

  private handleEvent(event: StreamEventPayload): void {
    switch (event.type) {
      case "message.updated": {
        const props = event.properties as { sessionID: string; info: Message };
        if (props.info?.role !== "assistant") return;
        this.ensureSession(props.sessionID);
        return;
      }
      case "message.part.updated": {
        const props = event.properties as { sessionID: string; part: Part };
        this.ensureSession(props.sessionID);
        this.maybeEmitSkill(props.sessionID, props.part);
        return;
      }
      case "permission.asked": {
        const props = event.properties as unknown as PermissionRequest;
        this.markWaiting(props.sessionID, "permission");
        return;
      }
      case "question.asked": {
        const props = event.properties as { sessionID: string };
        this.markWaiting(props.sessionID, "question");
        return;
      }
      case "session.idle": {
        const props = event.properties as { sessionID?: string };
        if (props.sessionID) this.completeSession(props.sessionID);
        return;
      }
      case "session.error": {
        const props = event.properties as {
          sessionID?: string;
          error?: unknown;
        };
        if (props.sessionID) {
          this.failSession(props.sessionID, describeError(props.error));
        }
        return;
      }
    }
  }

  private ensureSession(sessionId: string): ObservedSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const observed: ObservedSession = {
      task: buildPublicTaskContext({
        activityKey: `session:${sessionId}`,
        source: "session",
      }),
      startedAtMs: Date.now(),
      loadedSkills: new Set(),
    };
    this.sessions.set(sessionId, observed);
    this.publicActivity.emit({ type: "task_started", task: observed.task });
    return observed;
  }

  private maybeEmitSkill(sessionId: string, part: Part): void {
    if (part?.type !== "tool") return;
    const toolPart = part as { state?: { title?: string }; tool?: string };
    const label = toolPart.state?.title?.trim() || toolPart.tool;
    if (!label) return;

    const skillName = extractLoadedSkillName(label);
    if (!skillName) return;

    const observed = this.ensureSession(sessionId);
    if (observed.loadedSkills.has(skillName)) return;
    observed.loadedSkills.add(skillName);
    this.publicActivity.emit({
      type: "skill_loaded",
      task: observed.task,
      skillName,
    });
  }

  private markWaiting(
    sessionId: string | undefined,
    reason: "permission" | "question",
  ): void {
    if (!sessionId) return;
    const observed = this.ensureSession(sessionId);
    this.publicActivity.emit({
      type: "task_waiting",
      task: observed.task,
      reason,
    });
  }

  private completeSession(sessionId: string): void {
    const observed = this.sessions.get(sessionId);
    if (!observed) return;
    this.sessions.delete(sessionId);
    this.publicActivity.emit({
      type: "task_completed",
      task: observed.task,
      durationMs: Date.now() - observed.startedAtMs,
    });
    this.publicActivity.setIdleIfNoActiveRuns();
  }

  private failSession(sessionId: string, error: string): void {
    const observed = this.sessions.get(sessionId);
    if (!observed) return;
    this.sessions.delete(sessionId);
    this.publicActivity.emit({
      type: "task_failed",
      task: observed.task,
      error,
    });
    this.publicActivity.setIdleIfNoActiveRuns();
  }
}

function buildAuthenticatedFetch(opencode: OpencodeProviderConfig): typeof fetch {
  const authHeader = buildBasicAuthHeader(
    opencode.serverUsername,
    opencode.serverPassword,
  );
  if (!authHeader) return fetch;

  return async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("authorization", authHeader);
    return fetch(new Request(request, { headers }));
  };
}

function buildBasicAuthHeader(
  username?: string,
  password?: string,
): string | undefined {
  if (!password) return undefined;
  const resolvedUser = username || "opencode";
  const encoded = Buffer.from(`${resolvedUser}:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

function describeError(error: unknown): string {
  if (!error) return "Agent session failed";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.data ?? record.name;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Agent session failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
