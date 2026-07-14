import { Buffer } from "node:buffer";

import {
  query,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { StateStore } from "../../state.js";
import type {
  AgentPermissionResponse,
  AgentProvider,
  AgentRunRequest,
  AgentRunStartResult,
  AgentRuntimeCallbacks,
} from "../types.js";
import type { AppConfig, PersistedState, TurnInput } from "../../types.js";

interface PendingPermission {
  id: string;
  toolUseID: string;
  suggestions?: PermissionUpdate[];
  resolve: (value: PermissionResult) => void;
}

interface PendingQuestion {
  id: string;
  toolUseID: string;
  input: AskUserQuestionLike;
  resolve: (value: PermissionResult) => void;
}

interface ClaudeActiveRun {
  threadId: string;
  sessionKey: string;
  sessionId?: string;
  callbacks: AgentRuntimeCallbacks;
  abortController: AbortController;
  pendingPermission?: PendingPermission;
  pendingQuestion?: PendingQuestion;
}

interface AskUserQuestionLike {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect?: boolean;
  }>;
}

const CHANNEL_SESSION_TITLES: Record<string, string> = {
  gmail: "Gmail Andy",
};

export class ClaudeProvider implements AgentProvider {
  private readonly stateStore: StateStore;
  private readonly activeRuns = new Map<string, ClaudeActiveRun>();
  private stateCache?: PersistedState;

  constructor(private readonly config: AppConfig) {
    this.stateStore = new StateStore(config.stateFile);
  }

  async healthcheck(): Promise<void> {
    const hasConfiguredAuth =
      Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
      Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) ||
      process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
      process.env.CLAUDE_CODE_USE_VERTEX === "1" ||
      process.env.CLAUDE_CODE_USE_FOUNDRY === "1" ||
      process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS === "1";

    if (!hasConfiguredAuth) {
      throw new Error(
        "Claude provider requires ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or another supported Claude auth environment.",
      );
    }

    console.log(
      `[claude] ready; cwd=${this.defaultWorkingDirectory()} model=${this.config.providers.claude?.model || "default"}`,
    );
  }

  startBackgroundMonitoring(): void {}

  async sendTurn(channel: string, input: TurnInput): Promise<string> {
    const sessionKey = input.sessionKey || channel;
    const sessionTitle =
      input.sessionTitle ||
      CHANNEL_SESSION_TITLES[channel] ||
      `${channel} Andy`;
    const prompt = buildPromptBody(channel, input);
    const options = this.buildClaudeOptions({
      sessionId: await this.getSessionId(sessionKey),
      workingDirectory: input.sessionDirectory,
    });

    let resultText = "";
    let latestAssistantText = "";
    let latestSessionId = options.resume;

    for await (const message of query({ prompt, options })) {
      latestSessionId = captureSessionId(message) || latestSessionId;
      latestAssistantText = extractAssistantText(message) || latestAssistantText;
      if (message.type === "result") {
        latestSessionId = message.session_id || latestSessionId;
        if (message.subtype === "success") {
          resultText = message.result;
        } else {
          throw new Error(message.errors.join("\n") || "Claude run failed");
        }
      }
    }

    if (latestSessionId) {
      await this.saveSessionId(sessionKey, latestSessionId);
    }

    if (resultText.trim()) return resultText;
    if (latestAssistantText.trim()) return latestAssistantText;

    return `Claude completed the turn for "${sessionTitle}" but returned no text.`;
  }

  async startRun(
    request: AgentRunRequest,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<AgentRunStartResult> {
    const existing = this.activeRuns.get(request.threadId);
    if (existing) {
      existing.callbacks = callbacks;
      return {
        started: false,
        status: existing.pendingPermission
          ? "waiting_permission"
          : existing.pendingQuestion
            ? "waiting_question"
            : "running",
        sessionId: existing.sessionId,
      };
    }

    const sessionId = await this.getSessionId(request.sessionKey);
    const abortController = new AbortController();
    const run: ClaudeActiveRun = {
      threadId: request.threadId,
      sessionKey: request.sessionKey,
      sessionId,
      callbacks,
      abortController,
    };
    this.activeRuns.set(request.threadId, run);
    void this.executeRun(run, request);

    return { started: true, status: "running", sessionId };
  }

  async resumeRun(
    threadId: string,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<boolean> {
    const run = this.activeRuns.get(threadId);
    if (!run) return false;
    run.callbacks = callbacks;
    return true;
  }

  hasActiveRun(threadId: string): boolean {
    return this.activeRuns.has(threadId);
  }

  async replyPermission(
    threadId: string,
    permissionId: string,
    response: AgentPermissionResponse,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<void> {
    const run = this.getRun(threadId);
    run.callbacks = callbacks;
    if (!run.pendingPermission || run.pendingPermission.id !== permissionId) {
      throw new Error(`No pending Claude permission ${permissionId} for ${threadId}`);
    }

    if (response === "reject") {
      run.pendingPermission.resolve({
        behavior: "deny",
        message: "User denied this action",
        toolUseID: run.pendingPermission.toolUseID,
      });
    } else {
      run.pendingPermission.resolve({
        behavior: "allow",
        toolUseID: run.pendingPermission.toolUseID,
        // "always" persists the grant for the rest of the session so the same
        // tool/pattern is not re-prompted; "once" allows just this call.
        ...(response === "always" && run.pendingPermission.suggestions?.length
          ? { updatedPermissions: run.pendingPermission.suggestions }
          : {}),
      });
    }
    run.pendingPermission = undefined;
  }

  async replyQuestion(
    threadId: string,
    questionId: string,
    answers: string[][],
    callbacks: AgentRuntimeCallbacks,
  ): Promise<void> {
    const run = this.getRun(threadId);
    run.callbacks = callbacks;
    if (!run.pendingQuestion || run.pendingQuestion.id !== questionId) {
      throw new Error(`No pending Claude question ${questionId} for ${threadId}`);
    }

    const answerMap = buildQuestionAnswerMap(run.pendingQuestion.input, answers);
    run.pendingQuestion.resolve({
      behavior: "allow",
      updatedInput: {
        ...run.pendingQuestion.input,
        answers: answerMap.answers,
        ...(answerMap.response ? { response: answerMap.response } : {}),
      },
      toolUseID: run.pendingQuestion.toolUseID,
    });
    run.pendingQuestion = undefined;
  }

  async invalidateSession(sessionKey: string): Promise<void> {
    const state = await this.loadState();
    const sessions = { ...(state.sessions || {}) };
    delete sessions[this.stateSessionKey(sessionKey)];
    await this.saveState({ ...state, sessions });
  }

  private async executeRun(
    run: ClaudeActiveRun,
    request: AgentRunRequest,
  ): Promise<void> {
    let finalError: string | undefined;
    let completedText = "";

    try {
      const prompt = buildRunPrompt(request);
      const options = this.buildClaudeOptions({
        sessionId: run.sessionId,
        workingDirectory: undefined,
        abortController: run.abortController,
        canUseTool: this.buildCanUseTool(run),
      });

      for await (const message of query({ prompt, options })) {
        run.sessionId = captureSessionId(message) || run.sessionId;
        if (message.type !== "result") continue;

        run.sessionId = message.session_id || run.sessionId;
        if (message.subtype === "success") {
          completedText = message.result;
        } else {
          finalError = message.errors.join("\n") || "Claude run failed";
        }
      }

      if (run.sessionId) {
        await this.saveSessionId(run.sessionKey, run.sessionId);
      }

      if (finalError) {
        await run.callbacks.onFailed(finalError);
        return;
      }

      await run.callbacks.onComplete(
        completedText || "Claude completed the task but returned no text.",
      );
    } catch (error) {
      finalError = error instanceof Error ? error.message : String(error);
      await run.callbacks.onFailed(finalError);
    } finally {
      this.activeRuns.delete(run.threadId);
      await run.callbacks.onTerminal();
    }
  }

  private buildCanUseTool(run: ClaudeActiveRun): CanUseTool {
    return async (toolName, input, context) => {
      if (toolName === "AskUserQuestion") {
        const questionInput = input as unknown as AskUserQuestionLike;
        return new Promise<PermissionResult>((resolve) => {
          run.pendingQuestion = {
            id: context.requestId,
            toolUseID: context.toolUseID,
            input: questionInput,
            resolve,
          };

          void run.callbacks.onQuestion({
            threadId: run.threadId,
            sessionId: run.sessionId || "",
            questionId: context.requestId,
            messageId: context.toolUseID,
            questions: questionInput.questions.map((item) => ({
              question: item.question,
              header: item.header,
              options: item.options.map((option) => ({
                label: option.label,
                description: option.description,
              })),
              multiple: item.multiSelect,
              custom: true,
            })),
          });
        });
      }

      return new Promise<PermissionResult>((resolve) => {
        run.pendingPermission = {
          id: context.requestId,
          toolUseID: context.toolUseID,
          suggestions: context.suggestions,
          resolve,
        };

        void run.callbacks.onPermission({
          threadId: run.threadId,
          sessionId: run.sessionId || "",
          permissionId: context.requestId,
          messageId: context.toolUseID,
          title: context.title || `${toolName} permission requested`,
          type: toolName,
          pattern: extractPermissionPattern(toolName, input),
        });
      });
    };
  }

  private buildClaudeOptions(params: {
    sessionId?: string;
    workingDirectory?: string;
    abortController?: AbortController;
    canUseTool?: CanUseTool;
  }): ClaudeOptions {
    return {
      cwd: params.workingDirectory || this.defaultWorkingDirectory(),
      ...(params.sessionId ? { resume: params.sessionId } : {}),
      ...(params.abortController ? { abortController: params.abortController } : {}),
      ...(params.canUseTool ? { canUseTool: params.canUseTool } : {}),
      ...(this.config.providers.claude?.model
        ? { model: this.config.providers.claude.model }
        : {}),
      ...(this.config.providers.claude?.permissionMode
        ? { permissionMode: this.config.providers.claude.permissionMode }
        : {}),
    };
  }

  private defaultWorkingDirectory(): string {
    return this.config.providers.claude?.workingDirectory || process.cwd();
  }

  private async getSessionId(sessionKey: string): Promise<string | undefined> {
    const state = await this.loadState();
    return state.sessions?.[this.stateSessionKey(sessionKey)];
  }

  private async saveSessionId(
    sessionKey: string,
    sessionId: string,
  ): Promise<void> {
    const state = await this.loadState();
    const sessions = { ...(state.sessions || {}) };
    sessions[this.stateSessionKey(sessionKey)] = sessionId;
    await this.saveState({ ...state, sessions });
  }

  private stateSessionKey(sessionKey: string): string {
    return `claude:${sessionKey}`;
  }

  private async loadState(): Promise<PersistedState> {
    if (!this.stateCache) {
      this.stateCache = await this.stateStore.load();
    }
    return this.stateCache;
  }

  private async saveState(state: PersistedState): Promise<void> {
    this.stateCache = state;
    await this.stateStore.save(state);
  }

  private getRun(threadId: string): ClaudeActiveRun {
    const run = this.activeRuns.get(threadId);
    if (!run) {
      throw new Error(`No active Claude run for ${threadId}`);
    }
    return run;
  }
}

function buildPromptBody(channel: string, input: TurnInput): string {
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  return [
    `${label} message`,
    `Sender: ${input.senderName}`,
    `Chat: ${input.chatTitle || "Direct chat"}`,
    `Timestamp: ${input.timestamp.toISOString()}`,
    "",
    input.text.trim(),
  ].join("\n");
}

function composeManagedRunPrompt(request: AgentRunRequest): string {
  return [
    `Channel: ${request.sourceChannel}`,
    `Sender: ${request.senderName} <${request.senderEmail}>`,
    `Subject: ${request.subject}`,
    `Timestamp: ${request.timestamp.toISOString()}`,
    "",
    request.subject.trim(),
    "",
    request.textBody.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

// When the request carries attachments, forward them to Claude as native
// image/document content blocks. Text-only runs stay on the simple string
// prompt so the common path is unchanged.
function buildRunPrompt(
  request: AgentRunRequest,
): string | AsyncIterable<SDKUserMessage> {
  const text = composeManagedRunPrompt(request);
  if (!request.images?.length) return text;
  return streamRunPrompt(request, text);
}

async function* streamRunPrompt(
  request: AgentRunRequest,
  text: string,
): AsyncGenerator<SDKUserMessage> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];

  for (const image of request.images || []) {
    const parsed = parseDataUrl(image.url);
    if (!parsed) continue;
    if (parsed.mediaType === "application/pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: parsed.data,
        },
      });
    } else {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: parsed.mediaType,
          data: parsed.data,
        },
      });
    }
  }

  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
}

function parseDataUrl(
  url: string,
): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!match) return undefined;
  const mediaType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const raw = match[3] || "";
  const data = isBase64
    ? raw
    : Buffer.from(decodeURIComponent(raw), "utf8").toString("base64");
  return { mediaType, data };
}

function captureSessionId(message: SDKMessage): string | undefined {
  return "session_id" in message ? message.session_id : undefined;
}

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  return message.message.content
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractPermissionPattern(
  toolName: string,
  input: unknown,
): string {
  if (!input || typeof input !== "object") return toolName;
  const record = input as Record<string, unknown>;
  if (toolName === "Bash" && typeof record.command === "string") {
    return record.command;
  }
  if (typeof record.file_path === "string") {
    return record.file_path;
  }
  return JSON.stringify(input);
}

function buildQuestionAnswerMap(
  input: AskUserQuestionLike,
  answers: string[][],
): { answers: Record<string, string>; response?: string } {
  const mapped: Record<string, string> = {};
  let freeTextResponse: string | undefined;

  input.questions.forEach((question, index) => {
    const answerList = answers[index] || [];
    const joined = answerList.join(", ").trim();
    mapped[question.question] = joined;

    const optionLabels = new Set(question.options.map((option) => option.label));
    if (!freeTextResponse && answerList.some((item) => !optionLabels.has(item))) {
      freeTextResponse = joined;
    }
  });

  return { answers: mapped, ...(freeTextResponse ? { response: freeTextResponse } : {}) };
}
