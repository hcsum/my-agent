import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ATTACHMENT_ROOT = path.join(".data", "gmail-attachments");

// Staged bytes are only needed while the run that received them is in flight, so
// anything older than this is dead weight. Swept opportunistically on stage so
// a long-running process doesn't accumulate every image it has ever received.
const STAGE_TTL_MS = Number(process.env.GMAIL_ATTACHMENT_TTL_MS) || 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAtMs = 0;

export interface StagedAttachment {
  localPath: string;
  size: number;
}

export async function stageInboundAttachment(params: {
  messageId: string;
  filename: string;
  content: Buffer;
}): Promise<StagedAttachment> {
  const messageDir =
    safeSegment(params.messageId) || `message-${shortHash(params.messageId)}`;
  const filename = safeSegment(params.filename) || "attachment";
  const root = path.resolve(ATTACHMENT_ROOT);
  const dir = path.resolve(root, messageDir);

  await ensureContainedDirectory(root);
  await pruneStaleAttachments(root);
  await ensureContainedDirectory(dir, root);

  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  const digest = shortHash(params.content);
  const targetName = `${base}-${digest}${ext}`;
  const targetPath = path.resolve(dir, targetName);
  ensurePathInside(targetPath, dir);

  try {
    await fs.writeFile(targetPath, params.content, { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }

  return {
    localPath: targetPath,
    size: params.content.byteLength,
  };
}

// Best-effort sweep of message directories whose most recent file predates the
// TTL. Throttled so back-to-back attachments in one poll don't each rescan, and
// fully swallowed on error — pruning must never block staging a live message.
async function pruneStaleAttachments(root: string): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return;
  lastPruneAtMs = now;

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        const dir = path.resolve(root, entry.name);
        try {
          const stat = await fs.stat(dir);
          if (now - stat.mtimeMs < STAGE_TTL_MS) return;
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // Ignore per-directory failures; the next sweep retries.
        }
      }),
    );
  } catch {
    // Root may not exist yet or be unreadable; nothing to prune.
  }
}

function shortHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeSegment(raw: string): string {
  const basename = path.basename(raw || "attachment");
  return basename
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function ensureContainedDirectory(
  dir: string,
  parent?: string,
): Promise<void> {
  if (parent) ensurePathInside(dir, parent);
  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe attachment directory: ${dir}`);
  }
}

function ensurePathInside(candidate: string, parent: string): void {
  const relative = path.relative(parent, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Attachment path escapes root: ${candidate}`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
