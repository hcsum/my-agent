import type {
  GmailRunRequest,
  PermissionResponse,
  RuntimeCallbacks,
} from "../opencode-runtime.js";
import type { PublicEventPublisher } from "../public-activity.js";
import type { AppConfig, ThreadRunStatus, TurnInput } from "../types.js";

export type AgentRunRequest = GmailRunRequest;
export type AgentPermissionResponse = PermissionResponse;
export type AgentRuntimeCallbacks = RuntimeCallbacks;

export interface AgentRunStartResult {
  started: boolean;
  status: ThreadRunStatus;
  sessionId?: string;
}

export interface AgentProvider {
  healthcheck(): Promise<void>;
  startBackgroundMonitoring(): void;
  sendTurn(channel: string, input: TurnInput): Promise<string>;
  startRun(
    request: AgentRunRequest,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<AgentRunStartResult>;
  resumeRun(threadId: string, callbacks: AgentRuntimeCallbacks): Promise<boolean>;
  hasActiveRun(threadId: string): boolean;
  replyPermission(
    threadId: string,
    permissionId: string,
    response: AgentPermissionResponse,
    callbacks: AgentRuntimeCallbacks,
  ): Promise<void>;
  replyQuestion(
    threadId: string,
    questionId: string,
    answers: string[][],
    callbacks: AgentRuntimeCallbacks,
  ): Promise<void>;
  invalidateSession(sessionKey: string): Promise<void>;
}

export interface ProviderFactoryArgs {
  config: AppConfig;
  publicActivity: PublicEventPublisher;
}
