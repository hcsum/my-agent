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
  private static readonly maxRetryDelayMs = 60000;
  private readonly ingestUrl: string;
  private readonly token: string;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly dispatcher = buildProxyDispatcher();
  private latestSnapshot?: PublicActivitySnapshot;
  private heartbeatTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;
  private pendingFlush = false;
  private stopped = false;
  private failureCount = 0;

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
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.flushPromise;
  }

  private requestFlush(): void {
    if (!this.latestSnapshot || this.stopped) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.pendingFlush = true;
    if (this.flushPromise) return;
    this.flushPromise = this.flushLoop();
  }

  private async flushLoop(): Promise<void> {
    let retryAfterMs: number | undefined;
    try {
      while (this.pendingFlush && !this.stopped) {
        this.pendingFlush = false;
        const snapshot = this.latestSnapshot;
        if (!snapshot) return;
        await this.sendSnapshot(snapshot);
        this.failureCount = 0;
      }
    } catch (error) {
      this.pendingFlush = true;
      retryAfterMs = this.nextRetryDelayMs();
      console.error(
        `[public-activity-sync] snapshot upload failed; retrying in ${Math.round(
          retryAfterMs / 1000,
        )}s: ${formatError(error)}`,
      );
    } finally {
      this.flushPromise = undefined;
      if (this.pendingFlush && !this.stopped) {
        if (retryAfterMs === undefined) {
          this.requestFlush();
        } else {
          this.scheduleRetry(retryAfterMs);
        }
      }
    }
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestFlush();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private nextRetryDelayMs(): number {
    this.failureCount += 1;
    return Math.min(
      PublicActivityReplicator.maxRetryDelayMs,
      1000 * 2 ** Math.min(this.failureCount - 1, 6),
    );
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

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause;
  if (cause instanceof Error) {
    const code = "code" in cause ? String(cause.code) : undefined;
    return [code, cause.message].filter(Boolean).join(" ");
  }

  return error.message;
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
