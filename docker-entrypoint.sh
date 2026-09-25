#!/bin/sh
# Entrypoint: MediaMTX (RTMP) + Simulcast API.
set -eu

if [ "${SKIP_MEDIAMTX:-0}" != "1" ] && command -v /mediamtx >/dev/null 2>&1; then
  echo "[entrypoint] starting MediaMTX (RTMP :1935)"
  /mediamtx /mediamtx.yml &
fi

echo "[entrypoint] starting Simulcast API on ${SIMULCAST_HOST:-0.0.0.0}:${SIMULCAST_PORT:-8000}"
exec python -m uvicorn server.main:app \
  --host "${SIMULCAST_HOST:-0.0.0.0}" \
  --port "${SIMULCAST_PORT:-8000}" \
  --log-level "${SIMULCAST_LOG_LEVEL:-info}"
