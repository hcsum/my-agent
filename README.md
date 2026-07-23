# opencode-workspace

My personal AI workspace: an OpenCode-centered runtime with custom skills, long-term memory, notes, scheduling, and email/Telegram bridges. It can also route work through Claude when needed.

## What it does

- Runs a project-local OpenCode server and stores sessions in this workspace
- Supports 2 runtimes: OpenCode and Claude
- Provides a built-in Gmail bridge
- Keeps a set of skills customized to my needs
- A Cloudflare Worker endpoint that exposes the agent's live status and activity — see [hcxu.cc/agent](https://hcxu.cc/agent)
- Assumes a git repo checked out into the `notes/` folder at the root of this repo

## How it fits together

- **This repo** — the workspace runtime: code, skills, instructions, bridge services, and project-local OpenCode state
- **`notes/`** — a *separate* private git repo checked out here, holding my personal data, memory, research, and todos. Kept separate so this repo stays code, and `notes/` stays the data it operates on.
- **Bridges** — the Gmail bridge and [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) let me reach the workspace when I'm away from the desk
- **Status worker** — a Cloudflare Worker publishing live status to [hcxu.cc/agent](https://hcxu.cc/agent)

## Quick start

```bash
npm install
cp .env.example .env         # then fill it in (see below)
npm run bridge               # start the workspace bridge and OpenCode server
npm start                    # run only the OpenCode server
npm run tui                  # open the OpenCode TUI against the project-local DB
```

Key `.env` settings (all documented inline in `.env.example`):

- **Gmail bridge** — `AGENT_INBOX_EMAIL`, `USER_EMAIL`, and an app password (`EMAIL_PASSWORD`), not your login password
- **Notes repo** — `NOTES_REPO_URL` (+ `NOTES_REPO_TOKEN` for HTTPS auth); then run `scripts/bootstrap-notes.sh` to check it out into `notes/`
- **Long-term memory** — `GOOGLE_API_KEY` (Gemini, for embeddings + extraction) and a running Qdrant at `QDRANT_URL`

There's no first-run setup wizard yet — this is manual. For VPS deployment, see `docs/DEPLOY.md` and the `deploy-agent` skill.

## How I use it

My main entry point is the [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot), which talks to the OpenCode server running from this workspace. This lets me keep working from Telegram when I'm away from the desk.

When I'm at the machine, I run `npm run tui` in this repo. The TUI uses the same project-local OpenCode state as the Telegram bot, so both sides see the same sessions and I can continue the same work from either Telegram or the local terminal.
