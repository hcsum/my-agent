# opencode-agent

[中文](README.zh-CN.md)

My personal agent workspace: an OpenCode-centered runtime with custom skills, notes, scheduling, and email/Telegram access.

The idea is simple: the agent's home should be a directory about the person using it, not a checkout of one project. Projects are places it visits. Context, skills, notes, and long-running state compound here.

This repo is not an agent by itself. It is a layer on top of an agent runtime: the workspace, skills, bridges, and personal state that make the runtime useful day to day.

## What it does

- Runs a project-local OpenCode server with workspace-local sessions and state
- Lets TUI, Telegram, email, and scheduled jobs share the same runtime
- Provides a Gmail bridge for remote prompts, approvals, replies, and scheduled results
- Exposes scheduler tools for recurring or future agent tasks
- Can route work through OpenCode or Claude providers
- Treats custom skills and instructions as workspace-level capabilities
- Bootstraps a separate private `notes/` repo for personal data, research, todos, and memory-like state
- Publishes live activity through a Cloudflare Worker at [hcxu.cc/agent](https://hcxu.cc/agent)

## Shape

```text
TUI / Telegram / Gmail / Scheduler
            ↓
      OpenCode server
            ↓
   agent workspace + skills
            ↓
notes / projects / browser / shell
```

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

There's no first-run setup wizard yet. For VPS deployment, see `docs/DEPLOY.md` and the `deploy-agent` skill.

## How I use it

My main entry point is [opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot), which talks to the OpenCode server running from this workspace. At the machine, I run `npm run tui`; both sides see the same sessions.
