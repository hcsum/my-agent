import fs from "node:fs";
import path from "node:path";

import { createOpencodeServer } from "@opencode-ai/sdk";

import { buildServerConfig } from "./opencode-server-config.js";

export interface RunningServer {
  url: string;
  close(): void;
}

/**
 * Spawn `opencode serve` in-process and inject our provider config in code.
 * This replaces the old two-process shell supervisor (serve-and-bridge.sh):
 * the bridge now owns the server child directly and the custom-provider config
 * lives in TypeScript instead of .opencode/opencode.json.
 *
 * The server binds to the host/port of OPENCODE_BASE_URL so the bridge's
 * existing clients keep connecting to the same address.
 */
export async function startOpencodeServer(
  baseUrl: string,
): Promise<RunningServer> {
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname || "127.0.0.1";
  const port = Number(parsed.port) || 4096;

  // Keep opencode's DB inside the repo's .data/ by default. The server expects
  // an absolute OPENCODE_DB, so resolve explicit relative overrides here.
  const dataDir = path.resolve(".data");
  const configuredDb = process.env.OPENCODE_DB?.trim();
  const dbPath = configuredDb
    ? path.resolve(configuredDb)
    : path.join(dataDir, "opencode.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  process.env.OPENCODE_DB = dbPath;

  // opencode honors HTTPS_PROXY; keep loopback calls off the proxy as the old
  // serve script did.
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    process.env.NO_PROXY ||= "127.0.0.1,localhost";
  }

  // Default timeout (5s) is too tight once plugins/notes load on a cold start.
  const timeout = Number(process.env.OPENCODE_SERVE_TIMEOUT_MS) || 60_000;

  console.log(`[opencode-serve] starting on ${hostname}:${port}`);
  const server = await createOpencodeServer({
    hostname,
    port,
    timeout,
    config: buildServerConfig(),
  });
  console.log(`[opencode-serve] listening on ${server.url}`);
  return server;
}
