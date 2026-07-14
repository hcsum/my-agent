#!/usr/bin/env bash

set -euo pipefail

DB_PATH="${1:-.data/gmail.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "database not found: $DB_PATH" >&2
  exit 1
fi

echo "Clearing transient email bridge state from: $DB_PATH"
echo "Preserving: scheduled_tasks, scheduled_report_history"
echo
echo "Before:"
sqlite3 "$DB_PATH" "
  SELECT 'processed_messages', count(*) FROM processed_messages
  UNION ALL
  SELECT 'message_claims', count(*) FROM message_claims
  UNION ALL
  SELECT 'thread_runs', count(*) FROM thread_runs
  UNION ALL
  SELECT 'thread_failures', count(*) FROM thread_failures
  UNION ALL
  SELECT 'thread_session_links', count(*) FROM thread_session_links
  UNION ALL
  SELECT 'outbound_emails', count(*) FROM outbound_emails
  UNION ALL
  SELECT 'pending_permissions', count(*) FROM pending_permissions
  UNION ALL
  SELECT 'pending_questions', count(*) FROM pending_questions
  UNION ALL
  SELECT 'workflow_jobs', count(*) FROM workflow_jobs
  UNION ALL
  SELECT 'scheduled_tasks', count(*) FROM scheduled_tasks
  UNION ALL
  SELECT 'scheduled_report_history', count(*) FROM scheduled_report_history;
"

sqlite3 "$DB_PATH" "
  BEGIN IMMEDIATE;
  DELETE FROM message_claims;
  DELETE FROM processed_messages;
  DELETE FROM thread_runs;
  DELETE FROM thread_failures;
  DELETE FROM pending_permissions;
  DELETE FROM pending_questions;
  DELETE FROM thread_session_links;
  DELETE FROM outbound_emails;
  DELETE FROM workflow_jobs;
  COMMIT;
"

echo
echo "After:"
sqlite3 "$DB_PATH" "
  SELECT 'processed_messages', count(*) FROM processed_messages
  UNION ALL
  SELECT 'message_claims', count(*) FROM message_claims
  UNION ALL
  SELECT 'thread_runs', count(*) FROM thread_runs
  UNION ALL
  SELECT 'thread_failures', count(*) FROM thread_failures
  UNION ALL
  SELECT 'thread_session_links', count(*) FROM thread_session_links
  UNION ALL
  SELECT 'outbound_emails', count(*) FROM outbound_emails
  UNION ALL
  SELECT 'pending_permissions', count(*) FROM pending_permissions
  UNION ALL
  SELECT 'pending_questions', count(*) FROM pending_questions
  UNION ALL
  SELECT 'workflow_jobs', count(*) FROM workflow_jobs
  UNION ALL
  SELECT 'scheduled_tasks', count(*) FROM scheduled_tasks
  UNION ALL
  SELECT 'scheduled_report_history', count(*) FROM scheduled_report_history;
"
