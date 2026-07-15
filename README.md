# My Agent

My personal AI agent setup: custom skills, long-term memory, and email/Telegram bridges, running on OpenCode or Claude.

## What it does

- Supports 2 runtimes: OpenCode and Claude
- A built-in Gmail bridge
- A set of skills customized to my needs
- A Cloudflare Worker endpoint that exposes the agent's live status and activity — see [hcxu.cc/agent](https://hcxu.cc/agent)
- Assumes a git repo checked out into the `notes/` folder at the root of this repo

## How it fits together

- **This repo** — code, skills, and instructions
- **`notes/`** — a *separate* private git repo checked out here, holding my personal data, the agent's memory, research, and todos. Kept separate so this repo stays code, and `notes/` stays the data it operates on.
- **Bridges** — the Gmail bridge and [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) let me reach the agent when I'm away from the desk
- **Status worker** — a Cloudflare Worker publishing live status to [hcxu.cc/agent](https://hcxu.cc/agent)

## Quick start

```bash
npm install
cp .env.example .env         # then fill it in (see below)
npm run bridge               # start the Gmail bridge
npm start                    # run the OpenCode server
```

Key `.env` settings (all documented inline in `.env.example`):

- **Gmail bridge** — `AGENT_INBOX_EMAIL`, `USER_EMAIL`, and an app password (`EMAIL_PASSWORD`), not your login password
- **Notes repo** — `NOTES_REPO_URL` (+ `NOTES_REPO_TOKEN` for HTTPS auth); then run `scripts/bootstrap-notes.sh` to check it out into `notes/`
- **Long-term memory** — `GOOGLE_API_KEY` (Gemini, for embeddings + extraction) and a running Qdrant at `QDRANT_URL`

There's no first-run setup wizard yet — this is manual. For VPS deployment, see `docs/DEPLOY.md` and the `deploy-agent` skill.

## How I use the agent

When I'm by the desk, I run `claude` / `codex` / `opencode` in this repo, so I have easy access to the skills and notes.

When I'm away from the desk, I leave my laptop on and interact with the agent through the Gmail bridge and [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot).
