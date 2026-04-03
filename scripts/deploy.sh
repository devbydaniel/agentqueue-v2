#!/usr/bin/env bash
set -euo pipefail

#─── Config ───────────────────────────────────────────────────────────────────
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$APP_DIR/.agentqueue.pid"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/agentqueue.log"
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

#─── Pull latest ──────────────────────────────────────────────────────────────
info "Pulling latest changes"
git pull --ff-only || fail "git pull failed — resolve manually"
ok "Up to date"

#─── Install dependencies ─────────────────────────────────────────────────────
info "Installing dependencies"
npm ci --omit=dev 2>&1 | tail -1
ok "Dependencies installed"

#─── Build ────────────────────────────────────────────────────────────────────
info "Building"
# Need devDependencies for build (nest CLI, typescript, etc.)
npm ci 2>&1 | tail -1
npm run build
ok "Build complete"

# Prune devDependencies for production
npm prune --omit=dev 2>&1 | tail -1

#─── Stop existing process ────────────────────────────────────────────────────
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    info "Stopping existing process (PID $OLD_PID)"
    kill "$OLD_PID"
    # Wait up to 10s for graceful shutdown
    for i in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 1
    done
    # Force kill if still running
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    ok "Stopped"
  else
    info "Stale PID file (process $OLD_PID not running)"
  fi
  rm -f "$PID_FILE"
fi

#─── Start ────────────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
info "Starting (NODE_ENV=production)"

NODE_ENV=production nohup node dist/main.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
ok "Started (PID $(cat "$PID_FILE")) — logs: $LOG_FILE"

#─── Health check ─────────────────────────────────────────────────────────────
info "Waiting for health check ($HEALTH_URL)"
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    ok "Healthy — deploy complete ✨"
    exit 0
  fi
  sleep 1
done

fail "Health check failed after ${HEALTH_TIMEOUT}s — check logs:\n  tail -50 $LOG_FILE"
