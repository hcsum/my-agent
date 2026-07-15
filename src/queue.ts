import type {
  PublicEventPublisher,
  PublicTaskContext,
} from "./public-activity.js";

export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private pending = 0;
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly publicActivity?: PublicEventPublisher) {}

  get size(): number {
    return this.pending;
  }

  // True when nothing is queued or executing across all partition keys. Each
  // in-flight job (Gmail or scheduler) holds the queue open via lease.wait()
  // until the underlying OpenCode run actually completes, so an idle queue
  // means every dispatched LLM run has finished — the signal graceful shutdown
  // waits on.
  get isIdle(): boolean {
    return this.pending === 0 && this.active === 0;
  }

  // Resolves the next time the queue reaches an idle state (immediately if it
  // already is). Used by the shutdown path to let the current task finish.
  whenIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  enqueue<T>(
    key: string,
    label: string,
    run: () => Promise<T>,
    publicTask?: PublicTaskContext,
  ): Promise<T> {
    if (publicTask) {
      this.publicActivity?.emit({ type: "task_queued", task: publicTask });
    }

    this.pending += 1;

    const previous = this.tails.get(key);
    const afterPrevious = previous
      ? previous.catch(() => {
          // Keep the per-key queue moving even if the previous job failed.
        })
      : Promise.resolve();

    const current = afterPrevious.then(async () => {
      this.pending -= 1;
      this.active += 1;
      try {
        console.log(`[queue] start ${label}; key=${key}; pending=${this.pending}`);
        if (publicTask) {
          this.publicActivity?.emit({ type: "task_started", task: publicTask });
        }
        const result = await run();
        console.log(`[queue] done ${label}; key=${key}; pending=${this.pending}`);
        return result;
      } catch (error) {
        console.error(`[queue] failed ${label}; key=${key}`, error);
        throw error;
      } finally {
        this.active -= 1;
        if (this.tails.get(key) === settled) {
          this.tails.delete(key);
        }
        this.resolveIdleWaitersIfNeeded();
      }
    });

    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);

    return current;
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (!this.isIdle || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
