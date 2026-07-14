import { SchedulerApi } from "./api.js";
import { ScheduledTaskExecutor } from "./executor.js";
import type { ScheduledResultSink } from "./result-sink.js";
import { SchedulerRuntime } from "./runtime.js";
import type { AppOrchestrator } from "../app/orchestrator.js";
import type { ExecutionSlot } from "../execution-slot.js";
import type { PublicEventPublisher } from "../public-activity.js";
import type { SerialQueue } from "../queue.js";
import type { AppConfig } from "../types.js";

export interface SchedulerDeps {
  config: AppConfig;
  orchestrator: AppOrchestrator;
  queue: SerialQueue;
  resultSink: ScheduledResultSink;
  publicActivity: PublicEventPublisher;
  executionSlot: ExecutionSlot;
}

export interface Scheduler {
  stop(): Promise<void>;
  beginShutdown(): void;
  waitForInFlight(): Promise<void>;
}

export async function launchScheduler(deps: SchedulerDeps): Promise<Scheduler> {
  const executor = new ScheduledTaskExecutor({
    config: deps.config,
    orchestrator: deps.orchestrator,
    queue: deps.queue,
    publicActivity: deps.publicActivity,
    executionSlot: deps.executionSlot,
  });

  const runtime = new SchedulerRuntime({
    executor,
    resultSink: deps.resultSink,
  });
  runtime.start();

  const api = new SchedulerApi({ config: deps.config, runtime });
  await api.start();

  return {
    async stop() {
      await api.stop();
      await runtime.stop();
    },
    beginShutdown() {
      // Stop firing new scheduled runs. The HTTP API stays up so a draining
      // task can still use the schedule_* tools; it is closed in stop().
      runtime.beginShutdown();
    },
    async waitForInFlight() {
      await runtime.waitForInFlight();
    },
  };
}

export type { ScheduledTask, ScheduledResultPayload } from "./types.js";
