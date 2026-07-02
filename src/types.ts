export interface AppConfig {
  opencodeBaseUrl: string;
  opencodeServerUsername?: string;
  opencodeServerPassword?: string;
  stateFile: string;
  publicActivityDir: string;
  publicActivitySyncUrl?: string;
  publicActivitySyncToken?: string;
  publicActivityHeartbeatMs: number;
  publicActivitySyncTimeoutMs: number;
  agentInboxEmail?: string;
  userEmail?: string;
  gmailTo?: string;
  scheduledResultsTo?: string;
  gmailPollIntervalMs: number;
  gmailNewerThan: string;
  opencodeModel?: { providerID: string; modelID: string };
  opencodeModelFallback?: { providerID: string; modelID: string };
  userTimezone: string;
  schedulerApiPort: number;
  schedulerMaxTasks: number;
  schedulerMinIntervalMinutes: number;
  publicActivityMaxEvents: number;
  deployCommitSha?: string;
  deployCommitMessage?: string;
  deployRunId?: string;
  deployActor?: string;
  deployedAt?: string;
}

export type WorkflowJobKind = "ingest" | "query" | "lint";

export type ThreadRunStatus =
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "completed"
  | "failed";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export type IngestLanguageMode = "source-original-wiki-zh" | "all-zh" | "preserve-language";

export type WorkflowJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface WorkflowCommand {
  kind: WorkflowJobKind;
  target: string;
  rawText: string;
  resolvedTarget?: string;
  ingestLanguageMode?: IngestLanguageMode;
}

export interface PersistedState {
  sessions?: Record<string, string>;
  updatedAt?: string;
}

export interface QueueJob<T> {
  label: string;
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}
