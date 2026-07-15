import "dotenv/config";

import { startOpencodeServer } from "./opencode-server.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4096";

async function main(): Promise<void> {
  const baseUrl = process.env.OPENCODE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const server = await startOpencodeServer(baseUrl);
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[opencode-serve] ${signal} received — stopping`);
    server.close();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[opencode-serve] startup failed", error);
  process.exit(1);
});
