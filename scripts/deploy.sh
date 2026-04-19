#!/usr/bin/env bash
set -euo pipefail

#─── Config ───────────────────────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${AGENTQUEUE_SERVICE:-agentqueue}"
SYSTEMCTL_SCOPE="${AGENTQUEUE_SYSTEMCTL_SCOPE:---user}"
HEALTH_URL="http://localhost:${PORT:-3000}/health"
HEALTH_TIMEOUT=15

#─── Helpers ──────────────────────────────────────────────────────────────────
info()  { printf "\033[1;34m▸ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
fail()  { printf "\033[1;31m✘ %s\033[0m\n" "$*" >&2; exit 1; }

cd "$APP_DIR"

#─── Pre-flight checks ───────────────────────────────────────────────────────
command -v node >/dev/null || fail "node not found — need Node >= 20"
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node >= 20 required (found $(node -v))"

[[ -f .env ]] || fail ".env file missing — copy .env.example and fill in values"

# shellcheck disable=SC1091
source .env 2>/dev/null || true
[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL not set — check .env"

info "Checking database reachability"
if ! node -e "const p=new (require('pg').Pool)({connectionString:process.env.DATABASE_URL});p.query('SELECT 1').then(()=>{p.end();process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null; then
  fail "Cannot reach database — check DATABASE_URL in .env"
fi
ok "Database reachable"

systemctl "$SYSTEMCTL_SCOPE" status "$SERVICE" >/dev/null 2>&1 || \
  fail "systemd unit '$SERVICE' not found (scope: $SYSTEMCTL_SCOPE) — install it before using deploy.sh"

#─── Pull latest ──────────────────────────────────────────────────────────────
info "Pulling latest changes"
git pull --ff-only || fail "git pull failed — resolve manually"
ok "Up to date"

#─── Install & Build ──────────────────────────────────────────────────────────
info "Installing dependencies"
npm ci --ignore-scripts 2>&1 | tail -1
npm rebuild 2>&1 | tail -1
ok "Dependencies installed"

info "Building"
npm run build
ok "Build complete"

info "Running database migrations"
npm run db:migrate
ok "Migrations applied"

#─── Restart ──────────────────────────────────────────────────────────────────
info "Restarting $SERVICE ($SYSTEMCTL_SCOPE)"
systemctl "$SYSTEMCTL_SCOPE" restart "$SERVICE"
ok "Restart requested"

#─── Health check ─────────────────────────────────────────────────────────────
info "Waiting for health check ($HEALTH_URL)"
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    ok "Healthy — deploy complete ✨"
    exit 0
  fi
  sleep 1
done

fail "Health check failed after ${HEALTH_TIMEOUT}s — check logs:\n  journalctl $SYSTEMCTL_SCOPE -u $SERVICE -n 100"
