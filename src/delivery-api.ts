import http from "node:http";

import type { GmailBridge } from "./gmail.js";

// Loopback HTTP endpoint the send_file_to_user plugin POSTs to when the user is
// on the Gmail channel. The plugin runs inside the OpenCode server (a separate
// process on the same host), so it can only reach the bridge over 127.0.0.1 —
// mirroring how the scheduler plugin talks to the scheduler API.
export class DeliveryApi {
  private server?: http.Server;

  constructor(
    private readonly bridge: GmailBridge,
    private readonly port: number,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        console.error("[delivery-api] handler crashed", error);
        if (!res.headersSent) res.writeHead(500);
        res.end(JSON.stringify({ error: "internal error" }));
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    console.log(`[delivery-api] listening on 127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = (req.url || "").split("?")[0];
    if (req.method !== "POST" || url !== "/gmail/send-file") {
      res.writeHead(404).end();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    const sessionId = typeof body.sessionID === "string" ? body.sessionID.trim() : "";
    const filePath = typeof body.path === "string" ? body.path.trim() : "";
    const caption = typeof body.caption === "string" ? body.caption : undefined;

    if (!sessionId || !filePath) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "sessionID and path are required" }));
      return;
    }

    const result = await this.bridge.enqueueFileForSession({
      sessionId,
      path: filePath,
      caption,
    });

    if (result.status === "no_session") {
      // Not a Gmail session — let the plugin degrade gracefully.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no active gmail session for this sessionID" }));
      return;
    }

    if (result.status === "error") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ buffered: true, filename: result.filename }));
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("body must be a JSON object");
  } catch (error) {
    throw new Error(
      error instanceof Error ? `invalid JSON body: ${error.message}` : "invalid JSON body",
    );
  }
}
