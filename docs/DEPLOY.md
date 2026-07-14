# Deployment Guide

Canonical, low-friction procedure for standing up the opencode-agent bridge on
a VPS. The goal: **everything that can live in code lives in code**; the only
manual work is a short, fixed list of secrets that by definition cannot be
committed.

For LLM-guided deployment, the `deploy-agent` skill drives this document.

## Mental model: three buckets

| Bucket | In repo? | Where it lives |
| --- | --- | --- |
| Code + mechanism | ✅ yes | this repo |
| Secrets (tokens, OAuth, keys) | ❌ never | VPS `.env` + `.secrets/` + GitHub Actions secrets |
| VPS provisioning | scripted | `scripts/provision-vps.sh` |

The whole point of the design is to keep buckets 2 and 3 small and explicit.

## Architecture (what runs where)

- The agent runs in a **Docker container** on the VPS, started by
  `docker compose` as an **unprivileged `deploy` user** (never root).
- Deploy is a **GitHub Action** (`.github/workflows/deploy.yml`) that fires on
  push to `main`: it SSHes in as `deploy`, `git reset --hard origin/main`,
  syncs the `notes` repo, then `docker compose up -d --build`.
- `notes/` is a **separate private git repo** mounted into the container; the
  agent reads and writes it. See `docs/notes-repo.md`.
- Host-side credential/state dirs are **project-relative** (`./.secrets/...`),
  so they resolve to the same path regardless of which user runs compose.

## Prerequisites

- A VPS (root SSH access for the one-time provisioning).
- A GitHub repo for the agent code (this repo / a fork).
- A separate private GitHub repo for `notes`.
- Accounts/keys for any integrations you use (email mailbox, Browserbase, etc.).

## Step 1 — Provision the VPS (one-time, as root)

```bash
# On a fresh VPS, as root:
REPO_URL=https://github.com/<you>/<agent-repo>.git \
  bash <(curl -fsSL https://raw.githubusercontent.com/<you>/<agent-repo>/main/scripts/provision-vps.sh)
```

This is idempotent and:

- creates the `deploy` user and adds it to the `docker` group,
- installs Docker + the compose plugin,
- clones the repo to `/opt/opencode-agent` (owned by `deploy`),
- creates `.secrets/opencode-share` (mode 700),
- scaffolds `.env` from `.env.example`,
- prints the remaining manual steps.

## Step 2 — Fill secrets in `.env`

Edit `/opt/opencode-agent/.env` (as `deploy`). Required / common keys:

| Key | Purpose |
| --- | --- |
| `NOTES_REPO_URL` | `https://github.com/<you>/<notes-repo>.git` |
| `NOTES_REPO_TOKEN` | GitHub **fine-grained PAT**, scoped to the notes repo, **Contents: Read and write**. Enables the container to push notes over HTTPS — no SSH key needed. |
| `USER_EMAIL` / `AGENT_INBOX_EMAIL` | result recipient / polled inbox |
| `EMAIL_PASSWORD`, `IMAP_HOST`, `SMTP_HOST` | required for the email bridge |
| `BROWSERBASE_*`, `CAPSOLVER_API_KEY` | web-access providers (if used) |
| `OPENCODE_MODEL` | model id (or set in compose `environment`) |
| `APT_MIRROR` | **optional** build knob: Debian apt mirror used during image build. Defaults to the upstream CDN; set a domestic mirror (e.g. `mirrors.tuna.tsinghua.edu.cn`) when building behind a slow cross-border link. Wired into the build via `docker-compose.yml` `build.args`. |
| `NPM_REGISTRY` | **optional** build knob: npm registry used during image build. Leave unset for the default npm registry; set a mirror (e.g. `https://registry.npmmirror.com/`) if `npm install` / `npm ci` is the slow part. |

Long-term memory (mem0) needs an external Qdrant: the compose stack no longer
bundles one. Leave `QDRANT_URL` unset to run memory-less (the plugin degrades to
a no-op); point it at a reachable Qdrant to enable memory.

Credential/state dirs are mounted from the project's `./.secrets/...` (sources
hardcoded in `docker-compose.yml`). The global `~/.config/opencode` is not
mounted — custom providers are injected in code and provider auth lives in the
share dir's `auth.json`.

## Step 3 — Email auth

**IMAP + SMTP**

This is the low-friction path: one dedicated mailbox plus an app password. No
Google Cloud project, no OAuth client, no refresh-token expiry.

1. In `/opt/opencode-agent/.env`, set:

   ```bash
   AGENT_INBOX_EMAIL=myagent-andy@gmail.com
   USER_EMAIL=you@example.com
   EMAIL_PASSWORD=<mailbox app password>
   IMAP_HOST=imap.gmail.com
   SMTP_HOST=smtp.gmail.com
   ```

2. Optional knobs:
   - `EMAIL_USER` only if the login differs from `AGENT_INBOX_EMAIL`.
   - `IMAP_PORT` / `SMTP_PORT` if your provider does not use `993` / `465`.
   - `IMAP_SECURE` / `SMTP_SECURE` if you need STARTTLS or plaintext on a
     trusted network.
3. Restart the container and verify the logs show `[gmail] connected as <inbox>`.

Common providers expose the same shape: IMAP for receive, SMTP for send, app
password for auth. Gmail works with the mailbox address directly; if you use a
`+alias` inbox, `AGENT_INBOX_EMAIL` can stay on the alias while the login stays
the base mailbox (or you can set `EMAIL_USER` explicitly).

**OpenCode model auth:**

Run the login *inside the running container* so credentials land in the share
dir via its `XDG_DATA_HOME` mapping (container `/workspace/.local/share/opencode`
= host `./.secrets/opencode-share`):

```bash
# as deploy, container must be up
docker exec -it opencode-agent opencode auth login -p openai
```

This writes `auth.json` (OAuth tokens / API keys) to
`./.secrets/opencode-share/auth.json`. Repeat with `-p <provider>` for any other
provider you use (deepseek, zai, packyapi-usage, …). Custom provider
*definitions* come from code (`src/opencode-server-config.ts`), not a config
file.

## Step 4 — GitHub Actions secrets (on the repo)

Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | VPS IP / hostname |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_PORT` | SSH port (default 22) |
| `DEPLOY_PATH` | `/opt/opencode-agent` |
| `DEPLOY_SSH_KEY` | private key whose public half is in `deploy`'s `~/.ssh/authorized_keys` |

## Step 5 — First deploy

Push to `main` (triggers the Action), or run manually **as `deploy`**:

```bash
sudo -iu deploy bash -c 'cd /opt/opencode-agent && docker compose up -d --build'
```

## Step 6 — Verify

```bash
sudo -iu deploy bash -c 'cd /opt/opencode-agent && docker compose ps'
# logs should show, in order:
#   [opencode-serve] listening on http://127.0.0.1:4096
#   [opencode] connected; visibleSessions=...
#   [scheduler] recovered N task(s)
#   [gmail] connected as <inbox>           (if email bridge enabled)
docker compose -f /opt/opencode-agent/docker-compose.yml logs --tail 30 agent
# notes auth wired correctly:
#   container env has NOTES_REPO_TOKEN, notes remote is https://...
```

**First boot is slow — don't mistake it for a hang.** On the very first start
(especially on ARM / a slow link) opencode downloads its `ripgrep` binary and
loads plugins; the gap between `[opencode-serve] listening` and
`[opencode] connected` can be **60–90s**. During that window the server accepts
the port but doesn't answer requests yet, so an early `curl`/healthcheck returns
nothing (`HTTP 000`). Wait for `[opencode] connected` before concluding it's stuck.

**Notes is best-effort.** `scripts/ensure-notes.sh` now bootstraps the notes repo
*in place* (it never `mv`s the bind-mounted `notes/`), and a notes failure no
longer crash-loops the bridge — so a plain `docker compose up` works without any
host-side notes pre-clone. With no `NOTES_REPO_URL` it initializes a local-only
notes repo (sync off); with a bad token it logs the error and continues. A
healthy deploy still shows the `notes` remote as `https://...` with the token.

## Golden rules (avoid the known footguns)

- **Never run `docker compose` as root** on the VPS. Container state now lives
  under `/workspace` (not `/root`), so the old empty-`/root/...` failure is gone;
  running as `deploy` still keeps `.data`/`.secrets` file ownership consistent.
  Always `sudo -iu deploy`.
- **Notes auth = HTTPS token**, not SSH keys. A token in `.env` works in the
  container, on the host, and in CI identically; an SSH key only works for the
  one user whose home holds it.
- **Secrets never enter the repo.** They live in `.env` (gitignored) and
  `.secrets/` (gitignored, dockerignored) on the VPS, plus GitHub Actions
  secrets for CI.
- A **notes sync failure is non-fatal** to the deploy by design — it must never
  block shipping code.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Email bridge requires ...` on boot | incomplete IMAP env | set `EMAIL_PASSWORD`, `IMAP_HOST`, `SMTP_HOST` (and `EMAIL_USER` if needed), then restart |
| SMTP/IMAP auth failure | wrong mailbox password or using the normal login password | create/use a mailbox app password; verify host/port/TLS with the provider |
| `[gmail] skipping — missing credentials` | compose run as root, or IMAP env incomplete | recreate as `deploy`; confirm `.env` has the IMAP/SMTP settings |
| notes `pull --rebase` conflict during deploy | notes diverged (commits piled up locally) | resolve in `notes/`, push; ensure container can push (token set) |
| `Could not resolve hostname github.com-...` | SSH host alias only in one user's home | switch notes to HTTPS token (`NOTES_REPO_TOKEN`) |

## Maintenance: clear old email test state

After switching a mailbox setup or testing against a real inbox, the bridge may
pick up a large backlog from the inbox. If you also interrupted runs mid-flight, stale
`message_claims` rows can cause repeated skip logs until the 15-minute claim TTL
expires.

Recommended reset sequence:

1. Stop the bridge/container.
2. Archive old test mail out of the agent inbox. If old mail stays in INBOX and
   you clear `processed_messages`, the bridge will reprocess and may re-reply.
3. Clear only transient runtime state:

   ```bash
   ./scripts/clear-email-bridge-runtime-state.sh .data/gmail.db
   ```

This preserves `scheduled_tasks` and `scheduled_report_history`.

Deeper operational detail lives in the maintainer runbook (Gmail recovery,
account specifics). This document covers standing up and verifying a deployment.
