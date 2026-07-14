import type { RunImageInput } from "../opencode-runtime.js";

// Caps on inline images lifted from an inbound email, to keep the prompt from
// blowing past model limits on image-heavy mail (signatures, tracking pixels,
// photo attachments).
export const MAX_INBOUND_IMAGES = 5;
export const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;

// A single inbound message normalized across email transports.
// The bridge orchestration only ever sees this shape, never a provider payload.
export interface InboundMessage {
  // Transport-stable id used for claim/dedup/markRead/fetchImages.
  id: string;
  // Provider thread grouping id. For IMAP this is the synthetic root
  // Message-ID derived from the References/In-Reply-To chain.
  threadId: string;
  // RFC Message-ID header value, kept verbatim (with angle brackets).
  rfcMessageId: string;
  fromName: string;
  fromEmail: string;
  // Raw To / Delivered-To / X-Original-To values, used to confirm the message
  // was actually addressed to the agent inbox.
  toAddresses: string[];
  subject: string;
  textBody: string;
  internalDateMs?: number;
}

export interface OutboundMessage {
  to: string;
  from?: string;
  replyTo?: string;
  subject: string;
  inReplyTo?: string;
  references?: string[];
  text: string;
  html: string;
}

export interface OutboundResult {
  messageId: string;
  threadId: string;
}

// Thrown by a transport when it cannot start because required credentials are
// missing or revoked. The bridge treats this as "channel disabled" and skips,
// rather than crashing the whole process.
export class MailTransportUnavailableError extends Error {}

// Email transport seam. Everything above the transport (session mapping,
// permission/question round-trips, dedup, recovery, public activity) is shared.
export interface MailTransport {
  // Connect and return the authenticated account address.
  connect(): Promise<{ address: string }>;
  // Transport ids for messages addressed to `inbox` within the recency window.
  listInboxMessageIds(inbox: string, newerThan: string): Promise<string[]>;
  // Fetch one message's headers + text body + metadata (no image bytes).
  fetchMessage(id: string): Promise<InboundMessage | null>;
  // Lift inline images / image attachments for a message (lazy, on run start).
  fetchImages(id: string): Promise<RunImageInput[]>;
  // Send a message; returns the provider message + thread ids.
  sendMessage(message: OutboundMessage): Promise<OutboundResult>;
  // Mark an inbound message read/seen (best-effort).
  markRead(id: string): Promise<void>;
  // Tear down connections.
  close(): Promise<void>;
}

export function parseFromHeader(from: string): { name: string; email: string } {
  const match = from.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, ""),
      email: match[2].trim(),
    };
  }
  return { name: from, email: from };
}

export function parseNewerThanWindowMs(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+)\s*([mhd])$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  switch (match[2].toLowerCase()) {
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    case "d":
      return amount * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}
