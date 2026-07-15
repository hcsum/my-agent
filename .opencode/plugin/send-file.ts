import { type Plugin, tool } from "@opencode-ai/plugin";

const z = tool.schema;

// A file is delivered through whichever channel owns the current session. The
// Telegram bot serves its own endpoint (it holds the bot token / chat id); the
// Gmail bridge serves one that attaches the file to the thread's reply email.
// Both live on loopback on the same host, so we POST an intent to each in turn
// and let whichever owns the session claim it. Override the URLs (or just the
// ports) per deployment.
const TELEGRAM_DELIVERY_URL =
  process.env.TELEGRAM_DELIVERY_URL?.trim() ||
  `http://127.0.0.1:${Number(process.env.TELEGRAM_DELIVERY_PORT) || 4099}/telegram/send-file`;

const GMAIL_DELIVERY_URL =
  process.env.GMAIL_DELIVERY_URL?.trim() ||
  `http://127.0.0.1:${Number(process.env.GMAIL_DELIVERY_PORT) || 4098}/gmail/send-file`;

type DeliveryOutcome =
  // The channel accepted and delivered/queued the file.
  | { kind: "delivered" }
  // The endpoint answered 404 — this session isn't owned by that channel.
  | { kind: "not_owned" }
  // The endpoint was unreachable (bot/bridge not running on this host).
  | { kind: "unreachable" }
  // The channel owns the session but rejected the file (e.g. bad path, too big).
  | { kind: "rejected"; error: string };

async function postDelivery(
  url: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "unreachable" };
  }

  if (res.status === 404) return { kind: "not_owned" };

  const text = await res.text();
  if (res.ok) return { kind: "delivered" };

  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") detail = parsed.error;
  } catch {
    /* keep raw text */
  }
  return { kind: "rejected", error: `(${res.status}): ${detail}` };
}

export const SendFilePlugin: Plugin = async () => ({
  tool: {
    send_file_to_user: tool({
      description:
        "Deliver a local file directly to the user through the chat channel they are talking to you on (Telegram or Gmail). Use this when the user asks you to send or show them a file or picture — e.g. after you download or generate an image. Pass an absolute path to a file that already exists on disk. On Telegram, images are sent as photos and anything else as a document; on Gmail the file is attached to the reply email for this thread (so it arrives together with your final answer). If the current session is not attached to any channel, this is NOT an error: it returns a notice and the file simply stays on disk — fall back to sharing its path or describing it.",
      args: {
        path: z
          .string()
          .describe("Absolute path to an existing local file to send to the user"),
        caption: z
          .string()
          .optional()
          .describe("Optional short caption to show alongside the file (Telegram only)"),
      },
      async execute(args, ctx) {
        const payload = {
          sessionID: ctx.sessionID,
          path: args.path,
          caption: args.caption,
        };

        // Try Telegram first, then the Gmail bridge. Each 404s for sessions it
        // does not own, so the first that claims the session wins.
        const telegram = await postDelivery(TELEGRAM_DELIVERY_URL, payload);
        if (telegram.kind === "delivered") {
          return `Delivered ${args.path} to the user via Telegram.`;
        }
        if (telegram.kind === "rejected") {
          throw new Error(`send_file_to_user failed via Telegram ${telegram.error}`);
        }

        const gmail = await postDelivery(GMAIL_DELIVERY_URL, payload);
        if (gmail.kind === "delivered") {
          return `Attached ${args.path} to my email reply for this thread; it will arrive with my next message.`;
        }
        if (gmail.kind === "rejected") {
          throw new Error(`send_file_to_user failed via Gmail ${gmail.error}`);
        }

        // Neither channel owns this session (or neither is reachable).
        return `This session is not attached to a chat channel, so the file was not delivered. It remains on disk at ${args.path}; share the path or describe it instead.`;
      },
    }),
  },
});

export default SendFilePlugin;
