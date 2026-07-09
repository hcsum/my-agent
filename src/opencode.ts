import {
  createOpencodeClient as createV1OpencodeClient,
} from "@opencode-ai/sdk/client";
import {
  createOpencodeClient as createV2OpencodeClient,
} from "@opencode-ai/sdk/v2/client";

import type { AppConfig, PersistedState, ThreadRunStatus } from "./types.js";
import {
  OpencodeRuntime,
  type GmailRunRequest,
  type PermissionResponse,
  type RuntimeCallbacks,
} from "./opencode-runtime.js";
import type { PublicEventPublisher } from "./public-activity.js";
import { StateStore } from "./state.js";

interface PromptPart {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

interface SessionRecord {
  id: string;
}

interface ApiResult<T> {
  data?: T;
  error?: unknown;
}

interface PromptResponse {
  parts?: PromptPart[];
  info?: {
    error?: unknown;
    providerID?: string;
    modelID?: string;
  };
}

export interface TurnInput {
  text: string;
  senderName: string;
  chatTitle?: string;
  timestamp: Date;
  sessionKey?: string;
  sessionTitle?: string;
  sessionDirectory?: string;
}

const CHANNEL_SESSION_TITLES: Record<string, string> = {
  gmail: "Gmail Andy",
};

export class OpencodeSession {
  private readonly client;
  private readonly runtimeClient;
  private readonly runtime: OpencodeRuntime;
  private readonly stateStore: StateStore;
  private readonly sessionPromises = new Map<string, Promise<string>>();
  private stateCache?: PersistedState;

  constructor(
    private readonly config: AppConfig,
    publicActivity: PublicEventPublisher,
  ) {
    const fetch = this.buildFetch();
    this.client = createV1OpencodeClient({
      baseUrl: config.opencodeBaseUrl,
      fetch,
    });
    this.runtimeClient = createV2OpencodeClient({
      baseUrl: config.opencodeBaseUrl,
      fetch,
    });
    this.runtime = new OpencodeRuntime(
      this.runtimeClient,
      config,
      this,
      publicActivity,
    );
    this.stateStore = new StateStore(config.stateFile);
  }

  async healthcheck(): Promise<void> {
    const sessions = await this.unwrap<Array<SessionRecord>>(
      this.client.session.list(),
    );
    console.log(`[opencode] connected; visibleSessions=${sessions.length}`);
  }

  startBackgroundMonitoring(): void {
    this.runtime.startBackgroundMonitoring();
  }

  async sendTurn(channel: string, input: TurnInput): Promise<string> {
    const sessionKey = input.sessionKey || channel;
    try {
      return await this.doSendTurn(channel, input);
    } catch (err) {
      if (!isSessionNotFound(err)) throw err;
      await this.invalidateSession(sessionKey);
      return this.doSendTurn(channel, input);
    }
  }

  async startGmailRun(
    request: GmailRunRequest,
    callbacks: RuntimeCallbacks,
  ): Promise<{ started: boolean; status: ThreadRunStatus }> {
    return this.runtime.startRun(request, callbacks);
  }

  async resumeGmailRun(
    threadId: string,
    callbacks: RuntimeCallbacks,
  ): Promise<boolean> {
    return this.runtime.resumeRun(threadId, callbacks);
  }

  hasActiveGmailRun(threadId: string): boolean {
    return this.runtime.hasActiveRun(threadId);
  }

  async replyPermission(
    threadId: string,
    permissionId: string,
    response: PermissionResponse,
    callbacks: RuntimeCallbacks,
  ): Promise<void> {
    await this.runtime.replyPermission(
      threadId,
      permissionId,
      response,
      callbacks,
    );
  }

  async replyQuestion(
    threadId: string,
    questionId: string,
    answers: string[][],
    callbacks: RuntimeCallbacks,
  ): Promise<void> {
    await this.runtime.replyQuestion(threadId, questionId, answers, callbacks);
  }

  async invalidateSession(sessionKey: string): Promise<void> {
    this.sessionPromises.delete(sessionKey);
    const state = await this.loadState();
    const sessions = { ...(state.sessions || {}) };
    const staleId = sessions[sessionKey];
    delete sessions[sessionKey];
    this.stateCache = undefined;
    await this.saveState({ ...state, sessions });
    console.log(
      `[opencode] invalidated stale session ${staleId} for ${sessionKey}, will create new`,
    );
  }

  async getOrCreateSessionId(request: {
    channel: string;
    sessionKey: string;
    sessionTitle: string;
    sessionDirectory?: string;
  }): Promise<string> {
    return this.resolveSessionId({
      channel: request.channel,
      sessionKey: request.sessionKey,
      sessionTitle: request.sessionTitle,
      sessionDirectory: request.sessionDirectory,
    });
  }

  private async doSendTurn(channel: string, input: TurnInput): Promise<string> {
    const sessionId = await this.resolveSessionId({
      channel,
      sessionKey: input.sessionKey || channel,
      sessionTitle:
        input.sessionTitle ||
        CHANNEL_SESSION_TITLES[channel] ||
        `${channel} Andy`,
      sessionDirectory: input.sessionDirectory,
    });
    const body = buildPromptBody(channel, input);

    const response = await this.unwrap<PromptResponse>(
      this.client.session.prompt({
        path: { id: sessionId },
        body: {
          ...(this.config.opencodeModel
            ? { model: this.config.opencodeModel }
            : {}),
          parts: [{ type: "text", text: body }],
        },
      }),
    );

    if (response.info?.error) {
      throw new Error(extractErrorMessage(response.info.error));
    }
    logUsedModel(response.info);

    return extractText(response.parts) || "No response text returned.";
  }

  private async resolveSessionId(request: {
    channel: string;
    sessionKey: string;
    sessionTitle: string;
    sessionDirectory?: string;
  }): Promise<string> {
    let promise = this.sessionPromises.get(request.sessionKey);
    if (!promise) {
      promise = this.loadOrCreateSessionId(request);
      this.sessionPromises.set(request.sessionKey, promise);
    }
    return promise;
  }

  private async loadOrCreateSessionId(request: {
    channel: string;
    sessionKey: string;
    sessionTitle: string;
    sessionDirectory?: string;
  }): Promise<string> {
    const state = await this.loadState();
    const sessions = state.sessions || {};

    if (sessions[request.sessionKey]) {
      console.log(
        `[opencode] reusing ${request.sessionKey} session ${sessions[request.sessionKey]}`,
      );
      return sessions[request.sessionKey];
    }

    const session = await this.unwrap<SessionRecord>(
      this.client.session.create({
        query: request.sessionDirectory
          ? { directory: request.sessionDirectory }
          : undefined,
        body: { title: request.sessionTitle },
      }),
    );

    sessions[request.sessionKey] = session.id;
    await this.saveState({ ...state, sessions });
    console.log(`[opencode] created ${request.sessionKey} session ${session.id}`);
    return session.id;
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

  private async unwrap<T>(promise: Promise<ApiResult<T>>): Promise<T> {
    const result = await this.ensureSuccess(promise);
    if (result.data === undefined) {
      throw new Error("OpenCode request returned no data");
    }
    return result.data;
  }

  private async ensureSuccess<T>(
    promise: Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    const result = await promise;
    if (result.error) {
      throw new Error(extractErrorMessage(result.error));
    }
    return result;
  }

  private buildFetch(): typeof fetch {
    const authHeader = buildBasicAuthHeader(
      this.config.opencodeServerUsername,
      this.config.opencodeServerPassword,
    );

    return async (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      if (authHeader) {
        headers.set("authorization", authHeader);
      }

      return fetch(
        new Request(request, {
          headers,
        }),
      );
    };
  }
}

function buildPromptBody(channel: string, input: TurnInput): string {
  const label = channel.charAt(0).toUpperCase() + channel.slice(1);
  const lines = [
    `${label} message`,
    `Sender: ${input.senderName}`,
    `Chat: ${input.chatTitle || "Direct chat"}`,
    `Timestamp: ${input.timestamp.toISOString()}`,
    "",
    input.text.trim(),
  ];

  return lines.join("\n");
}

function extractText(parts: PromptPart[] | undefined): string {
  if (!parts || parts.length === 0) return "";

  return parts
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
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

function extractErrorMessage(error: unknown): string {
  if (!error) return "OpenCode request failed";
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.data === "object" && e.data !== null) {
      const d = e.data as Record<string, unknown>;
      if (typeof d.message === "string") return d.message;
    }
  }
  return "OpenCode request failed";
}

function isSessionNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("Session not found");
}

function logUsedModel(info: PromptResponse["info"] | undefined): void {
  const provider = info?.providerID?.trim();
  const model = info?.modelID?.trim();
  if (!provider || !model) {
    console.log("[opencode] model used: unknown (provider/model not returned)");
    return;
  }
  console.log(`[opencode] model used: ${provider}/${model}`);
}
