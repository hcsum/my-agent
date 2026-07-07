import type { ScheduledResultPayload } from "./types.js";

export interface ScheduledResultSink {
  sendScheduledResult(payload: ScheduledResultPayload): Promise<void>;
}

export class NoopScheduledResultSink implements ScheduledResultSink {
  async sendScheduledResult(_payload: ScheduledResultPayload): Promise<void> {}
}
