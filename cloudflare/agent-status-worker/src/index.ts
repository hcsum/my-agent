const SNAPSHOT_KEY = "agent-status:snapshot";
const encoder = new TextEncoder();

type PresenceState = "online" | "stale" | "offline";

interface PublicChannelState {
  source: string;
  status: string;
  title: string;
  summary?: string;
  updatedAt: string;
  activeCount: number;
  taskType?: string;
  activityKey?: string;
}

interface PublicActivityStats {
  tasksHandled: number;
  tasksCompleted: number;
  tasksFailed: number;
}

interface PublicActivityEntry {
  id: string;
  ts: string;
  type: string;
  status: string;
  title: string;
  summary?: string;
  source?: string;
  taskType?: string;
  skillName?: string;
  durationMs?: number;
  commitSha?: string;
  commitMessage?: string;
  runId?: string;
  actor?: string;
}

interface PublicCurrentState {
  status: string;
  title: string;
  summary?: string;
  updatedAt: string;
  activeCount: number;
  stats: PublicActivityStats;
  source?: string;
  taskType?: string;
  channels?: PublicChannelState[];
}

interface PublicActivityFile {
  updatedAt: string;
  events: PublicActivityEntry[];
  meta?: {
    deploymentFingerprint?: string;
    channels?: PublicChannelState[];
  };
}

interface IngestPayload {
  sentAt: string;
  current: PublicCurrentState;
  eventsFile: PublicActivityFile;
}

interface StoredSnapshot {
  current: PublicCurrentState;
  eventsFile: PublicActivityFile;
  lastSeenAt: string;
  snapshotUpdatedAt: string;
}

interface EnrichedCurrentState extends PublicCurrentState {
  presence: PresenceState;
  lastSeenAt?: string;
  lastKnownStatus?: string;
}

interface EnrichedEventsFile extends PublicActivityFile {
  presence: PresenceState;
  lastSeenAt?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method === "POST" && url.pathname === "/ingest") {
      return handleIngest(request, env);
    }

    if (request.method === "GET" && url.pathname === "/current.json") {
      return handleCurrent(env);
    }

    if (request.method === "GET" && url.pathname === "/events.json") {
      return handleEvents(env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    return json(
      {
        error: "Not found",
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (!env.INGEST_TOKEN) {
    return json(
      {
        error: "INGEST_TOKEN is not configured",
      },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  const providedToken = extractBearerToken(authHeader);
  const isAuthorized = providedToken
    ? await verifyToken(providedToken, env.INGEST_TOKEN)
    : false;

  if (!isAuthorized) {
    return json(
      {
        error: "Unauthorized",
      },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(
      {
        error: "Invalid JSON body",
      },
      { status: 400 },
    );
  }

  if (!isIngestPayload(payload)) {
    return json(
      {
        error: "Invalid ingest payload",
      },
      { status: 400 },
    );
  }

  const existing = await readSnapshot(env);
  const snapshotAccepted =
    !existing ||
    payload.eventsFile.updatedAt >= existing.snapshotUpdatedAt;

  const nextSnapshot: StoredSnapshot = snapshotAccepted
    ? {
        current: payload.current,
        eventsFile: payload.eventsFile,
        lastSeenAt: payload.sentAt,
        snapshotUpdatedAt: payload.eventsFile.updatedAt,
      }
    : {
        ...existing,
        lastSeenAt: payload.sentAt,
      };

  await env.STATUS_KV.put(SNAPSHOT_KEY, JSON.stringify(nextSnapshot));
  return json({
    ok: true,
    snapshotAccepted,
    lastSeenAt: nextSnapshot.lastSeenAt,
    snapshotUpdatedAt: nextSnapshot.snapshotUpdatedAt,
  });
}

async function handleCurrent(env: Env): Promise<Response> {
  const snapshot = await readSnapshot(env);
  const presence = derivePresence(snapshot?.lastSeenAt, env);

  if (!snapshot) {
    return json<EnrichedCurrentState>(
      {
        status: "offline",
        title: "Agent offline",
        summary: "No public snapshot has been ingested yet.",
        updatedAt: new Date(0).toISOString(),
        activeCount: 0,
        stats: emptyStats(),
        presence,
      },
      { headers: publicJsonHeaders() },
    );
  }

  const current =
    presence === "online"
      ? {
          ...snapshot.current,
          presence,
          lastSeenAt: snapshot.lastSeenAt,
        }
      : decorateUnavailableCurrent(snapshot.current, snapshot.lastSeenAt, presence);

  return json(current, { headers: publicJsonHeaders() });
}

async function handleEvents(env: Env): Promise<Response> {
  const snapshot = await readSnapshot(env);
  const presence = derivePresence(snapshot?.lastSeenAt, env);

  const eventsFile: EnrichedEventsFile = snapshot
    ? {
        ...snapshot.eventsFile,
        events: snapshot.eventsFile.events.map((entry) => ({ ...entry })),
        presence,
        lastSeenAt: snapshot.lastSeenAt,
      }
    : {
        updatedAt: new Date(0).toISOString(),
        events: [],
        presence,
      };

  return json(eventsFile, { headers: publicJsonHeaders() });
}

async function handleHealth(env: Env): Promise<Response> {
  const snapshot = await readSnapshot(env);
  const presence = derivePresence(snapshot?.lastSeenAt, env);
  return json(
    {
      ok: presence !== "offline",
      presence,
      lastSeenAt: snapshot?.lastSeenAt,
      snapshotUpdatedAt: snapshot?.snapshotUpdatedAt,
    },
    {
      status: presence === "offline" ? 503 : 200,
      headers: publicJsonHeaders(),
    },
  );
}

async function readSnapshot(env: Env): Promise<StoredSnapshot | undefined> {
  const raw = await env.STATUS_KV.get(SNAPSHOT_KEY, "json");
  return isStoredSnapshot(raw) ? raw : undefined;
}

function derivePresence(
  lastSeenAt: string | undefined,
  env: Env,
): PresenceState {
  if (!lastSeenAt) return "offline";

  const seenAt = Date.parse(lastSeenAt);
  if (!Number.isFinite(seenAt)) return "offline";

  const now = Date.now();
  const ageMs = now - seenAt;
  const staleAfterMs = parsePositiveInt(env.STALE_AFTER_SECONDS, 90) * 1000;
  const offlineAfterMs = parsePositiveInt(env.OFFLINE_AFTER_SECONDS, 300) * 1000;

  if (ageMs >= offlineAfterMs) return "offline";
  if (ageMs >= staleAfterMs) return "stale";
  return "online";
}

function decorateUnavailableCurrent(
  current: PublicCurrentState,
  lastSeenAt: string,
  presence: Exclude<PresenceState, "online">,
): EnrichedCurrentState {
  return {
    ...current,
    status: presence,
    title: presence === "offline" ? "Agent offline" : "Agent connection stale",
    summary:
      presence === "offline"
        ? `Last heartbeat at ${lastSeenAt}.`
        : `Last heartbeat at ${lastSeenAt}; current status may be outdated.`,
    presence,
    lastSeenAt,
    lastKnownStatus: current.status,
  };
}

function extractBearerToken(header: string): string | undefined {
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

async function verifyToken(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function json<T>(
  body: T,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers,
  });
}

function publicJsonHeaders(): HeadersInit {
  const headers = corsHeaders();
  headers.set("cache-control", "no-store");
  return headers;
}

function corsHeaders(): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return headers;
}

function emptyStats(): PublicActivityStats {
  return {
    tasksHandled: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
  };
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPublicActivityStats(value: unknown): value is PublicActivityStats {
  if (!isRecord(value)) return false;
  return (
    typeof value.tasksHandled === "number" &&
    typeof value.tasksCompleted === "number" &&
    typeof value.tasksFailed === "number"
  );
}

function isPublicCurrentState(value: unknown): value is PublicCurrentState {
  if (!isRecord(value)) return false;
  return (
    typeof value.status === "string" &&
    typeof value.title === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.activeCount === "number" &&
    isPublicActivityStats(value.stats)
  );
}

function isPublicActivityEntry(value: unknown): value is PublicActivityEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.ts === "string" &&
    typeof value.type === "string" &&
    typeof value.status === "string" &&
    typeof value.title === "string"
  );
}

function isPublicActivityFile(value: unknown): value is PublicActivityFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.updatedAt === "string" &&
    Array.isArray(value.events) &&
    value.events.every(isPublicActivityEntry)
  );
}

function isIngestPayload(value: unknown): value is IngestPayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.sentAt === "string" &&
    isPublicCurrentState(value.current) &&
    isPublicActivityFile(value.eventsFile)
  );
}

function isStoredSnapshot(value: unknown): value is StoredSnapshot {
  if (!isRecord(value)) return false;
  return (
    isPublicCurrentState(value.current) &&
    isPublicActivityFile(value.eventsFile) &&
    typeof value.lastSeenAt === "string" &&
    typeof value.snapshotUpdatedAt === "string"
  );
}
