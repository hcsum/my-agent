import type {
  AssistantMessage,
  FilePartInput,
  Message,
  Part,
  PermissionRequest,
  QuestionInfo,
} from "@opencode-ai/sdk/v2/client";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import {
  clearPendingPermission,
  clearPendingQuestion,
  getThreadRun,
  type PendingQuestionRecord,
  type ThreadRunRecord,
  updateThreadRunStatus,
  upsertPendingPermission,
  upsertPendingQuestion,
  upsertThreadRun,
} from "./db.js";
import {
  buildPublicTaskContext,
  extractLoadedSkillName,
  type PublicEventPublisher,
  type PublicTaskContext,
} from "./public-activity.js";
import type { AppConfig, QuestionPrompt, ThreadRunStatus } from "./types.js";

// Heartbeat-based timeout: a run is killed only if the model stops producing
// progress (no new assistant message or message part) for IDLE_TIMEOUT_MS.
// HARD_TIMEOUT_MS is an absolute ceiling for runs that keep heartbeating forever.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const HARD_TIMEOUT_MS = 25 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const STREAM_IDLE_TIMEOUT_MS = 45000;
const WEB_ACCESS_HANDOFF_TIMEOUT_MS = 75 * 1000;
const DIAGNOSTIC_LOG_INTERVAL_MS = 30 * 1000;
const ASSISTANT_SHELL_STALL_TIMEOUT_MS = 90 * 1000;
const BUSY_MESSAGE_SYNC_INTERVAL_MS = 15 * 1000;
const MAX_STALL_RECOVERY_ATTEMPTS = 1;

export type PermissionResponse = "once" | "always" | "reject";

// An image lifted from the inbound email body/attachments. Transports should
// stage bytes to localPath so Claude runs can summarize once and keep raw image
// bytes out of the long agent transcript. `url` remains for providers that need
// a file part data URI on first dispatch.
export interface RunImageInput {
  mime: string;
  filename: string;
  url?: string;
  localPath?: string;
  size?: number;
}

export interface GmailRunRequest {
  threadId: string;
  sourceChannel: string;
  messageId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  rfcMessageId: string;
  textBody: string;
  images?: RunImageInput[];
  timestamp: Date;
  sessionKey: string;
  sessionTitle: string;
  publicTask: PublicTaskContext;
}

export interface RuntimePermissionRequest {
  threadId: string;
  sessionId: string;
  permissionId: string;
  messageId: string;
  title: string;
  type: string;
  pattern: string;
}

export interface RuntimeQuestionRequest {
  threadId: string;
  sessionId: string;
  questionId: string;
  messageId: string;
  questions: QuestionPrompt[];
}

export interface RuntimeCallbacks {
  onPermission(request: RuntimePermissionRequest): Promise<void>;
  onQuestion(request: RuntimeQuestionRequest): Promise<void>;
  onComplete(text: string): Promise<void>;
  onFailed(error: string): Promise<void>;
  onTerminal(): Promise<void>;
}

export interface RuntimeSessionManager {
  getOrCreateSessionId(request: {
    channel: string;
    sessionKey: string;
    sessionTitle: string;
    sessionDirectory?: string;
  }): Promise<string>;
  invalidateSession(sessionKey: string): Promise<void>;
}

interface ActiveRun {
  threadId: string;
  sessionKey: string;
  sessionId: string;
  startedAtMs: number;
  updatedAtMs: number;
  // Bumped whenever the model produces new output (assistant message or part)
  // or the user unblocks the run via permission/question reply. Drives the
  // idle timeout — distinct from startedAtMs which is reset on resume to
  // gate message-filter floors.
  lastProgressAtMs: number;
  // True wall-clock origin of the run, never mutated after install. Used for
  // the hard ceiling so a chatty-but-non-converging run can still be killed.
  runOriginAtMs: number;
  callbacks: RuntimeCallbacks;
  status: ThreadRunStatus;
  latestAssistantMessageId?: string;
  latestAssistantCreatedAt?: number;
  finalizing: boolean;
  meta: ThreadRunRecord;
  publicTask: PublicTaskContext;
  emittedStages: Set<
    | "research_started"
    | "web_data_started"
    | "draft_started"
    | "knowledge_update_started"
  >;
  loadedSkills: Set<string>;
  lastProgressSummary: string;
  lastDiagnosticAtMs: number;
  webAccessLoadedAtMs?: number;
  recoveryAttempts: number;
  pendingAssistantShellMessageId?: string;
  pendingAssistantShellCreatedAtMs?: number;
  lastPartMessageId?: string;
  lastPartFingerprint?: string;
  lastMessageSyncAtMs: number;
  loggedModel?: string;
  currentModel?: { providerID: string; modelID: string };
  usedFallbackModel?: boolean;
}

interface StreamEventPayload {
  type: string;
  properties: Record<string, unknown>;
}

interface ToolPartEvent {
  type: "tool";
  tool: string;
  state?: {
    status?: "pending" | "running" | "completed" | "error";
    title?: string;
    error?: string;
  };
}

interface TextPartEvent {
  type: "text";
  text: string;
  metadata?: {
    openai?: {
      phase?: string;
    };
  };
}

interface ObservedExternalSession {
  task: PublicTaskContext;
  startedAtMs: number;
  loadedSkills: Set<string>;
}

export class OpencodeRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly sessionToThread = new Map<string, string>();
  private readonly observedExternalSessions = new Map<
    string,
    ObservedExternalSession
  >();
  // Cache of `${providerID}/${modelID}` -> context window size, populated lazily
  // from config.providers() so the context-usage footer can show a percentage.
  private readonly modelContextLimits = new Map<string, number>();
  private modelContextLimitsLoaded = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private streamWatchdog: ReturnType<typeof setInterval> | null = null;
  private streamAbort?: AbortController;
  private streamLoopStarted = false;
  private lastEventAt = Date.now();

  constructor(
    private readonly client: OpencodeClient,
    private readonly config: AppConfig,
    private readonly sessionManager: RuntimeSessionManager,
    private readonly publicActivity: PublicEventPublisher,
  ) {}

  startBackgroundMonitoring(): void {
    this.ensureBackgroundLoops();
  }

  async startRun(
    request: GmailRunRequest,
    callbacks: RuntimeCallbacks,
  ): Promise<{
    started: boolean;
    status: ThreadRunStatus;
    sessionId?: string;
  }> {
    const existing =
      this.activeRuns.get(request.threadId) ||
      this.restoreActiveRun(request.threadId, callbacks);
    if (existing && isActiveStatus(existing.status)) {
      existing.callbacks = callbacks;
      return {
        started: false,
        status: existing.status,
        sessionId: existing.sessionId,
      };
    }

    const startedAtMs = Date.now();
    const sessionId = await this.getFreshSessionId(request);
    // The email subject often carries the actual task while the body holds
    // refinements (or is empty). Fold the subject into the prompt so the model
    // sees both; otherwise it only ever receives the body and misses the ask.
    const promptText = composeRunPrompt(request);
    const meta: ThreadRunRecord = {
      threadId: request.threadId,
      sourceChannel: request.sourceChannel,
      sessionKey: request.sessionKey,
      sessionId,
      sessionTitle: request.sessionTitle,
      gmailMessageId: request.messageId,
      senderEmail: request.senderEmail,
      senderName: request.senderName,
      subject: request.subject,
      rfcMessageId: request.rfcMessageId,
      lastUserText: promptText,
      status: "running",
      lastError: "",
      startedAtMs,
      updatedAtMs: startedAtMs,
    };

    upsertThreadRun(meta);
    const run = this.installRun(meta, callbacks);
    run.publicTask = request.publicTask;
    this.ensureBackgroundLoops();
    this.noteProgress(run, "Run created and waiting for model output.");

    // Inline images from the email travel only on the first dispatch — they are
    // not persisted on the run, so a stall-recovery re-launch is text-only.
    const fileParts = buildImageFileParts(request.images);
    if (fileParts.length > 0) {
      console.log(
        `[opencode-runtime] attaching ${fileParts.length} inbound image(s) thread=${run.threadId}`,
      );
    }

    // promptAsync can stay open until the run finishes. Keep it in the
    // background so one slow Gmail thread does not block unrelated threads.
    void this.launchPrompt(run, promptText, fileParts);

    return { started: true, status: "running", sessionId };
  }

  private async launchPrompt(
    run: ActiveRun,
    text: string,
    fileParts: FilePartInput[] = [],
  ): Promise<void> {
    const startedAt = Date.now();
    const requestedModel = formatConfiguredModel(run.currentModel);
    console.log(
      `[opencode-runtime] prompt dispatch thread=${run.threadId} session=${run.sessionId}${requestedModel ? ` requestedModel=${requestedModel}` : ""}`,
    );
    try {
      await this.ensureSuccess(
        this.client.session.promptAsync({
          sessionID: run.sessionId,
          ...(run.currentModel ? { model: run.currentModel } : {}),
          parts: [{ type: "text", text }, ...fileParts],
        }),
      );
      this.noteProgress(run, "Prompt accepted by OpenCode runtime.");
      console.log(
        `[opencode-runtime] prompt accepted thread=${run.threadId} in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      const active = this.activeRuns.get(run.threadId);
      if (
        !active ||
        active.sessionId !== run.sessionId ||
        !isActiveStatus(active.status)
      ) {
        return;
      }
      console.error(
        `[opencode-runtime] prompt dispatch failed thread=${run.threadId}`,
        error,
      );
      await this.handleRecoverableRunError(active, error);
    }
  }

  async resumeRun(
    threadId: string,
    callbacks: RuntimeCallbacks,
  ): Promise<boolean> {
    const existing = this.activeRuns.get(threadId);
    if (existing) {
      existing.callbacks = callbacks;
      return true;
    }

    const restored = this.restoreActiveRun(threadId, callbacks);
    if (!restored) return false;
    this.ensureBackgroundLoops();
    return true;
  }

  hasActiveRun(threadId: string): boolean {
    const current = this.activeRuns.get(threadId);
    if (current) {
      return isActiveStatus(current.status);
    }

    const persisted = getThreadRun(threadId);
    return Boolean(persisted && isActiveStatus(persisted.status));
  }

  async replyPermission(
    threadId: string,
    permissionId: string,
    response: PermissionResponse,
    callbacks: RuntimeCallbacks,
  ): Promise<void> {
    const run = await this.requireRun(threadId, callbacks);
    await this.ensureSuccess(
      this.client.permission.reply({
        requestID: permissionId,
        reply: response,
      }),
    );
    clearPendingPermission(threadId);
    this.resumeRunClock(run);
    this.updateRunState(run, "running");
  }

  async replyQuestion(
    threadId: string,
    questionId: string,
    answers: string[][],
    callbacks: RuntimeCallbacks,
  ): Promise<void> {
    const run = await this.requireRun(threadId, callbacks);
    await this.ensureSuccess(
      this.client.question.reply({
        requestID: questionId,
        answers,
      }),
    );
    clearPendingQuestion(threadId);
    this.resumeRunClock(run);
    this.updateRunState(run, "running");
  }

  // Reset the timeout baselines when the model resumes work after a human pause.
  // Without this, time spent waiting on the user would count against IDLE_TIMEOUT_MS,
  // so a long approval would force an immediate fail on the very next poll.
  // startedAtMs is still reset because findLatestCompletedAssistantMessage uses it
  // as a message-filter floor — without the reset, a stale terminal assistant message
  // from before the pause could be re-finalized.
  private resumeRunClock(run: ActiveRun): void {
    const now = Date.now();
    run.startedAtMs = now;
    run.lastProgressAtMs = now;
    run.meta = { ...run.meta, startedAtMs: now };
  }

  private restoreActiveRun(
    threadId: string,
    callbacks: RuntimeCallbacks,
  ): ActiveRun | undefined {
    const persisted = getThreadRun(threadId);
    if (!persisted || !isActiveStatus(persisted.status)) {
      return undefined;
    }

    return this.installRun(persisted, callbacks);
  }

  private installRun(
    meta: ThreadRunRecord,
    callbacks: RuntimeCallbacks,
  ): ActiveRun {
    const now = Date.now();
    const run: ActiveRun = {
      threadId: meta.threadId,
      sessionKey: meta.sessionKey,
      sessionId: meta.sessionId,
      startedAtMs: meta.startedAtMs,
      updatedAtMs: meta.updatedAtMs,
      lastProgressAtMs: now,
      runOriginAtMs: meta.startedAtMs,
      callbacks,
      status: meta.status,
      finalizing: false,
      meta,
      publicTask: buildPublicTaskFromMeta(meta),
      emittedStages: new Set(),
      loadedSkills: new Set(),
      lastProgressSummary: "Restored active run.",
      lastDiagnosticAtMs: 0,
      recoveryAttempts: 0,
      lastMessageSyncAtMs: 0,
      currentModel: this.config.providers.opencode?.model,
    };

    this.activeRuns.set(meta.threadId, run);
    this.sessionToThread.set(meta.sessionId, meta.threadId);
    return run;
  }

  private removeRun(threadId: string): void {
    const run = this.activeRuns.get(threadId);
    if (!run) return;
    this.sessionToThread.delete(run.sessionId);
    this.activeRuns.delete(threadId);
  }

  private updateRunState(
    run: ActiveRun,
    status: ThreadRunStatus,
    lastError = "",
  ): void {
    run.status = status;
    run.updatedAtMs = Date.now();
    run.meta = {
      ...run.meta,
      status,
      lastError,
      updatedAtMs: run.updatedAtMs,
    };
    upsertThreadRun(run.meta);
  }

  private noteProgress(
    run: ActiveRun,
    summary: string,
    options?: { preserveWebAccessMarker?: boolean },
  ): void {
    run.lastProgressAtMs = Date.now();
    run.lastProgressSummary = summary;
    if (!options?.preserveWebAccessMarker) {
      run.webAccessLoadedAtMs = undefined;
    }
  }

  private ensureBackgroundLoops(): void {
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollActiveRuns();
      }, POLL_INTERVAL_MS);
    }

    if (!this.streamWatchdog) {
      this.streamWatchdog = setInterval(() => {
        if (this.activeRuns.size === 0) return;
        if (Date.now() - this.lastEventAt < STREAM_IDLE_TIMEOUT_MS) return;
        console.warn("[opencode-runtime] event stream idle; reconnecting");
        this.streamAbort?.abort();
      }, 5000);
    }

    if (!this.streamLoopStarted) {
      this.streamLoopStarted = true;
      void this.streamLoop();
    }
  }

  private async streamLoop(): Promise<void> {
    while (true) {
      const controller = new AbortController();
      this.streamAbort = controller;

      try {
        const stream = await this.client.event.subscribe(undefined, {
          signal: controller.signal,
        });

        // Reset on reconnect — otherwise the watchdog aborts again on its next 5s tick.
        this.lastEventAt = Date.now();

        for await (const rawEvent of stream.stream) {
          this.lastEventAt = Date.now();
          await this.handleEvent(rawEvent as unknown as StreamEventPayload);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          continue;
        }
        console.error("[opencode-runtime] event stream failed", error);
      }

      await sleep(1000);
    }
  }

  private async handleEvent(event: StreamEventPayload): Promise<void> {
    if (event.type === "permission.asked") {
      await this.handlePermissionEvent(
        event.properties as unknown as PermissionRequest,
      );
      return;
    }

    if (event.type === "question.asked") {
      await this.handleQuestionEvent(
        event.properties as unknown as {
          id: string;
          sessionID: string;
          tool?: { messageID?: string };
          questions: QuestionInfo[];
        },
      );
      return;
    }

    if (event.type === "message.updated") {
      const props = event.properties as { sessionID: string; info: Message };
      if (props.info.role !== "assistant") return;
      const run = this.getRunForSession(props.sessionID);
      if (!run) {
        this.observeExternalSessionActivity(props.sessionID);
        return;
      }
      this.trackAssistant(run, props.info as AssistantMessage);
      this.trackAssistantShell(run, props.info as AssistantMessage);
      if (isTerminalAssistantMessage(props.info as AssistantMessage)) {
        this.noteProgress(run, "Assistant message updated.");
      }
      await this.maybeFinalizeAssistant(run, props.info as AssistantMessage);
      return;
    }

    if (event.type === "message.part.updated") {
      const props = event.properties as { sessionID: string; part: Part };
      const run = this.getRunForSession(props.sessionID);
      if (run) {
        run.lastPartMessageId = props.part.messageID;
        run.lastPartFingerprint = getPartFingerprint(props.part);
        if (run.pendingAssistantShellMessageId === props.part.messageID) {
          this.clearPendingAssistantShell(run);
        }
        this.noteProgress(run, `Message part updated: ${props.part.type}.`);
      }
      this.logProgressPart(
        run,
        props.part as unknown as ToolPartEvent | TextPartEvent,
      );
      if (!run) {
        this.observeExternalSessionActivity(props.sessionID);
        this.maybeEmitObservedToolStage(
          props.sessionID,
          props.part as unknown as ToolPartEvent | TextPartEvent,
        );
      }
      return;
    }

    if (event.type === "session.idle") {
      const props = event.properties as { sessionID?: string };
      if (!props.sessionID || this.getRunForSession(props.sessionID)) return;
      this.completeObservedExternalSession(props.sessionID);
      return;
    }

    if (event.type === "session.error") {
      const props = event.properties as { sessionID?: string; error?: unknown };
      if (!props.sessionID) return;
      const run = this.getRunForSession(props.sessionID);
      if (!run) {
        this.failObservedExternalSession(
          props.sessionID,
          extractErrorMessage(props.error),
        );
        return;
      }
      await this.failRun(run.threadId, extractErrorMessage(props.error));
    }
  }

  private async handlePermissionEvent(
    permission: PermissionRequest,
  ): Promise<void> {
    const run = this.getRunForSession(permission.sessionID);
    if (!run) {
      this.observeExternalSessionWaiting(permission.sessionID, "permission");
      return;
    }
    const threadId = run.threadId;

    const request: RuntimePermissionRequest = {
      threadId,
      sessionId: permission.sessionID,
      permissionId: permission.id,
      messageId:
        permission.tool?.messageID || run.latestAssistantMessageId || "",
      title: buildPermissionTitle(permission),
      type: permission.permission,
      pattern: permission.patterns.join(", "),
    };

    upsertPendingPermission(request);
    this.noteProgress(run, `Permission requested: ${request.title}.`);
    this.updateRunState(run, "waiting_permission");
    this.publicActivity.emit({
      type: "task_waiting",
      task: run.publicTask,
      reason: "permission",
    });
    await run.callbacks.onPermission(request);
  }

  private async handleQuestionEvent(event: {
    id: string;
    sessionID: string;
    tool?: { messageID?: string };
    questions: QuestionInfo[];
  }): Promise<void> {
    const run = this.getRunForSession(event.sessionID);
    if (!run) {
      this.observeExternalSessionWaiting(event.sessionID, "question");
      return;
    }
    const threadId = run.threadId;

    const request: RuntimeQuestionRequest = {
      threadId,
      sessionId: event.sessionID,
      questionId: event.id,
      messageId: event.tool?.messageID || run.latestAssistantMessageId || "",
      questions: event.questions.map((item) => ({
        question: item.question,
        header: item.header,
        options: item.options,
        multiple: item.multiple,
        custom: item.custom,
      })),
    };

    const persisted: PendingQuestionRecord = {
      threadId,
      sessionId: request.sessionId,
      questionId: request.questionId,
      messageId: request.messageId,
      questions: request.questions,
    };

    upsertPendingQuestion(persisted);
    this.noteProgress(run, "Follow-up question requested.");
    this.updateRunState(run, "waiting_question");
    this.publicActivity.emit({
      type: "task_waiting",
      task: run.publicTask,
      reason: "question",
    });
    await run.callbacks.onQuestion(request);
  }

  private async pollActiveRuns(): Promise<void> {
    if (this.activeRuns.size === 0) return;

    const statusMap = await this.unwrap<
      Record<string, { type: string; attempt?: number }>
    >(this.client.session.status()).catch((error) => {
      console.error("[opencode-runtime] status poll failed", error);
      return undefined;
    });

    const now = Date.now();
    for (const run of this.activeRuns.values()) {
      // Skip timeout while waiting on the user — human approval routinely exceeds IDLE_TIMEOUT_MS.
      if (
        run.status === "waiting_permission" ||
        run.status === "waiting_question"
      ) {
        continue;
      }

      const sessionEntry = statusMap?.[run.sessionId];
      const sessionStatus = sessionEntry?.type;
      const sessionRetryAttempt = sessionEntry?.attempt ?? 0;
      this.maybeLogDiagnostic(run, now, sessionStatus);

      if (shouldSyncBusyMessages(run, now, sessionStatus)) {
        const completed = await this.syncMessages(run);
        if (completed) {
          continue;
        }
      }

      if (shouldRecoverAssistantShell(run, now, sessionStatus)) {
        await this.recoverRunFromStall(
          run,
          buildAssistantShellStallMessage(run, sessionStatus),
        );
        continue;
      }

      if (shouldFailWebAccessHandoff(run, now)) {
        await this.recoverRunFromStall(
          run,
          buildWebAccessHandoffMessage(run, sessionStatus),
        );
        continue;
      }

      if (now - run.lastProgressAtMs > IDLE_TIMEOUT_MS) {
        await this.failRun(
          run.threadId,
          buildIdleTimeoutMessage(run, sessionStatus),
        );
        continue;
      }

      if (now - run.runOriginAtMs > HARD_TIMEOUT_MS) {
        await this.failRun(
          run.threadId,
          `OpenCode run exceeded hard ceiling of ${HARD_TIMEOUT_MS / 60000} minutes`,
        );
        continue;
      }

      if (
        sessionStatus === "retry" &&
        sessionRetryAttempt >= 1 &&
        !run.usedFallbackModel &&
        this.config.providers.opencode?.fallbackModel
      ) {
        await this.switchToFallbackModel(run);
        continue;
      }

      if (sessionStatus === "busy") {
        continue;
      }

      await this.checkMessages(run);
    }
  }

  private async syncMessages(run: ActiveRun): Promise<boolean> {
    run.lastMessageSyncAtMs = Date.now();
    const messages = await this.unwrap<Array<{ info: Message; parts: Part[] }>>(
      this.client.session.messages({ sessionID: run.sessionId }),
    ).catch((error) => {
      void this.handleRecoverableRunError(run, error);
      return undefined;
    });

    if (!messages) return false;

    const latest = findLatestCompletedAssistantMessage(
      messages,
      run.startedAtMs,
    );
    if (latest) {
      this.noteProgress(
        run,
        "Recovered terminal assistant message from message sync.",
      );
      this.trackAssistant(run, latest.info);
      this.clearPendingAssistantShell(run);
      await this.completeRun(
        run,
        collectMessageText(latest.parts),
        latest.info.error,
        latest.info,
      );
      return true;
    }

    const latestAssistant = findLatestAssistantMessage(
      messages,
      run.startedAtMs,
    );
    if (latestAssistant) {
      const previousAssistantId = run.latestAssistantMessageId;
      this.trackAssistant(run, latestAssistant.info);
      this.trackAssistantShell(run, latestAssistant.info);
      if (
        latestAssistant.parts.length > 0 &&
        run.pendingAssistantShellMessageId === latestAssistant.info.id
      ) {
        this.clearPendingAssistantShell(run);
      }
      if (latestAssistant.info.id !== previousAssistantId) {
        this.noteProgress(
          run,
          "Recovered assistant progress from message sync.",
        );
      }
    }

    const latestPart = findLatestAssistantPart(messages, run.startedAtMs);
    if (!latestPart) return false;

    const fingerprint = getPartFingerprint(latestPart);
    if (fingerprint === run.lastPartFingerprint) {
      return false;
    }

    run.lastPartFingerprint = fingerprint;
    run.lastPartMessageId = latestPart.messageID;
    if (run.pendingAssistantShellMessageId === latestPart.messageID) {
      this.clearPendingAssistantShell(run);
    }
    this.noteProgress(
      run,
      `Recovered progress from message sync: ${latestPart.type}.`,
    );
    this.logProgressPart(
      run,
      latestPart as unknown as ToolPartEvent | TextPartEvent,
    );
    return false;
  }

  private async checkMessages(run: ActiveRun): Promise<void> {
    const messages = await this.unwrap<Array<{ info: Message; parts: Part[] }>>(
      this.client.session.messages({ sessionID: run.sessionId }),
    ).catch((error) => {
      void this.handleRecoverableRunError(run, error);
      return undefined;
    });

    if (!messages) return;

    const latest = findLatestCompletedAssistantMessage(
      messages,
      run.startedAtMs,
    );
    if (!latest) return;

    this.noteProgress(run, "Terminal assistant message detected.");
    this.trackAssistant(run, latest.info);
    await this.completeRun(
      run,
      collectMessageText(latest.parts),
      latest.info.error,
      latest.info,
    );
  }

  private trackAssistant(run: ActiveRun, info: AssistantMessage): void {
    this.maybeLogUsedModel(run, info);
    const createdAt = info.time.created;
    if (
      run.latestAssistantCreatedAt === undefined ||
      createdAt >= run.latestAssistantCreatedAt
    ) {
      run.latestAssistantCreatedAt = createdAt;
      run.latestAssistantMessageId = info.id;
    }
  }

  private async maybeFinalizeAssistant(
    run: ActiveRun,
    info: AssistantMessage,
  ): Promise<void> {
    if (!isTerminalAssistantMessage(info)) return;
    const response = await this.unwrap<{ info: Message; parts: Part[] }>(
      this.client.session.message({
        sessionID: run.sessionId,
        messageID: info.id,
      }),
    ).catch((error) => {
      void this.handleRecoverableRunError(run, error);
      return undefined;
    });

    if (!response || response.info.role !== "assistant") return;
    this.maybeLogUsedModel(run, response.info);
    this.noteProgress(run, "Assistant produced terminal response.");
    this.clearPendingAssistantShell(run);
    await this.completeRun(
      run,
      collectMessageText(response.parts),
      response.info.error,
      response.info as AssistantMessage,
    );
  }

  private async completeRun(
    run: ActiveRun,
    text: string,
    error?: unknown,
    info?: AssistantMessage,
  ): Promise<void> {
    if (run.finalizing) return;
    run.finalizing = true;

    const isError = Boolean(error);
    const errorMessage = error ? extractErrorMessage(error) : "";
    let finalText = text.trim() || "No response text returned.";

    if (!isError && info) {
      const footer = await this.buildContextUsageFooter(info);
      if (footer) {
        finalText = `${finalText}\n\n—\n${footer}`;
      }
    }

    try {
      if (isError) {
        await run.callbacks.onFailed(errorMessage);
      } else {
        await run.callbacks.onComplete(finalText);
      }
    } catch (callbackErr) {
      // Leave the run in activeRuns so the poll loop retries delivery.
      // Re-enter is gated on the next checkMessages tick finding the same terminal message.
      run.finalizing = false;
      console.error(
        `[opencode-runtime] terminal callback failed for thread ${run.threadId}; will retry`,
        callbackErr,
      );
      return;
    }

    clearPendingPermission(run.threadId);
    clearPendingQuestion(run.threadId);
    this.updateRunState(run, isError ? "failed" : "completed", errorMessage);
    console.log(
      `[opencode-runtime] finalized thread=${run.threadId} status=${isError ? "failed" : "completed"} lastProgress="${run.lastProgressSummary}"`,
    );
    if (isError) {
      this.publicActivity.emit({
        type: "task_failed",
        task: run.publicTask,
        error: errorMessage,
      });
    } else {
      this.publicActivity.emit({
        type: "task_completed",
        task: run.publicTask,
        durationMs: Date.now() - run.runOriginAtMs,
      });
    }
    this.removeRun(run.threadId);
    if (run.publicTask.source !== "scheduler") {
      this.publicActivity.setIdleIfNoActiveRuns();
    }
    await run.callbacks.onTerminal();
  }

  // Render a one-line context-usage footer for the reply email from the terminal
  // assistant message's token counts. input + cache.read + cache.write + output is
  // everything that occupies the context window going into the next turn.
  private async buildContextUsageFooter(
    info: AssistantMessage,
  ): Promise<string> {
    const tokens = info.tokens;
    if (!tokens) return "";
    const used =
      tokens.input + tokens.output + tokens.cache.read + tokens.cache.write;
    if (used <= 0) return "";

    const limit = await this.getModelContextLimit(
      info.providerID,
      info.modelID,
    );
    if (limit && limit > 0) {
      const pct = Math.round((used / limit) * 100);
      return `Context: ${formatTokenCount(used)} / ${formatTokenCount(limit)} tokens (${pct}%)`;
    }
    return `Context: ${formatTokenCount(used)} tokens`;
  }

  private async getModelContextLimit(
    providerID: string,
    modelID: string,
  ): Promise<number | undefined> {
    const key = `${providerID}/${modelID}`;
    const cached = this.modelContextLimits.get(key);
    if (cached !== undefined) return cached;
    if (this.modelContextLimitsLoaded) return undefined;

    this.modelContextLimitsLoaded = true;
    try {
      const result = await this.unwrap<{
        providers: Array<{
          id: string;
          models: Record<string, { limit?: { context?: number } }>;
        }>;
      }>(this.client.config.providers());
      for (const provider of result.providers) {
        for (const [id, model] of Object.entries(provider.models)) {
          const context = model.limit?.context;
          if (typeof context === "number" && context > 0) {
            this.modelContextLimits.set(`${provider.id}/${id}`, context);
          }
        }
      }
    } catch (error) {
      // Fall back to the bare token count if provider metadata is unavailable.
      this.modelContextLimitsLoaded = false;
      console.error(
        "[opencode-runtime] failed to load model context limits",
        error,
      );
    }
    return this.modelContextLimits.get(key);
  }

  private maybeLogUsedModel(run: ActiveRun, source: unknown): void {
    const usedModel = extractUsedModel(source);
    if (!usedModel || usedModel === run.loggedModel) return;
    run.loggedModel = usedModel;
    console.log(
      `[opencode-runtime] model used thread=${run.threadId} ${usedModel}`,
    );
  }

  private maybeEmitToolStage(
    run: ActiveRun,
    part: ToolPartEvent,
    label: string,
  ): void {
    const skillName = extractLoadedSkillName(label);
    if (skillName && !run.loadedSkills.has(skillName)) {
      run.loadedSkills.add(skillName);
      this.publicActivity.emit({
        type: "skill_loaded",
        task: run.publicTask,
        skillName,
      });
      if (skillName === "llm-wiki") {
        this.emitStageOnce(run, "knowledge_update_started");
      }
    }

    if (
      part.tool === "webfetch" &&
      (part.state?.status === "running" || part.state?.status === "completed")
    ) {
      this.emitStageOnce(run, "web_data_started");
    }
  }

  private maybeEmitCommentaryStages(run: ActiveRun, text: string): void {
    if (matchesAny(text, RESEARCH_PATTERNS)) {
      this.emitStageOnce(run, "research_started");
    }
    if (matchesAny(text, DRAFT_PATTERNS)) {
      this.emitStageOnce(run, "draft_started");
    }
    if (matchesAny(text, KNOWLEDGE_PATTERNS)) {
      this.emitStageOnce(run, "knowledge_update_started");
    }
  }

  private emitStageOnce(
    run: ActiveRun,
    stage:
      | "research_started"
      | "web_data_started"
      | "draft_started"
      | "knowledge_update_started",
  ): void {
    if (run.emittedStages.has(stage)) return;
    run.emittedStages.add(stage);
    this.publicActivity.emit({ type: stage, task: run.publicTask });
  }

  private async failRun(threadId: string, message: string): Promise<void> {
    const run = this.activeRuns.get(threadId);
    if (!run) return;
    await this.completeRun(run, "", new Error(message));
  }

  private async recoverRunFromStall(
    run: ActiveRun,
    reason: string,
  ): Promise<void> {
    if (run.recoveryAttempts >= MAX_STALL_RECOVERY_ATTEMPTS) {
      await this.failRun(
        run.threadId,
        `${reason} Automatic recovery was already attempted and did not resolve the run.`,
      );
      return;
    }

    run.recoveryAttempts += 1;
    console.warn(
      `[opencode-runtime] recovering stalled run thread=${run.threadId} attempt=${run.recoveryAttempts} reason="${reason}"`,
    );

    const previousSessionId = run.sessionId;
    this.sessionToThread.delete(previousSessionId);

    try {
      await this.ensureSuccess(
        this.client.session.abort({
          sessionID: previousSessionId,
        }),
      ).catch(() => undefined);

      await this.sessionManager.invalidateSession(run.sessionKey);
      const sessionId = await this.sessionManager.getOrCreateSessionId({
        channel: run.meta.sourceChannel,
        sessionKey: run.sessionKey,
        sessionTitle: run.meta.sessionTitle,
      });

      const now = Date.now();
      run.sessionId = sessionId;
      run.startedAtMs = now;
      run.updatedAtMs = now;
      run.lastProgressAtMs = now;
      run.meta = {
        ...run.meta,
        sessionId,
        startedAtMs: now,
        updatedAtMs: now,
        lastError: "",
      };
      run.latestAssistantMessageId = undefined;
      run.latestAssistantCreatedAt = undefined;
      run.lastPartMessageId = undefined;
      run.lastPartFingerprint = undefined;
      run.lastMessageSyncAtMs = 0;
      run.webAccessLoadedAtMs = undefined;
      this.clearPendingAssistantShell(run);
      this.sessionToThread.set(sessionId, run.threadId);
      upsertThreadRun(run.meta);
      this.noteProgress(
        run,
        `Restarted run after stall recovery attempt ${run.recoveryAttempts}.`,
      );
      await this.launchPrompt(run, run.meta.lastUserText);
    } catch (error) {
      await this.failRun(
        run.threadId,
        `${reason} Automatic recovery failed: ${extractErrorMessage(error)}`,
      );
    }
  }

  private getRunForSession(sessionId: string): ActiveRun | undefined {
    const threadId = this.sessionToThread.get(sessionId);
    if (!threadId) return undefined;
    const run = this.activeRuns.get(threadId);
    if (!run) return undefined;
    if (run.sessionId !== sessionId) {
      return undefined;
    }
    return run;
  }

  private async handleRecoverableRunError(
    run: ActiveRun,
    error: unknown,
  ): Promise<void> {
    if (isSessionNotFound(error)) {
      await this.sessionManager.invalidateSession(run.sessionKey);
    }

    const fallback = this.config.providers.opencode?.fallbackModel;
    if (isRateLimit(error) && fallback && !run.usedFallbackModel) {
      run.usedFallbackModel = true;
      run.currentModel = fallback;
      const primary =
        formatConfiguredModel(this.config.providers.opencode?.model) ??
        "default";
      const fallbackStr = formatConfiguredModel(fallback)!;
      console.warn(
        `[opencode-runtime] rate-limited on ${primary}, switching to fallback ${fallbackStr} thread=${run.threadId}`,
      );
      this.noteProgress(
        run,
        `Primary model rate-limited. Retrying with fallback model ${fallbackStr}.`,
      );
      await this.launchPrompt(run, run.meta.lastUserText);
      return;
    }

    await this.failRun(run.threadId, extractErrorMessage(error));
  }

  private async switchToFallbackModel(run: ActiveRun): Promise<void> {
    const fallback = this.config.providers.opencode?.fallbackModel!;
    run.usedFallbackModel = true;
    run.currentModel = fallback;
    const primary =
      formatConfiguredModel(this.config.providers.opencode?.model) ?? "default";
    const fallbackStr = formatConfiguredModel(fallback)!;
    console.warn(
      `[opencode-runtime] session retry attempt >= 1 on ${primary}, aborting and switching to fallback ${fallbackStr} thread=${run.threadId}`,
    );
    this.noteProgress(
      run,
      `Primary model rate-limited. Switching to fallback model ${fallbackStr}.`,
    );
    try {
      await this.ensureSuccess(
        this.client.session.abort({ sessionID: run.sessionId }),
      ).catch(() => undefined);
      await this.sessionManager.invalidateSession(run.sessionKey);
      const sessionId = await this.sessionManager.getOrCreateSessionId({
        channel: run.meta.sourceChannel,
        sessionKey: run.sessionKey,
        sessionTitle: run.meta.sessionTitle,
      });
      const now = Date.now();
      this.sessionToThread.delete(run.sessionId);
      run.sessionId = sessionId;
      run.startedAtMs = now;
      run.updatedAtMs = now;
      run.lastProgressAtMs = now;
      run.lastMessageSyncAtMs = 0;
      run.latestAssistantMessageId = undefined;
      run.latestAssistantCreatedAt = undefined;
      run.lastPartMessageId = undefined;
      run.lastPartFingerprint = undefined;
      run.meta = {
        ...run.meta,
        sessionId,
        startedAtMs: now,
        updatedAtMs: now,
        lastError: "",
      };
      this.clearPendingAssistantShell(run);
      this.sessionToThread.set(sessionId, run.threadId);
      upsertThreadRun(run.meta);
      await this.launchPrompt(run, run.meta.lastUserText);
    } catch (error) {
      await this.failRun(
        run.threadId,
        `Fallback model switch failed: ${extractErrorMessage(error)}`,
      );
    }
  }

  private async requireRun(
    threadId: string,
    callbacks: RuntimeCallbacks,
  ): Promise<ActiveRun> {
    const run =
      this.activeRuns.get(threadId) ||
      this.restoreActiveRun(threadId, callbacks);
    if (!run) {
      throw new Error(`No active run for thread ${threadId}`);
    }
    run.callbacks = callbacks;
    this.ensureBackgroundLoops();
    return run;
  }

  private trackAssistantShell(run: ActiveRun, info: AssistantMessage): void {
    if (isTerminalAssistantMessage(info)) {
      this.clearPendingAssistantShell(run);
      return;
    }

    if (run.pendingAssistantShellMessageId === info.id) {
      return;
    }

    run.pendingAssistantShellMessageId = info.id;
    run.pendingAssistantShellCreatedAtMs = info.time.created;
  }

  private clearPendingAssistantShell(run: ActiveRun): void {
    run.pendingAssistantShellMessageId = undefined;
    run.pendingAssistantShellCreatedAtMs = undefined;
  }

  private async getFreshSessionId(request: GmailRunRequest): Promise<string> {
    try {
      return await this.sessionManager.getOrCreateSessionId({
        channel: request.sourceChannel,
        sessionKey: request.sessionKey,
        sessionTitle: request.sessionTitle,
      });
    } catch (error) {
      if (!isSessionNotFound(error)) throw error;
      await this.sessionManager.invalidateSession(request.sessionKey);
      return this.sessionManager.getOrCreateSessionId({
        channel: request.sourceChannel,
        sessionKey: request.sessionKey,
        sessionTitle: request.sessionTitle,
      });
    }
  }

  private logProgressPart(
    run: ActiveRun | undefined,
    part: ToolPartEvent | TextPartEvent,
  ): void {
    if (part.type === "tool") {
      const label = part.state?.title?.trim() || part.tool;
      const state = part.state?.status;
      if (run && state) {
        const summary = `Tool ${state}: ${label}`;
        const skillName = extractLoadedSkillName(label);
        if (skillName === "web-access" && state === "completed") {
          run.webAccessLoadedAtMs = Date.now();
          this.noteProgress(run, summary, { preserveWebAccessMarker: true });
        } else {
          this.noteProgress(run, summary);
        }
      }
      if (state === "running") {
        console.log(`[opencode] tool running: ${label}`);
      } else if (state === "completed") {
        console.log(`[opencode] tool completed: ${label}`);
      } else if (state === "error") {
        console.log(
          `[opencode] tool failed: ${label}${part.state?.error ? ` - ${part.state.error}` : ""}`,
        );
      }
      if (run) {
        this.maybeEmitToolStage(run, part, label);
      }
      return;
    }

    if (part.metadata?.openai?.phase !== "commentary") return;
    const text = part.text.trim();
    if (!text) return;
    if (run) {
      this.noteProgress(run, `Commentary: ${truncateForLog(text, 120)}`);
    }
    console.log(`[opencode] ${text}`);
    if (run) {
      this.maybeEmitCommentaryStages(run, text);
    }
  }

  private maybeLogDiagnostic(
    run: ActiveRun,
    now: number,
    sessionStatus: string | undefined,
  ): void {
    const idleForMs = now - run.lastProgressAtMs;
    if (idleForMs < DIAGNOSTIC_LOG_INTERVAL_MS) return;
    if (now - run.lastDiagnosticAtMs < DIAGNOSTIC_LOG_INTERVAL_MS) return;
    run.lastDiagnosticAtMs = now;
    console.warn(
      `[opencode-runtime] idle diagnostic thread=${run.threadId} session=${run.sessionId} idleFor=${formatDuration(idleForMs)} sessionStatus=${sessionStatus || "unknown"} lastProgress="${run.lastProgressSummary}"`,
    );
  }

  private async unwrap<T>(
    promise: Promise<{ data?: T; error?: unknown }>,
  ): Promise<T> {
    const result = await this.ensureSuccess(promise);
    if (result.data === undefined) {
      throw new Error("OpenCode request returned no data");
    }
    return result.data;
  }

  private async ensureSuccess<T>(
    promise: Promise<{ data?: T; error?: unknown }>,
  ): Promise<{
    data?: T;
    error?: unknown;
  }> {
    const result = await promise;
    if (result.error) {
      throw new Error(extractErrorMessage(result.error));
    }
    return result;
  }

  private observeExternalSessionActivity(sessionId: string): void {
    this.ensureObservedExternalSession(sessionId);
  }

  private observeExternalSessionWaiting(
    sessionId: string,
    reason: "permission" | "question",
  ): void {
    const observed = this.ensureObservedExternalSession(sessionId);
    this.publicActivity.emit({
      type: "task_waiting",
      task: observed.task,
      reason,
    });
  }

  private maybeEmitObservedToolStage(
    sessionId: string,
    part: ToolPartEvent | TextPartEvent,
  ): void {
    if (part.type !== "tool") return;
    const label = part.state?.title?.trim() || part.tool;
    const skillName = extractLoadedSkillName(label);
    if (!skillName) return;

    const observed = this.ensureObservedExternalSession(sessionId);
    if (observed.loadedSkills.has(skillName)) return;
    observed.loadedSkills.add(skillName);
    this.publicActivity.emit({
      type: "skill_loaded",
      task: observed.task,
      skillName,
    });
  }

  private ensureObservedExternalSession(
    sessionId: string,
  ): ObservedExternalSession {
    const existing = this.observedExternalSessions.get(sessionId);
    if (existing) return existing;

    const observed: ObservedExternalSession = {
      task: buildPublicTaskContext({
        activityKey: `session:${sessionId}`,
        source: "session",
      }),
      startedAtMs: Date.now(),
      loadedSkills: new Set(),
    };
    this.observedExternalSessions.set(sessionId, observed);
    this.publicActivity.emit({ type: "task_started", task: observed.task });
    return observed;
  }

  private completeObservedExternalSession(sessionId: string): void {
    const observed = this.observedExternalSessions.get(sessionId);
    if (!observed) return;
    this.observedExternalSessions.delete(sessionId);
    this.publicActivity.emit({
      type: "task_completed",
      task: observed.task,
      durationMs: Date.now() - observed.startedAtMs,
    });
    this.publicActivity.setIdleIfNoActiveRuns();
  }

  private failObservedExternalSession(sessionId: string, error: string): void {
    const observed = this.observedExternalSessions.get(sessionId);
    if (!observed) return;
    this.observedExternalSessions.delete(sessionId);
    this.publicActivity.emit({
      type: "task_failed",
      task: observed.task,
      error,
    });
    this.publicActivity.setIdleIfNoActiveRuns();
  }
}

function buildImageFileParts(images?: RunImageInput[]): FilePartInput[] {
  if (!images?.length) return [];
  return images
    .filter((image): image is RunImageInput & { url: string } =>
      Boolean(image.url),
    )
    .map((image) => ({
      type: "file",
      mime: image.mime,
      filename: image.filename,
      url: image.url,
    }));
}

function collectMessageText(parts: Part[]): string {
  return parts
    .filter(
      (part): part is Extract<Part, { type: "text" }> =>
        part.type === "text" && typeof part.text === "string" && !part.ignored,
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

function findLatestCompletedAssistantMessage(
  messages: Array<{ info: Message; parts: Part[] }>,
  startedAtMs: number,
): { info: AssistantMessage; parts: Part[] } | undefined {
  const candidates = messages.filter((entry) => {
    if (entry.info.role !== "assistant") return false;
    if (entry.info.time.created < startedAtMs) return false;
    return isTerminalAssistantMessage(entry.info);
  }) as Array<{ info: AssistantMessage; parts: Part[] }>;

  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => {
    const aTime = a.info.time.completed || a.info.time.created;
    const bTime = b.info.time.completed || b.info.time.created;
    return bTime - aTime;
  })[0];
}

function findLatestAssistantMessage(
  messages: Array<{ info: Message; parts: Part[] }>,
  startedAtMs: number,
): { info: AssistantMessage; parts: Part[] } | undefined {
  const candidates = messages.filter((entry) => {
    if (entry.info.role !== "assistant") return false;
    return entry.info.time.created >= startedAtMs;
  }) as Array<{ info: AssistantMessage; parts: Part[] }>;

  if (candidates.length === 0) return undefined;

  return candidates.sort((a, b) => {
    const aTime = a.info.time.completed || a.info.time.created;
    const bTime = b.info.time.completed || b.info.time.created;
    return bTime - aTime;
  })[0];
}

function findLatestAssistantPart(
  messages: Array<{ info: Message; parts: Part[] }>,
  startedAtMs: number,
): Part | undefined {
  const assistantParts = messages.flatMap((entry) => {
    if (entry.info.role !== "assistant") return [];
    if (entry.info.time.created < startedAtMs) return [];
    return entry.parts;
  });

  if (assistantParts.length === 0) return undefined;

  return assistantParts.sort(
    (a, b) => getPartTimestamp(b) - getPartTimestamp(a),
  )[0];
}

function getPartTimestamp(part: Part): number {
  const withTime = part as Part & {
    time?: {
      updated?: number;
      created?: number;
    };
  };
  return withTime.time?.updated || withTime.time?.created || 0;
}

function getPartFingerprint(part: Part): string {
  const withId = part as Part & { id?: string };
  if (typeof withId.id === "string" && withId.id.trim()) {
    return withId.id;
  }
  return `${part.messageID}:${part.type}:${getPartTimestamp(part)}`;
}

function buildPermissionTitle(permission: PermissionRequest): string {
  const metadataTitle = permission.metadata?.title;
  return typeof metadataTitle === "string" && metadataTitle.trim()
    ? metadataTitle.trim()
    : permission.permission;
}

// AI SDK finish reasons that mean "this turn is done; don't expect more."
// "tool-calls" means the model wants another turn after tool results — not terminal.
// Anything outside this set (e.g. a future reason we don't recognize) falls through
// to the run timeout rather than risk a premature finalize.
const TERMINAL_FINISH_REASONS = new Set([
  "stop",
  "length",
  "content-filter",
  "error",
  "other",
  "unknown",
]);

const RESEARCH_PATTERNS = [
  /research/i,
  /source/i,
  /news/i,
  /抓取/,
  /候选文章/,
  /补抓/,
  /锁定/,
];

const DRAFT_PATTERNS = [
  /draft/i,
  /writing/i,
  /compose/i,
  /generate/i,
  /生成/,
  /撰写/,
  /整理/,
  /简报/,
];

const KNOWLEDGE_PATTERNS = [
  /wiki/i,
  /knowledge/i,
  /ingest/i,
  /query/i,
  /lint/i,
  /知识/,
  /维基/,
];

function isTerminalAssistantMessage(info: AssistantMessage): boolean {
  if (info.error) return true;
  if (!info.time.completed) return false;
  return info.finish !== undefined && TERMINAL_FINISH_REASONS.has(info.finish);
}

// Build the text dispatched to the model from an inbound request. Email subject
// lines frequently hold the real task, so the subject is kept as content — but as
// a plain leading line, NOT a `Subject:` envelope label. The label made the
// memory extractor read durable user facts as email/task artifacts and silently
// drop them (the agent only ever talks over Gmail, so every turn carried it);
// stripping it here keeps the envelope out of the session entirely, for both the
// answering model and extraction. Quoted replies are already removed upstream by
// stripQuotedReply (gmail.ts), so the subject is the last remaining envelope.
// Scheduled tasks already carry a fully self-contained prompt in textBody and a
// short label as their subject, so they are passed through untouched.
function composeRunPrompt(request: GmailRunRequest): string {
  if (request.threadId.startsWith("scheduled-task:")) {
    return request.textBody;
  }
  const body = request.textBody?.trim() ?? "";
  // Drop reply/forward prefixes and the placeholder used for missing subjects so
  // they don't become noise at the top of the prompt.
  let subject = (request.subject?.trim() ?? "")
    .replace(/^(re|fwd|fw)\s*:\s*/i, "")
    .trim();
  if (subject.toLowerCase() === "(no subject)") subject = "";
  if (!subject) return body;
  if (!body) return subject;
  // Avoid repeating the subject when the body already leads with it.
  if (body.toLowerCase().startsWith(subject.toLowerCase())) return body;
  return `${subject}\n\n${body}`;
}

function buildPublicTaskFromMeta(meta: ThreadRunRecord): PublicTaskContext {
  return buildPublicTaskContext({
    activityKey: meta.threadId.startsWith("scheduled-task:")
      ? `scheduled:${meta.sessionKey}`
      : `${meta.sourceChannel}:${meta.threadId}`,
    source: meta.threadId.startsWith("scheduled-task:")
      ? "scheduler"
      : meta.sourceChannel === "telegram"
        ? "telegram"
        : "gmail",
    subject: meta.subject,
    textBody: meta.lastUserText,
  });
}

function isSessionNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Session not found");
}

function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const r = err as Record<string, unknown>;
  // SDK ApiError shape: { statusCode: number, isRetryable: boolean }
  if (r.statusCode === 429) return true;
  // Also catch rate-limit messages from stringified errors
  const msg = typeof r.message === "string" ? r.message : "";
  return /rate.?limit|429|too many requests/i.test(msg);
}

function extractErrorMessage(error: unknown): string {
  if (!error) return "OpenCode request failed";
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    const data = record.data;
    if (typeof data === "object" && data !== null) {
      const dataRecord = data as Record<string, unknown>;
      if (typeof dataRecord.message === "string") return dataRecord.message;
    }
  }
  return "OpenCode request failed";
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function shouldFailWebAccessHandoff(run: ActiveRun, now: number): boolean {
  if (!run.webAccessLoadedAtMs) return false;
  return now - run.webAccessLoadedAtMs > WEB_ACCESS_HANDOFF_TIMEOUT_MS;
}

function shouldRecoverAssistantShell(
  run: ActiveRun,
  now: number,
  sessionStatus: string | undefined,
): boolean {
  if (sessionStatus !== "busy") return false;
  if (
    !run.pendingAssistantShellMessageId ||
    !run.pendingAssistantShellCreatedAtMs
  ) {
    return false;
  }
  if (run.lastPartMessageId === run.pendingAssistantShellMessageId) {
    return false;
  }
  return (
    now - run.pendingAssistantShellCreatedAtMs >
    ASSISTANT_SHELL_STALL_TIMEOUT_MS
  );
}

function shouldSyncBusyMessages(
  run: ActiveRun,
  now: number,
  sessionStatus: string | undefined,
): boolean {
  if (sessionStatus !== "busy") return false;
  if (now - run.lastProgressAtMs < BUSY_MESSAGE_SYNC_INTERVAL_MS) return false;
  return now - run.lastMessageSyncAtMs >= BUSY_MESSAGE_SYNC_INTERVAL_MS;
}

function buildAssistantShellStallMessage(
  run: ActiveRun,
  sessionStatus: string | undefined,
): string {
  const shellAgeMs =
    Date.now() - (run.pendingAssistantShellCreatedAtMs || run.lastProgressAtMs);
  return [
    `OpenCode created an empty assistant message shell and produced no parts for ${formatDuration(shellAgeMs)}.`,
    `Last progress: ${run.lastProgressSummary}.`,
    `Session status: ${sessionStatus || "unknown"}.`,
    "This usually means the tool-call loop stalled between steps while the session still reported busy.",
  ].join(" ");
}

function buildWebAccessHandoffMessage(
  run: ActiveRun,
  sessionStatus: string | undefined,
): string {
  const idleForMs =
    Date.now() - (run.webAccessLoadedAtMs || run.lastProgressAtMs);
  return [
    `OpenCode stalled after loading web-access and produced no follow-up activity for ${formatDuration(idleForMs)}.`,
    `Last progress: ${run.lastProgressSummary}.`,
    `Session status: ${sessionStatus || "unknown"}.`,
    "This usually means the browser handoff never started or the model stopped before invoking it.",
  ].join(" ");
}

function buildIdleTimeoutMessage(
  run: ActiveRun,
  sessionStatus: string | undefined,
): string {
  return [
    `OpenCode run idle for over ${IDLE_TIMEOUT_MS / 60000} minutes (no new output from the model).`,
    `Last progress: ${run.lastProgressSummary}.`,
    `Session status: ${sessionStatus || "unknown"}.`,
  ].join(" ");
}

function truncateForLog(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1)}K`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function isActiveStatus(status: ThreadRunStatus): boolean {
  return (
    status === "running" ||
    status === "waiting_permission" ||
    status === "waiting_question"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatConfiguredModel(model?: {
  providerID: string;
  modelID: string;
}): string | undefined {
  const provider = model?.providerID?.trim();
  const modelID = model?.modelID?.trim();
  if (!provider || !modelID) return undefined;
  return `${provider}/${modelID}`;
}

function extractUsedModel(source: unknown): string | undefined {
  const direct = extractProviderModelPair(source);
  if (direct) return direct;

  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  return (
    extractProviderModelPair(record.info) ||
    extractProviderModelPair(record.metadata) ||
    extractProviderModelPair(record.model)
  );
}

function extractProviderModelPair(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;

  const providerID = readString(record.providerID);
  const modelID = readString(record.modelID);
  if (providerID && modelID) return `${providerID}/${modelID}`;

  const provider =
    readString(record.provider) || readNestedString(record.provider, "id");
  const model =
    readString(record.model) || readNestedString(record.model, "id");
  if (provider && model) return `${provider}/${model}`;

  return undefined;
}

function readNestedString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  return readString((source as Record<string, unknown>)[key]);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
