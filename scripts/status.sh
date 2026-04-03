#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$APP_DIR/.agentqueue.pid"
HEALTH_URL="http://localhost:${PORT:-3000}/health"

if [[ ! -f "$PID_FILE" ]]; then
  echo "⏹  Not running (no PID file)"
  exit 1
fi

PID=$(cat "$PID_FILE")
if ! kill -0 "$PID" 2>/dev/null; then
  echo "⏹  Not running (stale PID $PID)"
  exit 1
fi

if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
  echo "✅ Running (PID $PID) — healthy"
else
  echo "⚠️  Running (PID $PID) — health check failing"
  exit 1
fi
