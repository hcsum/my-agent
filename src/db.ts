import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import type {
  QuestionPrompt,
  ThreadRunStatus,
  WorkflowJobKind,
  WorkflowJobStatus,
} from "./types.js";

const DB_DIR = ".data";
const DB_PATH = path.join(DB_DIR, "gmail.db");
const CLAIM_TTL_MS = 15 * 60 * 1000;

let db: BetterSqlite3.Database;

export interface PendingPermissionRecord {
  threadId: string;
  sessionId: string;
  permissionId: string;
  messageId: string;
  title: string;
  type: string;
  pattern: string;
}

export interface PendingQuestionRecord {
  threadId: string;
  sessionId: string;
  questionId: string;
  messageId: string;
  questions: QuestionPrompt[];
}

export interface ThreadRunRecord {
  threadId: string;
  sourceChannel: string;
  sessionKey: string;
  sessionId: string;
  sessionTitle: string;
  gmailMessageId: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  rfcMessageId: string;
  lastUserText: string;
  status: ThreadRunStatus;
  lastError: string;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface OutboundEmailRecord {
  deliveryKind: "thread_reply" | "scheduled_result";
  threadId: string;
  gmailThreadId: string;
  gmailMessageId: string;
  recipientEmail: string;
  subject: string;
  replyToRfcMessageId: string;
  status: "sent" | "failed";
  error: string;
}

export interface ThreadSessionLink {
  canonicalThreadId: string;
  sessionKey: string;
  sessionTitle: string;
}

export function initDatabase(): void {
  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new BetterSqlite3(DB_PATH);
  db.pragma("journal_mode = WAL");
  createSchema();
  runMigrations();
}

export function getDatabase(): BetterSqlite3.Database {
  if (!db) {
    throw new Error("Database not initialized; call initDatabase() first");
  }
  return db;
}

export function isProcessed(gmailMessageId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM processed_messages WHERE gmail_message_id = ?")
    .get(gmailMessageId);
  return !!row;
}

export function tryClaimMessage(gmailMessageId: string): boolean {
  const now = Date.now();
  db.prepare("DELETE FROM message_claims WHERE claimed_at_ms < ?").run(
    now - CLAIM_TTL_MS,
  );

  const result = db
    .prepare(
      "INSERT OR IGNORE INTO message_claims (gmail_message_id, claimed_at_ms) VALUES (?, ?)",
    )
    .run(gmailMessageId, now);

  return result.changes > 0;
}

export function releaseClaim(gmailMessageId: string): void {
  db.prepare("DELETE FROM message_claims WHERE gmail_message_id = ?").run(
    gmailMessageId,
  );
}

export function refreshClaim(gmailMessageId: string): void {
  db.prepare(
    "UPDATE message_claims SET claimed_at_ms = ? WHERE gmail_message_id = ?",
  ).run(Date.now(), gmailMessageId);
}

export function markProcessed(
  gmailMessageId: string,
  threadId: string,
  subject: string,
  sender: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO processed_messages (gmail_message_id, thread_id, subject, sender) VALUES (?, ?, ?, ?)",
  ).run(gmailMessageId, threadId, subject, sender);

  releaseClaim(gmailMessageId);
}

export function recordOutboundEmail(email: OutboundEmailRecord): void {
  db.prepare(
    `INSERT INTO outbound_emails (
       delivery_kind,
       thread_id,
       gmail_thread_id,
       gmail_message_id,
       recipient_email,
       subject,
       reply_to_rfc_message_id,
       status,
       error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    email.deliveryKind,
    email.threadId,
    email.gmailThreadId,
    email.gmailMessageId,
    email.recipientEmail,
    email.subject,
    email.replyToRfcMessageId,
    email.status,
    email.error,
  );
}

// Bind an outbound Gmail thread to an OpenCode sessionKey so a later inbound
// reply on that thread continues the same session instead of spawning a fresh
// `gmail:<threadId>` one. Used to make scheduled-result emails behave like a
// user-triggered thread once the user replies.
export function upsertThreadSessionLink(params: {
  gmailThreadId: string;
  canonicalThreadId?: string;
  sessionKey: string;
  sessionTitle: string;
}): void {
  db.prepare(
    `INSERT INTO thread_session_links (
       gmail_thread_id,
       canonical_thread_id,
       session_key,
       session_title,
       updated_at_ms,
       created_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(gmail_thread_id) DO UPDATE SET
       canonical_thread_id = excluded.canonical_thread_id,
       session_key = excluded.session_key,
       session_title = excluded.session_title,
       updated_at_ms = excluded.updated_at_ms,
       created_at = datetime('now')`,
  ).run(
    params.gmailThreadId,
    params.canonicalThreadId || params.gmailThreadId,
    params.sessionKey,
    params.sessionTitle,
    Date.now(),
  );
}

export function getThreadSessionLink(
  gmailThreadId: string,
): ThreadSessionLink | undefined {
  const row = db
    .prepare(
      `SELECT canonical_thread_id, session_key, session_title
       FROM thread_session_links
       WHERE gmail_thread_id = ?`,
    )
    .get(gmailThreadId) as
    | {
        canonical_thread_id: string;
        session_key: string;
        session_title: string;
      }
    | undefined;

  if (!row) return undefined;

  return {
    canonicalThreadId: row.canonical_thread_id || gmailThreadId,
    sessionKey: row.session_key,
    sessionTitle: row.session_title,
  };
}

export function getLatestGmailThreadIdForCanonicalThread(
  canonicalThreadId: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT gmail_thread_id
       FROM thread_session_links
       WHERE canonical_thread_id = ?
       ORDER BY updated_at_ms DESC, created_at DESC
       LIMIT 1`,
    )
    .get(canonicalThreadId) as { gmail_thread_id: string } | undefined;

  return row?.gmail_thread_id;
}

export function getPendingPermission(
  threadId: string,
): PendingPermissionRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         thread_id,
         session_id,
         permission_id,
         message_id,
         title,
         type,
         pattern
       FROM pending_permissions
       WHERE thread_id = ?`,
    )
    .get(threadId) as
    | {
        thread_id: string;
        session_id: string;
        permission_id: string;
        message_id: string;
        title: string;
        type: string;
        pattern: string;
      }
    | undefined;

  if (!row) return undefined;

  return {
    threadId: row.thread_id,
    sessionId: row.session_id,
    permissionId: row.permission_id,
    messageId: row.message_id,
    title: row.title,
    type: row.type,
    pattern: row.pattern,
  };
}

export function upsertPendingPermission(
  permission: PendingPermissionRecord,
): void {
  db.prepare(
    `INSERT INTO pending_permissions (
       thread_id,
       session_id,
       permission_id,
       message_id,
       title,
       type,
       pattern,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(thread_id) DO UPDATE SET
       session_id = excluded.session_id,
       permission_id = excluded.permission_id,
       message_id = excluded.message_id,
       title = excluded.title,
       type = excluded.type,
       pattern = excluded.pattern,
       updated_at = datetime('now')`,
  ).run(
    permission.threadId,
    permission.sessionId,
    permission.permissionId,
    permission.messageId,
    permission.title,
    permission.type,
    permission.pattern,
  );
}

export function clearPendingPermission(threadId: string): void {
  db.prepare("DELETE FROM pending_permissions WHERE thread_id = ?").run(threadId);
}

export function getPendingQuestion(
  threadId: string,
): PendingQuestionRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         thread_id,
         session_id,
         question_id,
         message_id,
         questions_json
       FROM pending_questions
       WHERE thread_id = ?`,
    )
    .get(threadId) as
    | {
        thread_id: string;
        session_id: string;
        question_id: string;
        message_id: string;
        questions_json: string;
      }
    | undefined;

  if (!row) return undefined;

  return {
    threadId: row.thread_id,
    sessionId: row.session_id,
    questionId: row.question_id,
    messageId: row.message_id,
    questions: parseQuestions(row.questions_json),
  };
}

export function upsertPendingQuestion(question: PendingQuestionRecord): void {
  db.prepare(
    `INSERT INTO pending_questions (
       thread_id,
       session_id,
       question_id,
       message_id,
       questions_json,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(thread_id) DO UPDATE SET
       session_id = excluded.session_id,
       question_id = excluded.question_id,
       message_id = excluded.message_id,
       questions_json = excluded.questions_json,
       updated_at = datetime('now')`,
  ).run(
    question.threadId,
    question.sessionId,
    question.questionId,
    question.messageId,
    JSON.stringify(question.questions),
  );
}

export function clearPendingQuestion(threadId: string): void {
  db.prepare("DELETE FROM pending_questions WHERE thread_id = ?").run(threadId);
}

export function getThreadRun(threadId: string): ThreadRunRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         thread_id,
         source_channel,
         session_key,
         session_id,
         session_title,
         gmail_message_id,
         sender_email,
         sender_name,
         subject,
         rfc_message_id,
         last_user_text,
         status,
         last_error,
         started_at_ms,
         updated_at_ms
       FROM thread_runs
       WHERE thread_id = ?`,
    )
    .get(threadId) as ThreadRunRow | undefined;

  return row ? mapThreadRunRow(row) : undefined;
}

// Reverse lookup used by the file-delivery endpoint: the plugin only knows the
// OpenCode sessionID, so map it back to its active thread run to find the reply
// target. Restricted to active runs so a stale completed row never captures a
// sessionID that a newer run has since reused.
export function getActiveThreadRunBySessionId(
  sessionId: string,
): ThreadRunRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         thread_id,
         source_channel,
         session_key,
         session_id,
         session_title,
         gmail_message_id,
         sender_email,
         sender_name,
         subject,
         rfc_message_id,
         last_user_text,
         status,
         last_error,
         started_at_ms,
         updated_at_ms
       FROM thread_runs
       WHERE session_id = ?
         AND status IN ('running', 'waiting_permission', 'waiting_question')
       ORDER BY updated_at_ms DESC
       LIMIT 1`,
    )
    .get(sessionId) as ThreadRunRow | undefined;

  return row ? mapThreadRunRow(row) : undefined;
}

export function listActiveThreadRuns(): ThreadRunRecord[] {
  const rows = db
    .prepare(
      `SELECT
         thread_id,
         source_channel,
         session_key,
         session_id,
         session_title,
         gmail_message_id,
         sender_email,
         sender_name,
         subject,
         rfc_message_id,
         last_user_text,
         status,
         last_error,
         started_at_ms,
         updated_at_ms
       FROM thread_runs
       WHERE status IN ('running', 'waiting_permission', 'waiting_question')
       ORDER BY updated_at_ms ASC`,
    )
    .all() as ThreadRunRow[];

  return rows.map(mapThreadRunRow);
}

export function upsertThreadRun(run: ThreadRunRecord): void {
  db.prepare(
    `INSERT INTO thread_runs (
       thread_id,
       source_channel,
       session_key,
       session_id,
       session_title,
       gmail_message_id,
       sender_email,
       sender_name,
       subject,
       rfc_message_id,
       last_user_text,
       status,
       last_error,
       started_at_ms,
       updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       source_channel = excluded.source_channel,
       session_key = excluded.session_key,
       session_id = excluded.session_id,
       session_title = excluded.session_title,
       gmail_message_id = excluded.gmail_message_id,
       sender_email = excluded.sender_email,
       sender_name = excluded.sender_name,
       subject = excluded.subject,
       rfc_message_id = excluded.rfc_message_id,
       last_user_text = excluded.last_user_text,
       status = excluded.status,
       last_error = excluded.last_error,
       started_at_ms = excluded.started_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(
    run.threadId,
    run.sourceChannel,
    run.sessionKey,
    run.sessionId,
    run.sessionTitle,
    run.gmailMessageId,
    run.senderEmail,
    run.senderName,
    run.subject,
    run.rfcMessageId,
    run.lastUserText,
    run.status,
    run.lastError,
    run.startedAtMs,
    run.updatedAtMs,
  );
}

export function updateThreadRunStatus(params: {
  threadId: string;
  status: ThreadRunStatus;
  lastError?: string;
  updatedAtMs?: number;
}): void {
  db.prepare(
    `UPDATE thread_runs
     SET status = ?, last_error = ?, updated_at_ms = ?
     WHERE thread_id = ?`,
  ).run(
    params.status,
    params.lastError || "",
    params.updatedAtMs || Date.now(),
    params.threadId,
  );
}

export function createWorkflowJob(params: {
  kind: WorkflowJobKind;
  sourceChannel: string;
  sourceSession: string;
  triggerText: string;
  target: string;
}): number {
  const result = db
    .prepare(
      `INSERT INTO workflow_jobs (
        kind,
        source_channel,
        source_session,
        trigger_text,
        target,
        status
      ) VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(
      params.kind,
      params.sourceChannel,
      params.sourceSession,
      params.triggerText,
      params.target,
    );

  return Number(result.lastInsertRowid);
}

export function updateWorkflowJobStatus(params: {
  id: number;
  status: WorkflowJobStatus;
  error?: string;
  resultSummary?: string;
}): void {
  const nowExpr = "datetime('now')";

  if (params.status === "running") {
    db.prepare(
      `UPDATE workflow_jobs
       SET status = ?, started_at = ${nowExpr}, error = NULL
       WHERE id = ?`,
    ).run(params.status, params.id);
    return;
  }

  if (params.status === "completed") {
    db.prepare(
      `UPDATE workflow_jobs
       SET status = ?, finished_at = ${nowExpr}, result_summary = ?, error = NULL
       WHERE id = ?`,
    ).run(params.status, params.resultSummary || "", params.id);
    return;
  }

  if (params.status === "failed") {
    db.prepare(
      `UPDATE workflow_jobs
       SET status = ?, finished_at = ${nowExpr}, error = ?
       WHERE id = ?`,
    ).run(params.status, params.error || "Unknown workflow failure", params.id);
    return;
  }

  db.prepare("UPDATE workflow_jobs SET status = ? WHERE id = ?").run(
    params.status,
    params.id,
  );
}

export function incrementThreadFailures(threadId: string): number {
  db.prepare(`
    INSERT INTO thread_failures (thread_id, failure_count)
    VALUES (?, 1)
    ON CONFLICT(thread_id) DO UPDATE SET
      failure_count = failure_count + 1,
      last_failed_at = datetime('now')
  `).run(threadId);
  const row = db
    .prepare("SELECT failure_count FROM thread_failures WHERE thread_id = ?")
    .get(threadId) as { failure_count: number };
  return row.failure_count;
}

export function resetThreadFailures(threadId: string): void {
  db.prepare("DELETE FROM thread_failures WHERE thread_id = ?").run(threadId);
}

interface ThreadRunRow {
  thread_id: string;
  source_channel: string;
  session_key: string;
  session_id: string;
  session_title: string;
  gmail_message_id: string;
  sender_email: string;
  sender_name: string;
  subject: string;
  rfc_message_id: string;
  last_user_text: string;
  status: ThreadRunStatus;
  last_error: string;
  started_at_ms: number;
  updated_at_ms: number;
}

function mapThreadRunRow(row: ThreadRunRow): ThreadRunRecord {
  return {
    threadId: row.thread_id,
    sourceChannel: row.source_channel,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    gmailMessageId: row.gmail_message_id,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    subject: row.subject,
    rfcMessageId: row.rfc_message_id,
    lastUserText: row.last_user_text,
    status: row.status,
    lastError: row.last_error,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function parseQuestions(raw: string): QuestionPrompt[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QuestionPrompt[]) : [];
  } catch {
    return [];
  }
}

function createSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_messages (
      gmail_message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS message_claims (
      gmail_message_id TEXT PRIMARY KEY,
      claimed_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbound_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_kind TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      gmail_thread_id TEXT NOT NULL DEFAULT '',
      gmail_message_id TEXT NOT NULL DEFAULT '',
      recipient_email TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      reply_to_rfc_message_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_session TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      result_summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_permissions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      pattern TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pending_questions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      questions_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS thread_runs (
      thread_id TEXT PRIMARY KEY,
      source_channel TEXT NOT NULL DEFAULT 'gmail',
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_title TEXT NOT NULL DEFAULT '',
      gmail_message_id TEXT NOT NULL DEFAULT '',
      sender_email TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      rfc_message_id TEXT NOT NULL DEFAULT '',
      last_user_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS thread_failures (
      thread_id TEXT PRIMARY KEY,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS thread_session_links (
      gmail_thread_id TEXT PRIMARY KEY,
      canonical_thread_id TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL,
      session_title TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('cron','once')),
      cron_expr TEXT,
      run_at TEXT,
      timezone TEXT NOT NULL,
      prompt TEXT NOT NULL,
      summary TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      next_run_at TEXT,
      last_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_status TEXT NOT NULL DEFAULT 'idle' CHECK(last_status IN ('idle','running','success','error')),
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS scheduled_report_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      fire_time TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_report_history_task
      ON scheduled_report_history(task_id, id DESC);
  `);
}

function runMigrations(): void {
  // Backfill columns on prod DBs that pre-date these fields.
  ensureColumn("pending_permissions", "title", "title TEXT NOT NULL DEFAULT ''");
  ensureColumn("pending_permissions", "type", "type TEXT NOT NULL DEFAULT ''");
  ensureColumn("pending_permissions", "pattern", "pattern TEXT NOT NULL DEFAULT ''");
  ensureColumn("pending_permissions", "updated_at", "updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
  ensureColumn("thread_runs", "source_channel", "source_channel TEXT NOT NULL DEFAULT 'gmail'");
  ensureColumn("thread_runs", "session_title", "session_title TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    "thread_session_links",
    "canonical_thread_id",
    "canonical_thread_id TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    "thread_session_links",
    "updated_at_ms",
    "updated_at_ms INTEGER NOT NULL DEFAULT 0",
  );
}

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;

  if (rows.some((row) => row.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
