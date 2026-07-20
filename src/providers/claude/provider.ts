import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  query,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
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

const IMAGE_SUMMARY_SYSTEM_PROMPT = [
  "You convert inbound email image attachments into a compact, faithful markdown briefing for a downstream coding/research agent.",
  "Extract visible text, tables, charts, holdings, numbers, dates, and any user-relevant facts.",
  "Keep uncertainty explicit. Do not invent details that are not visible.",
  "Return only markdown. Do not call tools.",
].join("\n");

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
      latestAssistantText =
        extractAssistantText(message) || latestAssistantText;
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
      throw new Error(
        `No pending Claude permission ${permissionId} for ${threadId}`,
      );
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
      throw new Error(
        `No pending Claude question ${questionId} for ${threadId}`,
      );
    }

    const answerMap = buildQuestionAnswerMap(
      run.pendingQuestion.input,
      answers,
    );
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
    let resultMessage: SDKResultMessage | undefined;
    let latestAssistantUsage: MessageUsage | undefined;

    try {
      const preparedRequest = await this.prepareRunRequest(run, request);
      const prompt = buildRunPrompt(preparedRequest);
      const options = this.buildClaudeOptions({
        sessionId: run.sessionId,
        workingDirectory: undefined,
        abortController: run.abortController,
        canUseTool: this.buildCanUseTool(run),
      });

      for await (const message of query({ prompt, options })) {
        run.sessionId = captureSessionId(message) || run.sessionId;
        latestAssistantUsage =
          extractAssistantUsage(message) || latestAssistantUsage;
        if (message.type !== "result") continue;

        resultMessage = message;
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
        appendContextUsageFooter(
          completedText || "Claude completed the task but returned no text.",
          latestAssistantUsage,
          resultMessage,
        ),
      );
    } catch (error) {
      finalError = error instanceof Error ? error.message : String(error);
      await run.callbacks.onFailed(finalError);
    } finally {
      this.activeRuns.delete(run.threadId);
      await run.callbacks.onTerminal();
    }
  }

  private async prepareRunRequest(
    run: ClaudeActiveRun,
    request: AgentRunRequest,
  ): Promise<AgentRunRequest> {
    if (!request.images?.length) return request;

    try {
      const summary = await this.summarizeImagesForRun(run, request);
      if (!summary.trim())
        return withoutImages(
          request,
          "Image attachments were present, but the vision prepass returned no summary.",
        );

      console.log(
        `[claude] summarized ${request.images.length} image attachment(s) thread=${run.threadId}`,
      );
      return {
        ...request,
        textBody: appendImageSummary(request.textBody, summary),
        images: [],
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[claude] image prepass failed thread=${run.threadId}; continuing text-only: ${detail}`,
      );
      return withoutImages(
        request,
        [
          "Image attachments were received but could not be summarized before the main agent run.",
          ...request.images.map(formatImageReference),
        ].join("\n"),
      );
    }
  }

  private async summarizeImagesForRun(
    run: ClaudeActiveRun,
    request: AgentRunRequest,
  ): Promise<string> {
    let resultText = "";
    let latestAssistantText = "";
    let resultMessage: SDKResultMessage | undefined;

    const prompt = streamImageSummaryPrompt(request);
    const options: ClaudeOptions = {
      cwd: this.defaultWorkingDirectory(),
      abortController: run.abortController,
      tools: [],
      settingSources: [],
      maxTurns: 1,
      systemPrompt: IMAGE_SUMMARY_SYSTEM_PROMPT,
      ...(this.config.providers.claude?.model
        ? { model: this.config.providers.claude.model }
        : {}),
    };

    for await (const message of query({ prompt, options })) {
      latestAssistantText =
        extractAssistantText(message) || latestAssistantText;
      if (message.type !== "result") continue;
      resultMessage = message;
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        throw new Error(
          message.errors.join("\n") || "Claude image prepass failed",
        );
      }
    }

    const usage = resultMessage?.usage;
    if (usage) {
      console.log(
        `[claude] image prepass usage thread=${run.threadId} input=${usage.input_tokens} cacheRead=${usage.cache_read_input_tokens} cacheCreate=${usage.cache_creation_input_tokens} output=${usage.output_tokens}`,
      );
    }

    return resultText.trim() || latestAssistantText.trim();
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

      if (
        isWorkspaceReadTool(toolName, input, this.defaultWorkingDirectory())
      ) {
        return {
          behavior: "allow",
          toolUseID: context.toolUseID,
        };
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
      ...(params.abortController
        ? { abortController: params.abortController }
        : {}),
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

function appendImageSummary(textBody: string, summary: string): string {
  return [
    textBody.trim(),
    "",
    "## Image attachment summary",
    "",
    summary.trim(),
    "",
    "The original image bytes were summarized before this main agent run to keep the working context small. Use the listed local paths only if a visual detail must be rechecked.",
  ]
    .filter(Boolean)
    .join("\n");
}

function withoutImages(
  request: AgentRunRequest,
  note: string,
): AgentRunRequest {
  return {
    ...request,
    textBody: appendImageSummary(request.textBody, note),
    images: [],
  };
}

function formatImageReference(image: {
  filename: string;
  mime: string;
  localPath?: string;
  size?: number;
}): string {
  return `- ${image.filename} (${image.mime}${image.size ? `, ${image.size} bytes` : ""})${image.localPath ? `: ${image.localPath}` : ""}`;
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
    if (!image.url) continue;
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

async function* streamImageSummaryPrompt(
  request: AgentRunRequest,
): AsyncGenerator<SDKUserMessage> {
  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: [
        "Summarize these email image attachments for the main agent run.",
        "",
        "Email context:",
        `Subject: ${request.subject}`,
        `Sender: ${request.senderName} <${request.senderEmail}>`,
        `Timestamp: ${request.timestamp.toISOString()}`,
        "",
        "Attachment list:",
        ...(request.images || []).map(formatImageReference),
      ].join("\n"),
    },
  ];

  for (const image of request.images || []) {
    const block = await buildClaudeAttachmentBlock(image);
    content.push({
      type: "text",
      text: `Attachment: ${formatImageReference(image)}`,
    });
    if (block) {
      content.push(block);
    } else {
      content.push({
        type: "text",
        text: "This attachment could not be loaded for vision analysis.",
      });
    }
  }

  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as unknown as SDKUserMessage;
}

async function buildClaudeAttachmentBlock(image: {
  mime: string;
  url?: string;
  localPath?: string;
}): Promise<Record<string, unknown> | undefined> {
  const parsed = image.localPath
    ? {
        mediaType: image.mime,
        data: await fs.readFile(image.localPath, "base64"),
      }
    : image.url
      ? parseDataUrl(image.url)
      : undefined;
  if (!parsed) return undefined;

  if (parsed.mediaType === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: parsed.data,
      },
    };
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: parsed.mediaType,
      data: parsed.data,
    },
  };
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

interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

// The SDK result's `usage` is the run's cumulative billing usage: it re-adds the
// cached prefix (cache_read) and per-turn output on every API round-trip, so
// dividing it by a single context window overcounts wildly on multi-turn runs.
// Context occupancy is a point-in-time measure — the input side of the *last*
// request — so we read the final assistant message's usage instead.
function appendContextUsageFooter(
  text: string,
  usage?: MessageUsage,
  result?: SDKResultMessage,
): string {
  const footer = buildContextUsageFooter(usage, result);
  if (!footer) return text;
  return `${text.trim()}\n\n—\n${footer}`;
}

function buildContextUsageFooter(
  usage?: MessageUsage,
  result?: SDKResultMessage,
): string {
  if (!usage) return "";

  // Everything that occupies the context window at the end of the run: the full
  // input of the final request (fresh + cached + cache-creation) plus the tokens
  // that request generated. No cross-turn accumulation.
  const used =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens +
    usage.output_tokens;
  if (used <= 0) return "";

  const limits = Object.values(result?.modelUsage || {})
    .map((model) => model.contextWindow)
    .filter((limit) => Number.isFinite(limit) && limit > 0);
  const limit = limits.length > 0 ? Math.max(...limits) : undefined;
  if (limit) {
    const pct = Math.round((used / limit) * 100);
    return `Context: ${formatTokenCount(used)} / ${formatTokenCount(limit)} tokens (${pct}%)`;
  }
  return `Context: ${formatTokenCount(used)} tokens`;
}

function extractAssistantUsage(message: SDKMessage): MessageUsage | undefined {
  if (message.type !== "assistant") return undefined;
  const usage = message.message.usage;
  if (!usage) return undefined;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(1)}K`;
}

function extractPermissionPattern(toolName: string, input: unknown): string {
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

// Only read-only file tools are auto-approved inside the workspace — enough for
// the agent to inspect staged image attachments and its own notes without a
// prompt. Mutating tools (Write/Edit/MultiEdit) still require explicit
// permission so a run can't silently overwrite workspace files.
const WORKSPACE_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

function isWorkspaceReadTool(
  toolName: string,
  input: unknown,
  workspaceDir: string,
): boolean {
  if (!WORKSPACE_READ_TOOLS.has(toolName)) return false;
  if (!input || typeof input !== "object") return false;

  const record = input as Record<string, unknown>;
  const rawPath =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : undefined;

  if (!rawPath) {
    return toolName === "Glob" || toolName === "Grep";
  }

  return isPathInside(rawPath, workspaceDir);
}

function isPathInside(rawPath: string, workspaceDir: string): boolean {
  const workspace = path.resolve(workspaceDir);
  const target = path.resolve(workspace, rawPath);
  const relative = path.relative(workspace, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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

    const optionLabels = new Set(
      question.options.map((option) => option.label),
    );
    if (
      !freeTextResponse &&
      answerList.some((item) => !optionLabels.has(item))
    ) {
      freeTextResponse = joined;
    }
  });

  return {
    answers: mapped,
    ...(freeTextResponse ? { response: freeTextResponse } : {}),
  };
}
