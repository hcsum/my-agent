import type { GmailChannelConfig } from "../types.js";
import { ImapSmtpTransport } from "./imap-transport.js";
import type { MailTransport } from "./transport.js";

export function createMailTransport(config: GmailChannelConfig): MailTransport {
  if (!config.imap) {
    throw new Error(
      "Email bridge requires EMAIL_USER / EMAIL_PASSWORD / IMAP_HOST / SMTP_HOST",
    );
  }
  return new ImapSmtpTransport(config.imap);
}
