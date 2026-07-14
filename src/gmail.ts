import {
  clearPendingPermission,
  clearPendingQuestion,
  getLatestGmailThreadIdForCanonicalThread,
  getPendingPermission,
  getPendingQuestion,
  getThreadSessionLink,
  getThreadRun,
  incrementThreadFailures,
  isProcessed,
  listActiveThreadRuns,
  markProcessed,
  recordOutboundEmail,
  refreshClaim,
  releaseClaim,
  resetThreadFailures,
  tryClaimMessage,
  upsertThreadSessionLink,
} from "./db.js";
import type {
  PendingPermissionRecord,
  PendingQuestionRecord,
} from "./db.js";
import { AppOrchestrator } from "./app/orchestrator.js";
import type { ExecutionSlot } from "./execution-slot.js";
import {
  buildPublicTaskContext,
  type PublicEventPublisher,
  type PublicTaskContext,
} from "./public-activity.js";
import type {
  PermissionResponse,
  RuntimeCallbacks,
} from "./opencode-runtime.js";
import { SerialQueue } from "./queue.js";
import type { ScheduledResultPayload } from "./scheduler/types.js";
import type { AppConfig } from "./types.js";
import { WorkflowRunner } from "./workflow.js";
import { MailTransportUnavailableError } from "./mail/transport.js";
import type { MailTransport } from "./mail/transport.js";

interface ThreadMeta {
  gmailThreadId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  messageId: string;
}

export class GmailBridge {
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly threadMeta = new Map<string, ThreadMeta>();
  private readonly publicTasks = new Map<string, PublicTaskContext>();
  private readonly workflow: WorkflowRunner;
  private consecutiveErrors = 0;
  private userEmail = "";
  private shuttingDown = false;
  // Fire-and-forget processMessage() runs spawned from the poll loop. Tracked
  // so graceful shutdown can wait for the in-flight reply + markProcessed to
  // finish instead of being killed mid-task.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly orchestrator: AppOrchestrator,
    private readonly queue: SerialQueue,
    private readonly publicActivity: PublicEventPublisher,
    private readonly executionSlot: ExecutionSlot,
    private readonly transport: MailTransport,
  ) {
    this.workflow = new WorkflowRunner(orchestrator, queue, publicActivity);
  }

  async launch(): Promise<void> {
    let address: string;
    try {
      ({ address } = await this.transport.connect());
    } catch (error) {
      if (error instanceof MailTransportUnavailableError) {
        console.warn(`[gmail] skipping — ${error.message}`);
        return;
      }
      throw error;
    }

    this.connected = true;
    this.userEmail = address;
    console.log(`[gmail] connected as ${this.userEmail}`);

    await this.resumeActiveRuns();
    await this.pollForMessages();
    this.schedulePoll();

    console.log(
      `[gmail] polling every ${this.config.channels.gmail?.pollIntervalMs || 10000}ms; inbox=${this.getAgentInboxAddress() || "(unset)"}; user=${this.getUserAddress() || "(unset)"}`,
    );
  }

  // Stop claiming new messages without tearing down the Gmail client, so any
  // in-flight task can still send its reply and mark the message processed.
  // Full teardown happens in stop() once the drain is complete.
  beginShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log(
      `[gmail] shutdown initiated; ${this.inFlight.size} in-flight task(s) draining`,
    );
  }

  // Wait for every in-flight processMessage() run to settle (reply sent,
  // message marked processed/claim released). Re-checks because a settling run
  // could enqueue follow-on work.
  async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private trackInFlight(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    await this.transport.close();
    console.log("[gmail] stopped");
  }

  private schedulePoll(): void {
    if (this.shuttingDown) return;

    const backoffMs =
      this.consecutiveErrors > 0
        ? Math.min(
            (this.config.channels.gmail?.pollIntervalMs || 10000) *
              Math.pow(2, this.consecutiveErrors),
            30 * 60 * 1000,
          )
        : (this.config.channels.gmail?.pollIntervalMs || 10000);

    this.pollTimer = setTimeout(() => {
      this.pollForMessages()
        .catch((err) => console.error("[gmail] poll error", err))
        .finally(() => {
          if (this.connected && !this.shuttingDown) this.schedulePoll();
        });
    }, backoffMs);
  }

  private async pollForMessages(): Promise<void> {
    if (!this.connected || this.shuttingDown) return;

    const inbox = this.getAgentInboxAddress();
    if (!inbox) {
      console.warn("[gmail] no inbox configured; skipping poll");
      return;
    }

    const messageIds = await this.transport.listInboxMessageIds(
      inbox,
      this.config.channels.gmail?.newerThan || "3d",
    );

    let newCount = 0;
    for (const messageId of messageIds) {
      if (isProcessed(messageId)) continue;
      if (!tryClaimMessage(messageId)) {
        console.log(`[gmail] skipped claimed message ${messageId}`);
        continue;
      }
      newCount++;
      console.log(`[gmail] processing new message ${messageId}`);
      this.trackInFlight(
        this.processMessage(messageId).catch((err) => {
          releaseClaim(messageId);
          console.error(`[gmail] failed to process message ${messageId}`, err);
        }),
      );
    }

    console.log(
      `[gmail] poll result: ${messageIds.length} total, ${newCount} new`,
    );
    this.consecutiveErrors = 0;
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.connected) return;
    const stopClaimHeartbeat = this.startClaimHeartbeat(messageId);
    let threadId = messageId;
    let gmailThreadId = messageId;
    let subject = "(no subject)";
    let senderEmail = "";
    let senderName = "";
    let publicTask: PublicTaskContext | undefined;

    try {
      const startedAt = Date.now();
      const message = await this.transport.fetchMessage(messageId);
      console.log(`[gmail] fetched ${messageId} in ${Date.now() - startedAt}ms`);

      if (!message) {
        console.warn(`[gmail] message ${messageId} not found; marking processed`);
        markProcessed(messageId, threadId, subject, senderEmail);
        return;
      }

      gmailThreadId = message.threadId || messageId;
      const threadLink = getThreadSessionLink(gmailThreadId);
      threadId = threadLink?.canonicalThreadId || gmailThreadId;

      subject = message.subject;
      const rfcMessageId = message.rfcMessageId;
      senderName = message.fromName;
      senderEmail = message.fromEmail;
      const body = message.textBody;
      const internalDateMs = message.internalDateMs;
      const timestamp = new Date(internalDateMs || Date.now());
      const inboxAddress = this.getAgentInboxAddress();

      if (
        isOlderThanWindow(
          internalDateMs,
          this.config.channels.gmail?.newerThan || "3d",
        )
      ) {
        console.log(
          `[gmail] skipping stale message ${messageId}; internalDate=${internalDateMs || "(missing)"} older than ${this.config.channels.gmail?.newerThan || "3d"}`,
        );
        await this.markRead(messageId);
        markProcessed(messageId, threadId, subject, senderEmail);
        return;
      }

      // Thread search can surface the bridge's own sent replies when the
      // authenticated account is also the human user's mailbox. Only continue
      // if the fetched message was actually addressed to the agent inbox.
      if (
        inboxAddress &&
        !messageTargetsInbox(message.toAddresses, inboxAddress)
      ) {
        console.log(
          `[gmail] skipping non-inbox message ${messageId}; to=${message.toAddresses.join(", ") || "(missing)"}`,
        );
        markProcessed(messageId, threadId, subject, senderEmail);
        return;
      }

      if (!this.isAuthorizedSender(senderEmail)) {
        console.log(`[gmail] skipping unauthorized sender ${senderEmail} for ${messageId}`);
        await this.markRead(messageId);
        markProcessed(messageId, threadId, subject, senderEmail);
        return;
      }

      this.threadMeta.set(threadId, {
        gmailThreadId,
        senderEmail,
        senderName,
        subject,
        messageId: rfcMessageId,
      });

      const textBody = stripQuotedReply(body).trim() || subject;
      const workflowCommand = this.workflow.parse(textBody);
      publicTask =
        this.publicTasks.get(threadId) ||
        buildPublicTaskContext({
          activityKey: `gmail:${threadId}`,
          source: workflowCommand ? "workflow" : "gmail",
          workflowKind: workflowCommand?.kind,
          subject,
          textBody,
        });
      this.publicTasks.set(threadId, publicTask);

      const pendingPermission = getPendingPermission(threadId);
      if (pendingPermission) {
        await this.handlePendingPermission({
          messageId,
          threadId,
          textBody,
          pendingPermission,
        });
        return;
      }

      const pendingQuestion = getPendingQuestion(threadId);
      if (pendingQuestion) {
        await this.handlePendingQuestion({
          messageId,
          threadId,
          textBody,
          pendingQuestion,
        });
        return;
      }

      if (this.orchestrator.hasActiveRun(threadId)) {
        await this.sendReply(threadId, buildAlreadyRunningReply());
        await this.markRead(messageId);
        markProcessed(messageId, threadId, subject, senderEmail);
        return;
      }

      console.log(
        `[gmail] enqueue from=${senderName} <${senderEmail}> subject=${subject}`,
      );
      this.publicActivity.emit({ type: "task_received", task: publicTask });

      // A scheduled-result email records a link from its Gmail thread back to
      // the scheduled session. When the user replies on that thread, reuse the
      // bound sessionKey so the conversation continues the same OpenCode
      // session instead of starting a fresh gmail:<threadId> one.
      const sessionKey = threadLink?.sessionKey || `gmail:${threadId}`;
      const sessionTitle =
        threadLink?.sessionTitle || buildGmailSessionTitle(subject, textBody);

      const queuedAt = Date.now();
      const result = workflowCommand
        ? await this.workflow.run({
            command: workflowCommand,
            sourceChannel: "gmail",
            sourceSession: threadId,
            senderName,
            chatTitle: subject,
            timestamp,
            publicTask,
          })
        : await this.startManagedRun(
            threadId,
            `gmail start ${threadId}`,
            publicTask,
            async () => {
              const ensuredPublicTask = publicTask as PublicTaskContext;
              const images = await this.transport.fetchImages(messageId);
              const opencodeStartedAt = Date.now();
              const started = await this.orchestrator.startRun(
                {
                  threadId,
                  sourceChannel: "gmail",
                  messageId,
                  senderEmail,
                  senderName,
                  subject,
                  rfcMessageId,
                  textBody,
                  images,
                  timestamp,
                  sessionKey,
                  sessionTitle,
                  publicTask: ensuredPublicTask,
                },
                this.buildRuntimeCallbacks(threadId),
              );
              console.log(
                `[gmail] agent run start ${messageId} in ${Date.now() - opencodeStartedAt}ms`,
              );
              if (!started.started || started.status !== "running") {
                this.executionSlot.release(threadId);
              }
              return started;
            },
          );

      console.log(`[gmail] agent slot released ${messageId} in ${Date.now() - queuedAt}ms`);

      if (typeof result === "string") {
        await this.sendReply(threadId, result);
        this.publicActivity.emit({ type: "report_delivered", task: publicTask });
        this.publicActivity.emit({ type: "task_completed", task: publicTask });
        this.publicActivity.setIdleIfNoActiveRuns();
        this.publicTasks.delete(threadId);
        resetThreadFailures(threadId);
        console.log(`[gmail] direct reply completed for thread ${threadId}`);
      }
      await this.markRead(messageId);
      markProcessed(messageId, threadId, subject, senderEmail);
    } catch (err) {
      releaseClaim(messageId);
      console.error(`[gmail] failed to process/reply thread ${threadId}`, err);
      const failures = incrementThreadFailures(threadId);
      console.warn(
        `[gmail] thread ${threadId} has failed ${failures} time(s) consecutively`,
      );
      if (failures >= 2) {
        await this.orchestrator.invalidateSession(this.sessionKeyForThread(threadId));
      }
      if (publicTask) {
        this.publicActivity.emit({
          type: "task_failed",
          task: publicTask,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.publicActivity.setIdleIfNoActiveRuns();
      this.publicTasks.delete(threadId);
      throw err;
    } finally {
      stopClaimHeartbeat();
    }
  }

  private async handlePendingPermission(params: {
    messageId: string;
    threadId: string;
    textBody: string;
    pendingPermission: PendingPermissionRecord;
  }): Promise<void> {
    const decision = parsePermissionResponse(params.textBody);

    if (!decision) {
      await this.sendReply(
        params.threadId,
        buildPermissionPrompt(params.pendingPermission, true),
      );
      await this.markRead(params.messageId);
      markProcessed(
        params.messageId,
        params.threadId,
        this.threadMeta.get(params.threadId)?.subject || "",
        this.threadMeta.get(params.threadId)?.senderEmail || "",
      );
      return;
    }

    try {
      await this.orchestrator.replyPermission(
        params.threadId,
        params.pendingPermission.permissionId,
        decision,
        this.buildRuntimeCallbacks(params.threadId),
      );
    } catch (err) {
      await this.handleReplyForwardFailure(params.threadId, "permission", err);
    }

    await this.markRead(params.messageId);
    markProcessed(
      params.messageId,
      params.threadId,
      this.threadMeta.get(params.threadId)?.subject || "",
      this.threadMeta.get(params.threadId)?.senderEmail || "",
    );
  }

  private async handlePendingQuestion(params: {
    messageId: string;
    threadId: string;
    textBody: string;
    pendingQuestion: PendingQuestionRecord;
  }): Promise<void> {
    const answers = parseQuestionResponse(
      params.textBody,
      params.pendingQuestion.questions,
    );

    if (!answers) {
      await this.sendReply(
        params.threadId,
        buildQuestionPrompt(params.pendingQuestion, true),
      );
      await this.markRead(params.messageId);
      markProcessed(
        params.messageId,
        params.threadId,
        this.threadMeta.get(params.threadId)?.subject || "",
        this.threadMeta.get(params.threadId)?.senderEmail || "",
      );
      return;
    }

    try {
      await this.orchestrator.replyQuestion(
        params.threadId,
        params.pendingQuestion.questionId,
        answers,
        this.buildRuntimeCallbacks(params.threadId),
      );
    } catch (err) {
      await this.handleReplyForwardFailure(params.threadId, "question", err);
    }

    await this.markRead(params.messageId);
    markProcessed(
      params.messageId,
      params.threadId,
      this.threadMeta.get(params.threadId)?.subject || "",
      this.threadMeta.get(params.threadId)?.senderEmail || "",
    );
  }

  private async handleReplyForwardFailure(
    threadId: string,
    kind: "permission" | "question",
    err: unknown,
  ): Promise<void> {
    console.error(`[gmail] ${kind} reply forwarding failed for thread ${threadId}`, err);
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (this.orchestrator.hasActiveRun(threadId)) {
      await this.sendReply(
        threadId,
        `I couldn't deliver your ${kind} reply this time (${errorMessage}). Please reply again with your response.`,
      );
      return;
    }

    if (kind === "permission") {
      clearPendingPermission(threadId);
    } else {
      clearPendingQuestion(threadId);
    }
    await this.sendReply(
      threadId,
      buildFailureReply(
        `This conversation is no longer active (${errorMessage}). Reply with a fresh request to start over.`,
      ),
    );
  }

  private async resumeActiveRuns(): Promise<void> {
    for (const run of listActiveThreadRuns()) {
      // Scheduled runs live in their own namespace and own recovery loop —
      // do not try to thread-reply from here. Scheduler boot marks orphaned
      // runs as errored and reports via fresh email.
      if (run.threadId.startsWith("scheduled-task:")) continue;
      if (run.sourceChannel !== "gmail") continue;

      this.threadMeta.set(run.threadId, {
        gmailThreadId:
          getLatestGmailThreadIdForCanonicalThread(run.threadId) || run.threadId,
        senderEmail: run.senderEmail,
        senderName: run.senderName,
        subject: run.subject,
        messageId: run.rfcMessageId,
      });
      this.publicTasks.set(
        run.threadId,
        buildPublicTaskContext({
          activityKey: `${run.sourceChannel}:${run.threadId}`,
          source: "gmail",
          subject: run.subject,
          textBody: run.lastUserText,
        }),
      );
      if (run.status === "running") {
        await this.startManagedRun(
          run.threadId,
          `gmail resume ${run.threadId}`,
          this.getPublicTask(run.threadId),
          async () => {
            const resumed = await this.orchestrator.resumeRun(
              run.threadId,
              this.buildRuntimeCallbacks(run.threadId),
            );
            if (!resumed) {
              this.executionSlot.release(run.threadId);
            }
            return resumed;
          },
        );
        continue;
      }

      await this.orchestrator.resumeRun(
        run.threadId,
        this.buildRuntimeCallbacks(run.threadId),
      );
    }
  }

  async sendScheduledResult(payload: ScheduledResultPayload): Promise<void> {
    const publicTask = buildPublicTaskContext({
      activityKey: `scheduled:${payload.taskId}`,
      source: "scheduler",
      summary: payload.summary,
      textBody: payload.body,
    });
    if (!this.connected) {
      this.publicActivity.setIdleIfNoActiveRuns();
      return;
    }
    const recipient = this.getScheduledResultsRecipient();
    if (!recipient) {
      console.warn("[gmail] no scheduled results recipient configured; cannot deliver scheduled result");
      this.publicActivity.setIdleIfNoActiveRuns();
      return;
    }

    const prefix = payload.isError ? "[Scheduled] FAILED " : "[Scheduled] ";
    const subject = `${prefix}${payload.summary} — ${payload.fireTime}`;
    const fromAddress =
      this.userEmail || this.getAgentInboxAddress() || recipient;
    // Route replies to the agent inbox so the poller picks them up — without a
    // Reply-To the user's reply would go back to the sending account and never
    // be ingested as a follow-up task.
    const replyToAddress = this.getAgentInboxAddress();
    const body = [
      payload.body,
      "",
      "—",
      `Task: ${payload.summary}  ·  id: ${payload.taskId}`,
    ].join("\n");

    try {
      const sent = await this.transport.sendMessage({
        to: recipient,
        from: fromAddress,
        replyTo: replyToAddress,
        subject,
        text: body,
        html: markdownToHtml(body),
      });
      const gmailMessageId = sent.messageId;
      const gmailThreadId = sent.threadId;
      recordOutboundEmail({
        deliveryKind: "scheduled_result",
        threadId: payload.taskId,
        gmailThreadId,
        gmailMessageId,
        recipientEmail: recipient,
        subject,
        replyToRfcMessageId: "",
        status: "sent",
        error: "",
      });
      // Bind this delivery thread to the task's session so a reply continues
      // the same OpenCode session as the scheduled run, with full interactive
      // support — i.e. it behaves like a user-triggered thread from here on.
      if (gmailThreadId) {
        upsertThreadSessionLink({
          gmailThreadId,
          sessionKey: `scheduled-task:${payload.taskId}:${payload.fireTime}`,
          sessionTitle: `Scheduled: ${payload.summary}`,
        });
      }
      console.log(
        `[gmail] scheduled result sent task=${payload.taskId} message=${gmailMessageId || "(missing)"} thread=${gmailThreadId || "(missing)"} to=${recipient} subject=${subject}`,
      );
      this.publicActivity.emit({ type: "report_delivered", task: publicTask });
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      recordOutboundEmail({
        deliveryKind: "scheduled_result",
        threadId: payload.taskId,
        gmailThreadId: "",
        gmailMessageId: "",
        recipientEmail: recipient,
        subject,
        replyToRfcMessageId: "",
        status: "failed",
        error: errorMessage,
      });
      console.error(
        `[gmail] scheduled result failed task=${payload.taskId} to=${recipient} subject=${subject}`,
        error,
      );
      throw error;
    } finally {
      this.publicActivity.setIdleIfNoActiveRuns();
    }
  }

  // The OpenCode sessionKey an inbound thread maps to. Defaults to the
  // per-thread gmail key, but follows a recorded link (e.g. a scheduled-result
  // thread) so failure recovery invalidates the session actually in use.
  private sessionKeyForThread(threadId: string): string {
    return getThreadSessionLink(threadId)?.sessionKey || `gmail:${threadId}`;
  }

  private sessionTitleForThread(threadId: string): string {
    const linkedTitle = getThreadSessionLink(threadId)?.sessionTitle;
    if (linkedTitle) return linkedTitle;

    const runTitle = getThreadRun(threadId)?.sessionTitle;
    if (runTitle) return runTitle;

    const meta = this.threadMeta.get(threadId);
    return buildGmailSessionTitle(meta?.subject || "", "");
  }

  private getAgentInboxAddress(): string | undefined {
    return this.config.channels.gmail?.inboxEmail;
  }

  private getUserAddress(): string | undefined {
    return (
      this.config.channels.gmail?.userEmail ||
      this.config.channels.gmail?.scheduledResultsTo
    );
  }

  private getScheduledResultsRecipient(): string | undefined {
    return this.getUserAddress() || this.getAgentInboxAddress();
  }

  private isAuthorizedSender(senderEmail: string): boolean {
    const normalizedSender = senderEmail.trim().toLowerCase();
    const normalizedUser = this.getUserAddress()?.trim().toLowerCase();
    if (!normalizedUser) return true;
    return normalizedSender === normalizedUser;
  }

  private buildRuntimeCallbacks(threadId: string): RuntimeCallbacks {
    return {
      onPermission: async (request) => {
        await this.sendReply(threadId, buildPermissionPrompt(request));
      },
      onQuestion: async (request) => {
        await this.sendReply(threadId, buildQuestionPrompt(request));
      },
      onComplete: async (text) => {
        await this.sendReply(threadId, text);
        const publicTask = this.publicTasks.get(threadId);
        if (publicTask) {
          this.publicActivity.emit({ type: "report_delivered", task: publicTask });
          this.publicTasks.delete(threadId);
        }
        resetThreadFailures(threadId);
      },
      onFailed: async (error) => {
        const failures = incrementThreadFailures(threadId);
        if (failures >= 2) {
          await this.orchestrator.invalidateSession(this.sessionKeyForThread(threadId));
        }
        await this.sendReply(threadId, buildFailureReply(error));
        const publicTask = this.publicTasks.get(threadId);
        if (publicTask) {
          this.publicActivity.emit({ type: "report_delivered", task: publicTask });
          this.publicTasks.delete(threadId);
        }
      },
      onTerminal: async () => {
        this.executionSlot.release(threadId);
      },
    };
  }

  private startClaimHeartbeat(messageId: string): () => void {
    const timer = setInterval(() => {
      refreshClaim(messageId);
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }

  private async startManagedRun<T>(
    runKey: string,
    label: string,
    publicTask: PublicTaskContext,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.queue.enqueue(
      label,
      async () => {
        const lease = this.executionSlot.begin(runKey);
        try {
          const result = await action();
          await lease.wait();
          return result;
        } catch (error) {
          lease.release();
          throw error;
        }
      },
      publicTask,
    );
  }

  private getPublicTask(threadId: string): PublicTaskContext {
    return (
      this.publicTasks.get(threadId) ||
      buildPublicTaskContext({
        activityKey: `gmail:${threadId}`,
        source: threadId.startsWith("scheduled-task:") ? "scheduler" : "gmail",
      })
    );
  }

  private async sendReply(threadId: string, text: string): Promise<void> {
    if (!this.connected) return;

    const meta = this.threadMeta.get(threadId);
    if (!meta) {
      console.warn(`[gmail] no meta for thread ${threadId}, skipping reply`);
      return;
    }

    const subject = meta.subject.startsWith("Re:")
      ? meta.subject
      : `Re: ${meta.subject}`;
    const gmailThreadId =
      meta.gmailThreadId ||
      getLatestGmailThreadIdForCanonicalThread(threadId) ||
      threadId;

    try {
      const sent = await this.transport.sendMessage({
        to: `${meta.senderName} <${meta.senderEmail}>`,
        replyTo: this.getAgentInboxAddress() || meta.senderEmail,
        subject,
        inReplyTo: meta.messageId || undefined,
        references: meta.messageId ? [meta.messageId] : undefined,
        text,
        html: markdownToHtml(text),
      });
      const gmailMessageId = sent.messageId;
      const responseThreadId = sent.threadId || gmailThreadId;
      meta.gmailThreadId = responseThreadId;
      upsertThreadSessionLink({
        gmailThreadId: responseThreadId,
        canonicalThreadId: threadId,
        sessionKey: this.sessionKeyForThread(threadId),
        sessionTitle: this.sessionTitleForThread(threadId),
      });
      recordOutboundEmail({
        deliveryKind: "thread_reply",
        threadId,
        gmailThreadId: responseThreadId,
        gmailMessageId,
        recipientEmail: meta.senderEmail,
        subject,
        replyToRfcMessageId: meta.messageId,
        status: "sent",
        error: "",
      });
      console.log(
        `[gmail] reply sent thread=${threadId} gmailThread=${responseThreadId} message=${gmailMessageId || "(missing)"} to=${meta.senderEmail} subject=${subject}`,
      );
    } catch (error) {
      const errorMessage = extractErrorMessage(error);
      recordOutboundEmail({
        deliveryKind: "thread_reply",
        threadId,
        gmailThreadId,
        gmailMessageId: "",
        recipientEmail: meta.senderEmail,
        subject,
        replyToRfcMessageId: meta.messageId,
        status: "failed",
        error: errorMessage,
      });
      console.error(
        `[gmail] reply failed thread=${threadId} to=${meta.senderEmail} subject=${subject}`,
        error,
      );
      throw error;
    }
  }

  private async markRead(messageId: string): Promise<void> {
    if (!this.connected) return;
    await this.transport.markRead(messageId);
  }
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [
    "<html>",
    "<body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.55;color:#111827;\">",
  ];
  let paragraph: string[] = [];
  let inList = false;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  // Raw HTML tables emitted by the model must reach the email verbatim. Without
  // this passthrough every `<table>` line is escaped and renders as plain text.
  let inTable = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!inList) return;
    html.push("</ul>");
    inList = false;
  };

  const flushCodeBlock = () => {
    if (!inCodeBlock) return;
    html.push(
      `<pre style="white-space:pre-wrap;background:#f3f4f6;padding:12px;border-radius:8px;"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    );
    inCodeBlock = false;
    codeLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (inTable) {
      html.push(line);
      if (/<\/table>/i.test(trimmed)) {
        inTable = false;
      }
      continue;
    }

    if (/^<table[\s>]/i.test(trimmed)) {
      flushParagraph();
      closeList();
      html.push(line);
      if (!/<\/table>/i.test(trimmed)) {
        inTable = true;
      }
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = Math.min(headingMatch[1].length, 6);
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const bulletMatch = trimmed.match(/^-\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInlineMarkdown(bulletMatch[1])}</li>`);
      continue;
    }

    if (isStandaloneUrl(trimmed)) {
      flushParagraph();
      closeList();
      const safeUrl = escapeHtml(trimmed);
      html.push(`<p><a href="${safeUrl}">${safeUrl}</a></p>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  flushCodeBlock();
  html.push("</body>", "</html>");
  return html.join("\n");
}

function renderInlineMarkdown(input: string): string {
  const placeholders = new Map<string, string>();
  let output = input.replace(/`([^`]+)`/g, (_, code: string) => {
    const key = `__CODE_${placeholders.size}__`;
    placeholders.set(
      key,
      `<code style="background:#f3f4f6;padding:2px 4px;border-radius:4px;">${escapeHtml(code)}</code>`,
    );
    return key;
  });

  output = escapeHtml(output);
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}">${escapeHtml(label)}</a>`;
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  for (const [key, value] of placeholders) {
    output = output.replace(key, value);
  }

  return output;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isOlderThanWindow(
  internalDateMs: number | undefined,
  window: string,
): boolean {
  if (!internalDateMs) return false;
  const windowMs = parseGmailNewerThanWindow(window);
  if (windowMs === undefined) return false;
  return internalDateMs < Date.now() - windowMs;
}

function parseGmailNewerThanWindow(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  switch (match[2].toLowerCase()) {
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

function isStandaloneUrl(input: string): boolean {
  return /^https?:\/\/\S+$/i.test(input);
}

function messageTargetsInbox(headers: string[], inboxAddress: string): boolean {
  const normalizedInbox = inboxAddress.trim().toLowerCase();
  return headers.some((value) => value.toLowerCase().includes(normalizedInbox));
}

function stripQuotedReply(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === "--" || trimmed === "__") {
      break;
    }

    if (trimmed.startsWith(">")) {
      break;
    }

    if (isReplyHeader(trimmed)) {
      break;
    }

    kept.push(line);
  }

  return kept.join("\n").trim();
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}


function isReplyHeader(line: string): boolean {
  if (!line) return false;

  return (
    /^On .+wrote:$/i.test(line) ||
    /^在.+写道：$/i.test(line) ||
    /^.+于.+写道：$/i.test(line) ||
    /^.+ wrote:$/i.test(line) ||
    /^-+Original Message-+$/i.test(line) ||
    /^-+ Forwarded message -+$/i.test(line) ||
    /^From:\s+/i.test(line) ||
    /^Sent:\s+/i.test(line) ||
    /^Date:\s+/i.test(line) ||
    /^Subject:\s+/i.test(line) ||
    /^To:\s+/i.test(line) ||
    /^发件人：/i.test(line) ||
    /^发送时间：/i.test(line) ||
    /^日期：/i.test(line) ||
    /^主题：/i.test(line) ||
    /^收件人：/i.test(line)
  );
}

function buildGmailSessionTitle(subject: string, textBody: string): string {
  const normalizedSubject = normalizeSessionTitleFragment(subject);
  const normalizedBody = normalizeSessionTitleFragment(textBody.split("\n")[0] || "");
  const title = normalizedSubject || normalizedBody || "Untitled request";
  return `Gmail ${title}`;
}

function normalizeSessionTitleFragment(value: string): string {
  const normalized = value
    .replace(/^(re|fwd|fw)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized.toLowerCase() === "(no subject)") {
    return "";
  }

  return normalized.slice(0, 72);
}

function parsePermissionResponse(text: string): PermissionResponse | undefined {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = (firstLine || text.trim())
    .toUpperCase()
    .replace(/[.!?。！？]+$/g, "");

  if (/^(APPROVE|ALLOW|YES)\b/.test(normalized)) {
    return "once";
  }

  if (/^ALWAYS\b/.test(normalized)) {
    return "always";
  }

  if (/^(REJECT|DENY|NO)\b/.test(normalized)) {
    return "reject";
  }

  return undefined;
}

function buildPermissionPrompt(
  permission: Pick<PendingPermissionRecord, "title" | "type" | "pattern">,
  remindOnly = false,
): string {
  const lines = [
    remindOnly
      ? "This thread is waiting for your approval before I can continue."
      : "I need your approval before I can continue this request.",
    "",
    `**Permission:** ${permission.title || permission.type}`,
  ];

  if (permission.pattern) {
    lines.push("");
    lines.push(`**Target:** ${permission.pattern}`);
  }

  lines.push("");
  lines.push(
    "Reply with **APPROVE** to allow once, **ALWAYS** to remember this permission, or **REJECT** to deny it.",
  );

  return lines.join("\n");
}

function buildQuestionPrompt(
  question: Pick<PendingQuestionRecord, "questions">,
  remindOnly = false,
): string {
  const lines = [
    remindOnly
      ? "This thread is waiting for your answer before I can continue."
      : "I need your answer before I can continue this request.",
    "Reply in plain text using one non-empty line per question, in the same order.",
  ];

  question.questions.forEach((item, index) => {
    lines.push("");
    lines.push(`**${index + 1}. ${item.header}: ${item.question}**`);
    if (item.options.length > 0) {
      lines.push("");
      lines.push("Options:");
      for (const option of item.options) {
        lines.push(`- ${option.label}`);
      }
    }
    if (item.multiple) {
      lines.push("");
      lines.push("You may choose multiple options by separating labels with commas.");
    }
    if (item.custom !== false) {
      lines.push("");
      lines.push("Custom text is also allowed if none of the labels fit.");
    }
  });

  return lines.join("\n");
}

function parseQuestionResponse(
  text: string,
  questions: PendingQuestionRecord["questions"],
): string[][] | undefined {
  const normalized = stripQuotedReply(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (questions.length === 0) return [];
  if (normalized.length === 0) return undefined;

  const rawAnswers =
    questions.length === 1 ? [normalized.join(" ")] : normalized.slice(0, questions.length);

  if (rawAnswers.length < questions.length) {
    return undefined;
  }

  const parsed = questions.map((question, index) =>
    parseSingleQuestionAnswer(rawAnswers[index], question),
  );
  return parsed.every(Boolean) ? (parsed as string[][]) : undefined;
}

function parseSingleQuestionAnswer(
  answer: string,
  question: PendingQuestionRecord["questions"][number],
): string[] | undefined {
  const raw = answer.trim();
  if (!raw) return undefined;

  if (question.options.length === 0) {
    return [raw];
  }

  const labelMap = new Map(
    question.options.map((option) => [option.label.trim().toUpperCase(), option.label]),
  );
  const parts = question.multiple
    ? raw
        .split(/[,，;；]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : [raw];

  const matched = parts
    .map((part) => labelMap.get(part.toUpperCase()))
    .filter((item): item is string => Boolean(item));

  if (matched.length > 0) {
    return question.multiple ? matched : [matched[0]];
  }

  if (question.custom === false) {
    return undefined;
  }

  return [raw];
}

function buildAlreadyRunningReply(): string {
  return "This thread already has a request in progress. I will continue the active run and reply here when it finishes.";
}

function buildFailureReply(error: string): string {
  return [
    "I could not complete this request.",
    `Error: ${error}`,
    "Reply again in this thread if you want me to retry.",
  ].join("\n");
}
