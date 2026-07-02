import type { PublicActivitySnapshot } from "./public-activity.js";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

interface PublicActivityReplicatorOptions {
  ingestUrl: string;
  token: string;
  heartbeatMs: number;
  timeoutMs: number;
}

interface PublicActivityIngestPayload {
  sentAt: string;
  current: PublicActivitySnapshot["current"];
  eventsFile: PublicActivitySnapshot["eventsFile"];
}

export class PublicActivityReplicator {
  private readonly ingestUrl: string;
  private readonly token: string;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly dispatcher = buildProxyDispatcher();
  private latestSnapshot?: PublicActivitySnapshot;
  private heartbeatTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;
  private pendingFlush = false;
  private stopped = false;

  constructor(options: PublicActivityReplicatorOptions) {
    this.ingestUrl = options.ingestUrl;
    this.token = options.token;
    this.heartbeatMs = options.heartbeatMs;
    this.timeoutMs = options.timeoutMs;

    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.requestFlush();
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  publish(snapshot: PublicActivitySnapshot): void {
    if (this.stopped) return;
    this.latestSnapshot = snapshot;
    this.requestFlush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    await this.flushPromise;
  }

  private requestFlush(): void {
    if (!this.latestSnapshot || this.stopped) return;
    this.pendingFlush = true;
    if (this.flushPromise) return;
    this.flushPromise = this.flushLoop();
  }

  private async flushLoop(): Promise<void> {
    try {
      while (this.pendingFlush && !this.stopped) {
        this.pendingFlush = false;
        const snapshot = this.latestSnapshot;
        if (!snapshot) return;
        await this.sendSnapshot(snapshot);
      }
    } catch (error) {
      console.error("[public-activity-sync] snapshot upload failed", error);
    } finally {
      this.flushPromise = undefined;
      if (this.pendingFlush && !this.stopped) {
        this.requestFlush();
      }
    }
  }

  private async sendSnapshot(snapshot: PublicActivitySnapshot): Promise<void> {
    const payload: PublicActivityIngestPayload = {
      sentAt: new Date().toISOString(),
      current: snapshot.current,
      eventsFile: snapshot.eventsFile,
    };

    const response = await undiciFetch(this.ingestUrl, {
      dispatcher: this.dispatcher,
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.ok) return;

    const body = (await response.text()).trim();
    throw new Error(
      `status=${response.status} body=${body.slice(0, 300) || "<empty>"}`,
    );
  }
}

function buildProxyDispatcher(): EnvHttpProxyAgent | undefined {
  const proxy =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.ALL_PROXY?.trim() ||
    process.env.all_proxy?.trim();

  if (!proxy) return undefined;
  return new EnvHttpProxyAgent();
}
