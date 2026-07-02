import path from "node:path";

import dotenv from "dotenv";

import type { AppConfig } from "./types.js";

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseModel(
  raw?: string,
): { providerID: string; modelID: string } | undefined {
  if (!raw?.trim()) return undefined;
  const slash = raw.indexOf("/");
  if (slash <= 0)
    throw new Error(`OPENCODE_MODEL must be "provider/modelid", got: ${raw}`);
  return {
    providerID: raw.slice(0, slash).trim(),
    modelID: raw.slice(slash + 1).trim(),
  };
}

export function loadConfig(): AppConfig {
  return {
    opencodeBaseUrl: required("OPENCODE_BASE_URL"),
    opencodeServerUsername:
      process.env.OPENCODE_SERVER_USERNAME?.trim() || undefined,
    opencodeServerPassword:
      process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    stateFile:
      process.env.STATE_FILE?.trim() || path.join(".data", "state.json"),
    publicActivityDir:
      process.env.PUBLIC_ACTIVITY_DIR?.trim() ||
      path.join(".data", "public-activity"),
    publicActivitySyncUrl:
      process.env.PUBLIC_ACTIVITY_SYNC_URL?.trim() || undefined,
    publicActivitySyncToken:
      process.env.PUBLIC_ACTIVITY_SYNC_TOKEN?.trim() || undefined,
    publicActivityHeartbeatMs:
      Number(process.env.PUBLIC_ACTIVITY_HEARTBEAT_MS) || 60000,
    publicActivitySyncTimeoutMs:
      Number(process.env.PUBLIC_ACTIVITY_SYNC_TIMEOUT_MS) || 10000,
    agentInboxEmail:
      process.env.AGENT_INBOX_EMAIL?.trim() ||
      process.env.GMAIL_TO?.trim() ||
      undefined,
    userEmail:
      process.env.USER_EMAIL?.trim() ||
      process.env.SCHEDULED_RESULTS_TO?.trim() ||
      undefined,
    gmailTo: process.env.GMAIL_TO?.trim() || undefined,
    scheduledResultsTo:
      process.env.SCHEDULED_RESULTS_TO?.trim() || undefined,
    gmailPollIntervalMs: Number(process.env.GMAIL_POLL_INTERVAL_MS) || 10000,
    gmailNewerThan: process.env.GMAIL_NEWER_THAN?.trim() || "3d",
    opencodeModel: parseModel(process.env.OPENCODE_MODEL),
    opencodeModelFallback: parseModel(process.env.OPENCODE_MODEL_FALLBACK),
    userTimezone: process.env.USER_TIMEZONE?.trim() || "UTC",
    schedulerApiPort: Number(process.env.SCHEDULER_API_PORT) || 4097,
    schedulerMaxTasks: Number(process.env.SCHEDULER_MAX_TASKS) || 20,
    schedulerMinIntervalMinutes:
      Number(process.env.SCHEDULER_MIN_INTERVAL_MINUTES) || 5,
    publicActivityMaxEvents:
      Number(process.env.PUBLIC_ACTIVITY_MAX_EVENTS) || 100,
    deployCommitSha: process.env.DEPLOY_COMMIT_SHA?.trim() || undefined,
    deployCommitMessage: process.env.DEPLOY_COMMIT_MESSAGE?.trim() || undefined,
    deployRunId: process.env.DEPLOY_RUN_ID?.trim() || undefined,
    deployActor: process.env.DEPLOY_ACTOR?.trim() || undefined,
    deployedAt: process.env.DEPLOYED_AT?.trim() || undefined,
  };
}
