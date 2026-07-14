import fs from "node:fs";
import path from "node:path";

import {
  createWorkflowJob,
  updateWorkflowJobStatus,
} from "./db.js";
import {
  captureWikiSnapshot,
  validateIngestResult,
} from "./ingest-validator.js";
import { AppOrchestrator } from "./app/orchestrator.js";
import {
  buildPublicTaskContext,
  type PublicEventPublisher,
  type PublicTaskContext,
} from "./public-activity.js";
import { SerialQueue } from "./queue.js";
import type {
  IngestLanguageMode,
  TurnInput,
  WorkflowCommand,
  WorkflowJobKind,
} from "./types.js";

const COMMAND_PATTERN = /^\/(?:kb|wiki)\s+(ingest|query|lint)\b([\s\S]*)$/i;
const WORKSPACE_ROOT = process.cwd();
const KNOWLEDGE_SCHEMA_ROOT = path.join(WORKSPACE_ROOT, "notes", "knowledge", "schema");
const DEFAULT_INGEST_LANGUAGE_MODE: IngestLanguageMode = "source-original-wiki-zh";

interface WorkflowRequest {
  command: WorkflowCommand;
  sourceChannel: string;
  sourceSession: string;
  senderName: string;
  chatTitle?: string;
  timestamp: Date;
  publicTask?: PublicTaskContext;
}

export class WorkflowRunner {
  constructor(
    private readonly orchestrator: AppOrchestrator,
    private readonly queue: SerialQueue,
    private readonly publicActivity?: PublicEventPublisher,
  ) {}

  parse(text: string): WorkflowCommand | null {
    const trimmed = text.trim();
    const match = trimmed.match(COMMAND_PATTERN);
    if (!match) return null;

    const kind = match[1].toLowerCase() as WorkflowJobKind;
    const parsedTarget = match[2].trim();
    const parsedIngest = kind === "ingest" ? parseIngestTarget(parsedTarget) : undefined;
    const target = parsedIngest?.target || parsedTarget;

    const command: WorkflowCommand = {
      kind,
      target,
      rawText: trimmed,
      ...(parsedIngest ? { ingestLanguageMode: parsedIngest.ingestLanguageMode } : {}),
    };

    if (kind === "ingest") {
      command.resolvedTarget = resolveIngestTarget(target);
    }

    return command;
  }

  async run(request: WorkflowRequest): Promise<string> {
    if (!request.command.target && request.command.kind !== "lint") {
      return this.usage(request.command.kind);
    }

    if (request.command.kind === "ingest" && !request.command.resolvedTarget) {
      return [
        `Ingest target not found: ${request.command.target}`,
        "Provide an existing local file or directory path relative to the workspace root or as an absolute path.",
      ].join("\n");
    }

    const jobId = createWorkflowJob({
      kind: request.command.kind,
      sourceChannel: request.sourceChannel,
      sourceSession: request.sourceSession,
      triggerText: request.command.rawText,
      target: request.command.resolvedTarget || request.command.target,
    });

    const label = `workflow#${jobId} ${request.command.kind}`;
    const publicTask =
      request.publicTask ||
      buildPublicTaskContext({
        activityKey: `workflow:${jobId}`,
        source: "workflow",
        workflowKind: request.command.kind,
        subject: request.chatTitle,
        textBody: request.command.rawText,
      });

    try {
      return await this.queue.enqueue(label, async () => {
        updateWorkflowJobStatus({ id: jobId, status: "running" });
        this.publicActivity?.emit({
          type: "knowledge_update_started",
          task: publicTask,
        });

        const beforeSnapshot =
          request.command.kind === "ingest" ? captureWikiSnapshot() : undefined;

        const response = await this.orchestrator.sendTurn(
          request.sourceChannel,
          buildWorkflowTurnInput(request, jobId),
        );

        const validation =
          request.command.kind === "ingest" && request.command.resolvedTarget && beforeSnapshot
            ? validateIngestResult({
                targetPath: request.command.resolvedTarget,
                before: beforeSnapshot,
                after: captureWikiSnapshot(),
              })
            : undefined;

        if (validation && !validation.passed) {
          throw new Error(
            [
              "Ingest validation failed.",
              ...validation.errors,
              ...validation.warnings.map((item) => `Warning: ${item}`),
            ].join("\n"),
          );
        }

        const finalResponse = appendValidationNotes(response, validation);

        updateWorkflowJobStatus({
          id: jobId,
          status: "completed",
          resultSummary: summarizeResult(finalResponse),
        });

        return `Workflow job #${jobId} (${request.command.kind}) completed.\n\n${finalResponse}`;
      }, publicTask);
    } catch (error) {
      updateWorkflowJobStatus({
        id: jobId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private usage(kind: WorkflowJobKind): string {
    if (kind === "ingest") {
      return "Usage: /kb ingest <source path> [--all-zh | --preserve-language]";
    }
    if (kind === "query") {
      return "Usage: /kb query <question about the wiki>";
    }
    return "Usage: /kb lint [optional scope or focus]";
  }
}

function buildWorkflowTurnInput(
  request: WorkflowRequest,
  jobId: number,
): TurnInput {
  const { command } = request;
  const titleTarget = command.resolvedTarget || command.target || "wiki";
  const targetPath = command.resolvedTarget
    ? path.relative(WORKSPACE_ROOT, command.resolvedTarget) || command.resolvedTarget
    : undefined;

  return {
    text: [
      `Workflow trigger: ${command.kind}`,
      `Job ID: ${jobId}`,
      `Trigger owner: bridge code`,
      `Requested target: ${titleTarget}`,
      ...(targetPath ? [`Workspace-relative target: ${targetPath}`] : []),
      ...(command.kind === "ingest" && command.resolvedTarget
        ? [`Resolved local path: ${command.resolvedTarget}`]
        : []),
      "",
      workflowInstruction(command),
      "",
      ...(command.kind === "ingest"
        ? [languagePolicyBlock(command.ingestLanguageMode || DEFAULT_INGEST_LANGUAGE_MODE), ""]
        : []),
      workflowGuardrails(command),
      "",
      schemaReferenceBlock(command),
      "",
      "User request:",
      command.kind === "ingest"
        ? command.resolvedTarget || command.target || command.rawText
        : command.target || command.rawText,
    ].join("\n"),
    senderName: request.senderName,
    chatTitle: request.chatTitle,
    timestamp: request.timestamp,
    sessionKey: buildWorkflowSessionKey(request, command, jobId),
    sessionTitle: buildWorkflowSessionTitle(command, targetPath, jobId),
    sessionDirectory: KNOWLEDGE_SCHEMA_ROOT,
  };
}

function workflowInstruction(command: WorkflowCommand): string {
  if (command.kind === "ingest") {
    return [
      "This workflow was explicitly triggered by code after the user requested an ingest operation.",
      "Treat the request as a source-ingest task: inspect the resolved local source path, update the persistent wiki, refresh index/log if needed, and report what pages changed.",
      "The goal is not a loose summary. The goal is a grounded wiki update that preserves source-specific frameworks, formulas, execution steps, and reusable concepts.",
      "Follow the language policy for this ingest exactly.",
      "Do not debate whether ingest should be triggered; it already has been.",
    ].join(" ");
  }

  if (command.kind === "query") {
    return [
      "This workflow was explicitly triggered by code after the user requested a wiki query.",
      "Answer from the wiki first, cite the relevant pages or files you relied on, and if the answer creates a durable artifact, you may write it back into the wiki.",
      "Do not debate whether query should be triggered; it already has been.",
    ].join(" ");
  }

  return [
    "This workflow was explicitly triggered by code after the user requested a wiki lint pass.",
    "Inspect the wiki for structural and factual health issues such as stale pages, missing cross-links, orphan pages, conflicts, or gaps, then fix or report them as appropriate.",
    "Do not debate whether lint should be triggered; it already has been.",
  ].join(" ");
}

function summarizeResult(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 280);
}

function appendValidationNotes(
  response: string,
  validation:
    | ReturnType<typeof validateIngestResult>
    | undefined,
): string {
  if (!validation) {
    return response;
  }

  const notes = [
    "Validation:",
    `- ${validation.summary}`,
    ...validation.warnings.map((item) => `- Warning: ${item}`),
  ].join("\n");

  return [response.trim(), notes].filter(Boolean).join("\n\n");
}

function languagePolicyBlock(mode: IngestLanguageMode): string {
  if (mode === "all-zh") {
    return [
      "Language policy:",
      "- Write source pages, concept pages, synthesis pages, and reports in Chinese.",
      "- Preserve important original-language terms inline when translation would blur meaning.",
    ].join("\n");
  }

  if (mode === "preserve-language") {
    return [
      "Language policy:",
      "- Keep source pages and all derived wiki pages in the same language as the source unless a term must stay bilingual for clarity.",
    ].join("\n");
  }

  return [
    "Language policy:",
    "- Keep source pages in the same language as the source by default.",
    "- Write concept pages, synthesis pages, and reports in Chinese by default.",
    "- Preserve important original-language terms inline when translation would blur meaning.",
  ].join("\n");
}

function workflowGuardrails(command: WorkflowCommand): string {
  if (command.kind === "ingest") {
    return [
      "Ingest guardrails:",
      "- Ground every source-derived page in the referenced source only.",
      "- For source pages, do not introduce facts, preferences, or conclusions that are not supportable from the referenced source itself.",
      "- Source pages should preserve concrete structures from the source such as formulas, named frameworks, step lists, risk notes, and decision rules.",
      "- Create concept pages when the source contains named or clearly reusable concepts that are likely to matter beyond this one source.",
      "- Do not create a synthesis page by default for every ingest. Create one only when the source supports a real higher-level operating model, comparison, or cross-cutting takeaway worth keeping separately.",
      "- If you do create a synthesis page from a single source, keep it tightly anchored to that source and avoid broad personalization or unsupported strategic extrapolation.",
      "- Prefer a small number of strong pages over a larger number of shallow pages.",
      "- Synthesis pages may generalize, but every major claim must still be supportable by the source page(s).",
      "- Before finishing, re-read the pages you wrote and verify they are more than generic summaries.",
    ].join("\n");
  }

  if (command.kind === "query") {
    return [
      "Query guardrails:",
      "- Prefer grounded answers over broad generalization.",
      "- Cite the wiki pages or raw sources used.",
    ].join("\n");
  }

  return [
    "Lint guardrails:",
    "- Focus on concrete, verifiable issues in the current wiki.",
    "- Distinguish between structural issues and factual uncertainty.",
  ].join("\n");
}

function schemaReferenceBlock(command: WorkflowCommand): string {
  const references = [
    command.kind === "ingest" ? readSchemaSnippet("page-types.md") : "",
    readSchemaSnippet("workflows.md"),
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!references) {
    return "Schema references: notes/knowledge/schema/ files are available in the repo and should be followed.";
  }

  return [`Schema references:`, references].join("\n");
}

function readSchemaSnippet(fileName: string): string {
  const filePath = path.join(KNOWLEDGE_SCHEMA_ROOT, fileName);
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return "";
    return [`--- ${fileName} ---`, raw].join("\n");
  } catch {
    return "";
  }
}

function buildWorkflowSessionKey(
  request: WorkflowRequest,
  command: WorkflowCommand,
  jobId: number,
): string {
  if (command.kind === "ingest") {
    return `${request.sourceChannel}:${request.sourceSession}:workflow:${command.kind}:job:${jobId}`;
  }

  return `${request.sourceChannel}:${request.sourceSession}:workflow:${command.kind}`;
}

function buildWorkflowSessionTitle(
  command: WorkflowCommand,
  targetPath: string | undefined,
  jobId: number,
): string {
  if (command.kind === "ingest") {
    const name = targetPath ? path.basename(targetPath) : `job-${jobId}`;
    return `Workflow ingest ${name}`;
  }

  return `Workflow ${command.kind}`;
}

function resolveIngestTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;

  const candidate = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(WORKSPACE_ROOT, trimmed);

  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile() && !stat.isDirectory()) {
      return undefined;
    }
    return candidate;
  } catch {
    return undefined;
  }
}

function parseIngestTarget(raw: string): {
  target: string;
  ingestLanguageMode: IngestLanguageMode;
} {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  let ingestLanguageMode = DEFAULT_INGEST_LANGUAGE_MODE;

  for (const token of tokens) {
    if (token === "--all-zh") {
      ingestLanguageMode = "all-zh";
      continue;
    }
    if (token === "--preserve-language") {
      ingestLanguageMode = "preserve-language";
      continue;
    }
    kept.push(token);
  }

  return {
    target: kept.join(" ").trim(),
    ingestLanguageMode,
  };
}
