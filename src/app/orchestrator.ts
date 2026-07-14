import {
  clearPendingPermission,
  clearPendingQuestion,
  getThreadRun,
  upsertPendingPermission,
  upsertPendingQuestion,
  upsertThreadRun,
  updateThreadRunStatus,
} from "../db.js";
import type { AgentProvider } from "../providers/types.js";
import type {
  AgentPermissionResponse,
  AgentRunStartResult,
  AgentRunRequest,
  AgentRuntimeCallbacks,
} from "../providers/types.js";
import type { TurnInput } from "../types.js";

export class AppOrchestrator {
  constructor(private readonly provider: AgentProvider) {}

  async healthcheck(): Promise<void> {
    await this.provider.healthcheck();
  }

  startBackgroundMonitoring(): void {
    this.provider.startBackgroundMonitoring();
  }

  async sendTurn(channel: string, input: TurnInput): Promise<string> {
    return this.provider.sendTurn(channel, input);
  }

  async startRun(
    request: AgentRunRequest,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<AgentRunStartResult> {
    const wrapped = this.wrapCallbacks(request.threadId, callbacks);
    const result = await this.provider.startRun(request, wrapped);

    if (result.started) {
      upsertThreadRun({
        threadId: request.threadId,
        sourceChannel: request.sourceChannel,
        sessionKey: request.sessionKey,
        sessionId: result.sessionId || "",
        sessionTitle: request.sessionTitle,
        gmailMessageId: request.messageId,
        senderEmail: request.senderEmail,
        senderName: request.senderName,
        subject: request.subject,
        rfcMessageId: request.rfcMessageId,
        lastUserText: request.textBody,
        status: "running",
        lastError: "",
        startedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
    }

    return result;
  }

  async resumeRun(
    threadId: string,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<boolean> {
    return this.provider.resumeRun(threadId, this.wrapCallbacks(threadId, callbacks));
  }

  hasActiveRun(threadId: string): boolean {
    return this.provider.hasActiveRun(threadId);
  }

  async replyPermission(
    threadId: string,
    permissionId: string,
    response: AgentPermissionResponse,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<void> {
    clearPendingPermission(threadId);
    updateThreadRunStatus({ threadId, status: "running", lastError: "" });
    await this.provider.replyPermission(
      threadId,
      permissionId,
      response,
      this.wrapCallbacks(threadId, callbacks),
    );
  }

  async replyQuestion(
    threadId: string,
    questionId: string,
    answers: string[][],
    callbacks: AgentRuntimeCallbacks,
  ): Promise<void> {
    clearPendingQuestion(threadId);
    updateThreadRunStatus({ threadId, status: "running", lastError: "" });
    await this.provider.replyQuestion(
      threadId,
      questionId,
      answers,
      this.wrapCallbacks(threadId, callbacks),
    );
  }

  async invalidateSession(sessionKey: string): Promise<void> {
    await this.provider.invalidateSession(sessionKey);
  }

  private wrapCallbacks(
    threadId: string,
    callbacks: AgentRuntimeCallbacks,
  ): AgentRuntimeCallbacks {
    return {
      onPermission: async (request) => {
        const run = getThreadRun(threadId);
        upsertPendingPermission(request);
        updateThreadRunStatus({
          threadId,
          status: "waiting_permission",
          lastError: "",
        });
        if (run && request.sessionId && request.sessionId !== run.sessionId) {
          upsertThreadRun({
            ...run,
            sessionId: request.sessionId,
            status: "waiting_permission",
            updatedAtMs: Date.now(),
          });
        }
        await callbacks.onPermission(request);
      },
      onQuestion: async (request) => {
        const run = getThreadRun(threadId);
        upsertPendingQuestion(request);
        updateThreadRunStatus({
          threadId,
          status: "waiting_question",
          lastError: "",
        });
        if (run && request.sessionId && request.sessionId !== run.sessionId) {
          upsertThreadRun({
            ...run,
            sessionId: request.sessionId,
            status: "waiting_question",
            updatedAtMs: Date.now(),
          });
        }
        await callbacks.onQuestion(request);
      },
      onComplete: async (text) => {
        clearPendingPermission(threadId);
        clearPendingQuestion(threadId);
        updateThreadRunStatus({
          threadId,
          status: "completed",
          lastError: "",
        });
        await callbacks.onComplete(text);
      },
      onFailed: async (error) => {
        clearPendingPermission(threadId);
        clearPendingQuestion(threadId);
        updateThreadRunStatus({
          threadId,
          status: "failed",
          lastError: error,
        });
        await callbacks.onFailed(error);
      },
      onTerminal: async () => {
        await callbacks.onTerminal();
      },
    };
  }
}
