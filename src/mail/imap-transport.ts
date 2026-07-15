import { ImapFlow } from "imapflow";
import type { ImapFlowOptions } from "imapflow";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { simpleParser } from "mailparser";
import type { AddressObject, ParsedMail } from "mailparser";

import type { RunImageInput } from "../opencode-runtime.js";
import {
  MAX_INBOUND_IMAGES,
  MAX_INBOUND_IMAGE_BYTES,
  MailTransportUnavailableError,
  parseFromHeader,
  parseNewerThanWindowMs,
  type InboundMessage,
  type MailTransport,
  type OutboundMessage,
  type OutboundResult,
} from "./transport.js";

export interface ImapSmtpConfig {
  user: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  // TLS on connect (implicit TLS). Defaults to true for the standard secure
  // ports (993 IMAP / 465 SMTP); false uses STARTTLS upgrade.
  imapSecure: boolean;
  smtpSecure: boolean;
}

// How many recent messages to look at per poll; the bridge's dedup handles the rest.
const MAX_POLL_MESSAGES = 10;
// Cap on the per-message parsed-source cache so long-running processes don't
// accumulate full message bodies for messages that were already handled.
const MAX_PARSED_CACHE = 32;
const CONNECT_TIMEOUT_MS = Number(process.env.GMAIL_CONNECT_TIMEOUT_MS) || 30_000;
const GREETING_TIMEOUT_MS =
  Number(process.env.GMAIL_GREETING_TIMEOUT_MS) || 15_000;
const SOCKET_TIMEOUT_MS = Number(process.env.GMAIL_SOCKET_TIMEOUT_MS) || 120_000;

interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  proxy?: string;
}

function getSharedProxy(): string | undefined {
  return (
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.ALL_PROXY?.trim() ||
    process.env.all_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

// IMAP (receive) + SMTP (send) transport. Requires nothing beyond a mailbox
// address and an app password — no OAuth client, no token expiry, no Google
// Cloud project. Threads purely via RFC Message-ID / References headers.
export class ImapSmtpTransport implements MailTransport {
  private client: ImapFlow | null = null;
  private smtp: Transporter | null = null;
  // Message-ID -> IMAP uid, populated on each poll so fetch/markRead can act
  // on a stable RFC id rather than a mailbox-scoped uid.
  private readonly uidByMessageId = new Map<string, number>();
  // Message-ID -> parsed source, so fetchImages doesn't re-download the body.
  private readonly parsedByMessageId = new Map<string, ParsedMail>();

  constructor(private readonly config: ImapSmtpConfig) {}

  async connect(): Promise<{ address: string }> {
    if (!this.config.user || !this.config.password) {
      throw new MailTransportUnavailableError(
        "missing EMAIL_USER / EMAIL_PASSWORD for IMAP transport",
      );
    }
    if (!this.config.imapHost || !this.config.smtpHost) {
      throw new MailTransportUnavailableError(
        "missing IMAP_HOST / SMTP_HOST for IMAP transport",
      );
    }

    const proxy = getSharedProxy();
    console.log(
      `[gmail] connecting IMAP ${this.config.imapHost}:${this.config.imapPort} / SMTP ${this.config.smtpHost}:${this.config.smtpPort}${proxy ? " via proxy" : ""}`,
    );
    await this.ensureImap();

    const smtpOptions: SmtpOptions = {
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpSecure,
      auth: { user: this.config.user, pass: this.config.password },
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      ...(proxy ? { proxy } : {}),
    };
    this.smtp = nodemailer.createTransport(smtpOptions);
    console.log(`[gmail] verifying SMTP ${this.config.smtpHost}:${this.config.smtpPort}`);
    await this.smtp.verify();

    console.log(
      `[gmail] IMAP ${this.config.imapHost}:${this.config.imapPort} / SMTP ${this.config.smtpHost}:${this.config.smtpPort}`,
    );
    return { address: this.config.user };
  }

  async listInboxMessageIds(
    _inbox: string,
    newerThan: string,
  ): Promise<string[]> {
    const client = await this.ensureImap();
    const windowMs = parseNewerThanWindowMs(newerThan) ?? 3 * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - windowMs);

    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const recent = uids.slice(-MAX_POLL_MESSAGES);

      const ids: string[] = [];
      for await (const msg of client.fetch(
        recent,
        { uid: true, envelope: true },
        { uid: true },
      )) {
        const messageId = msg.envelope?.messageId?.trim();
        if (!messageId) continue;
        this.uidByMessageId.set(messageId, msg.uid);
        ids.push(messageId);
      }
      return ids;
    } finally {
      lock.release();
    }
  }

  async fetchMessage(id: string): Promise<InboundMessage | null> {
    const parsed = await this.loadParsed(id);
    if (!parsed) return null;

    const fromHeader = parsed.from?.text || "";
    const { name: fromName, email: fromEmail } = parseFromHeader(fromHeader);

    return {
      id,
      threadId: deriveThreadId(parsed, id),
      rfcMessageId: parsed.messageId || id,
      fromName,
      fromEmail,
      toAddresses: collectRecipientHeaders(parsed),
      subject: parsed.subject || "(no subject)",
      textBody: parsed.text || "",
      internalDateMs: parsed.date ? parsed.date.getTime() : undefined,
    };
  }

  async fetchImages(id: string): Promise<RunImageInput[]> {
    const parsed = await this.loadParsed(id);
    if (!parsed) return [];

    const images: RunImageInput[] = [];
    for (const attachment of parsed.attachments || []) {
      if (images.length >= MAX_INBOUND_IMAGES) break;
      const mime = attachment.contentType || "image/png";
      if (!mime.startsWith("image/")) continue;
      const buffer = attachment.content;
      if (!buffer || buffer.byteLength === 0) continue;
      if (buffer.byteLength > MAX_INBOUND_IMAGE_BYTES) continue;

      images.push({
        mime,
        filename: attachment.filename || `image-${images.length + 1}`,
        url: `data:${mime};base64,${buffer.toString("base64")}`,
      });
    }

    if (images.length > 0) {
      console.log(`[gmail] extracted ${images.length} inline image(s) from ${id}`);
    }
    return images;
  }

  async sendMessage(message: OutboundMessage): Promise<OutboundResult> {
    if (!this.smtp) throw new Error("SMTP transport not connected");

    const info = await this.smtp.sendMail({
      from: message.from || this.config.user,
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      inReplyTo: message.inReplyTo,
      references: message.references,
      text: message.text,
      html: message.html,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    });

    const messageId = info.messageId || "";
    // With no prior thread, the message we just sent becomes the thread root;
    // otherwise the conversation is anchored on the original root id so replies
    // on either side resolve to the same thread.
    const threadId =
      message.references?.[0] || message.inReplyTo || messageId;

    return { messageId, threadId };
  }

  async markRead(id: string): Promise<void> {
    const uid = this.uidByMessageId.get(id);
    if (uid === undefined) return;
    const client = await this.ensureImap();
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    } catch (error) {
      console.warn(`[gmail] markRead failed for ${id}`, error);
    } finally {
      lock.release();
      this.parsedByMessageId.delete(id);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        // best-effort
      }
      this.client = null;
    }
    if (this.smtp) {
      this.smtp.close();
      this.smtp = null;
    }
  }

  private async ensureImap(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;

    const proxy = getSharedProxy();
    const options: ImapFlowOptions = {
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: this.config.imapSecure,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      ...(proxy ? { proxy } : {}),
    };
    const client = new ImapFlow(options);
    client.on("error", (err) => console.warn("[gmail] IMAP client error", err));
    await client.connect();
    this.client = client;
    return client;
  }

  private async loadParsed(id: string): Promise<ParsedMail | null> {
    const cached = this.parsedByMessageId.get(id);
    if (cached) return cached;

    const uid = this.uidByMessageId.get(id);
    if (uid === undefined) return null;

    const client = await this.ensureImap();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      const parsed = await simpleParser(msg.source);
      if (this.parsedByMessageId.size >= MAX_PARSED_CACHE) {
        this.parsedByMessageId.clear();
      }
      this.parsedByMessageId.set(id, parsed);
      return parsed;
    } finally {
      lock.release();
    }
  }
}

function deriveThreadId(parsed: ParsedMail, fallbackId: string): string {
  const references = normalizeReferences(parsed.references);
  if (references.length > 0) return references[0];
  if (parsed.inReplyTo) return parsed.inReplyTo.trim();
  return parsed.messageId || fallbackId;
}

function normalizeReferences(
  references: string | string[] | undefined,
): string[] {
  if (!references) return [];
  const list = Array.isArray(references) ? references : references.split(/\s+/);
  return list.map((r) => r.trim()).filter(Boolean);
}

function collectRecipientHeaders(parsed: ParsedMail): string[] {
  const out: string[] = [];
  const push = (value: AddressObject | AddressObject[] | undefined): void => {
    if (!value) return;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry.text) out.push(entry.text);
    }
  };
  push(parsed.to);
  // Delivered-To / X-Original-To are address headers, so mailparser returns
  // them as structured objects with a `.text` field rather than raw strings.
  for (const name of ["delivered-to", "x-original-to"]) {
    const header = parsed.headers.get(name);
    if (typeof header === "string") {
      out.push(header);
    } else if (header && typeof header === "object" && "text" in header) {
      const text = (header as { text?: unknown }).text;
      if (typeof text === "string") out.push(text);
    }
  }
  return out;
}
