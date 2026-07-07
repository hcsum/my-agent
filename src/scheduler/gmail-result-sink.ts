import type { GmailBridge } from "../gmail.js";
import type { ScheduledResultSink } from "./result-sink.js";
import type { ScheduledResultPayload } from "./types.js";

export class GmailScheduledResultSink implements ScheduledResultSink {
  constructor(private readonly bridge: GmailBridge) {}

  async sendScheduledResult(payload: ScheduledResultPayload): Promise<void> {
    await this.bridge.sendScheduledResult(payload);
  }
}
