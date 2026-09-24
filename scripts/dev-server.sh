#!/bin/bash
# Start Simulcast detached (survives shell tool teardown).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
# Kill previous instance if any.
if [ -f /tmp/simulcast.pid ]; then
  kill "$(cat /tmp/simulcast.pid)" 2>/dev/null || true
  sleep 0.5
fi
setsid .venv/bin/python -m uvicorn server.main:app \
  --host "${HOST:-127.0.0.1}" \
  --port "${PORT:-8765}" \
  --log-level "${LOG_LEVEL:-info}" \
  > /tmp/simulcast.log 2>&1 < /dev/null &
echo $! > /tmp/simulcast.pid
echo "started pid=$(cat /tmp/simulcast.pid) cwd=$(pwd)"
