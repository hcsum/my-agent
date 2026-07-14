#!/usr/bin/env bash
set -euo pipefail

# Idempotent VPS provisioning for the opencode-agent bridge.
#
# Run ONCE on a fresh VPS as root:
#   curl -fsSL <raw-url>/scripts/provision-vps.sh | bash
# or, after cloning:
#   sudo bash scripts/provision-vps.sh
#
# It sets up everything that can be standardized in code. The remaining manual
# steps (secrets, OAuth, GitHub Actions secrets) are printed at the end. See
# docs/DEPLOY.md for the full procedure.
#
# Overridable via env:
#   APP_USER   (default: deploy)   unprivileged user that runs docker compose
#   APP_DIR    (default: /opt/opencode-agent)
#   REPO_URL   (default: empty)    clone source; skipped if APP_DIR already a repo

APP_USER="${APP_USER:-deploy}"
APP_DIR="${APP_DIR:-/opt/opencode-agent}"
REPO_URL="${REPO_URL:-}"

log() { printf '\n[provision] %s\n' "$*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[provision] must run as root" >&2
  exit 1
fi

# 1. Unprivileged app user ---------------------------------------------------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "creating user $APP_USER"
  useradd --create-home --shell /bin/bash "$APP_USER"
else
  log "user $APP_USER already exists"
fi

# 2. Docker engine + compose plugin -----------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker engine + compose plugin"
  curl -fsSL https://get.docker.com | sh
else
  log "docker already installed"
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "[provision] WARNING: 'docker compose' plugin not available; install docker-compose-plugin" >&2
fi

# Let the app user drive docker without sudo.
if ! id -nG "$APP_USER" | tr ' ' '\n' | grep -qx docker; then
  log "adding $APP_USER to docker group"
  usermod -aG docker "$APP_USER"
fi

# 3. App directory + checkout ------------------------------------------------
if [[ ! -d "$APP_DIR/.git" ]]; then
  if [[ -n "$REPO_URL" ]]; then
    log "cloning $REPO_URL into $APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
  else
    echo "[provision] $APP_DIR is not a git checkout and REPO_URL is unset." >&2
    echo "[provision] Clone the repo to $APP_DIR (or re-run with REPO_URL=...)." >&2
    exit 1
  fi
else
  log "repo already present at $APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# 4. Standardized credential/state dirs (project-relative, never ~) ----------
log "creating .secrets/ credential dirs"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/.secrets"
for d in opencode-share; do
  install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/.secrets/$d"
done

# 5. .env scaffold -----------------------------------------------------------
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -f "$APP_DIR/.env.example" ]]; then
    log "scaffolding .env from .env.example (FILL IN SECRETS before deploying)"
    install -o "$APP_USER" -g "$APP_USER" -m 600 "$APP_DIR/.env.example" "$APP_DIR/.env"
  else
    echo "[provision] no .env.example found; create $APP_DIR/.env manually" >&2
  fi
else
  log ".env already exists; leaving it untouched"
fi

cat <<EOF

[provision] Base setup complete. Remaining MANUAL steps (cannot be code-ified):

  1. Fill secrets in $APP_DIR/.env
       - NOTES_REPO_URL + NOTES_REPO_TOKEN (fine-grained PAT, Contents R/W)
       - BROWSERBASE_* / CAPSOLVER_API_KEY (if used)
       - USER_EMAIL / AGENT_INBOX_EMAIL
       - EMAIL_PASSWORD / IMAP_HOST / SMTP_HOST
  2. OpenCode model auth (one-time): run \`opencode auth login\` so
     credentials land in $APP_DIR/.secrets/opencode-share/.
  3. GitHub Actions secrets on the repo:
       DEPLOY_HOST, DEPLOY_USER=$APP_USER, DEPLOY_PORT, DEPLOY_PATH=$APP_DIR,
       DEPLOY_SSH_KEY (private key whose public half is in
       $APP_USER's ~/.ssh/authorized_keys)
  4. First deploy: push to main (GitHub Action) OR, as $APP_USER, run
       cd $APP_DIR && docker compose up -d --build

  IMPORTANT: always run docker compose as $APP_USER, never as root.
EOF
