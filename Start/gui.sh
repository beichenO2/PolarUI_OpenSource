#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}
SERVICE_ID=polarui
PREFERRED_PORT=5170
NODE_BIN=${POLARUI_NODE_BIN:-~/.nvm/versions/node/v22.22.2/bin/node}

if [ "$#" -ne 0 ]; then
  echo "PolarUI GUI lifecycle is managed by PolarProcess; do not pass arguments" >&2
  exit 2
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "PolarUI Node executable missing: $NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/dist/index.html" ]; then
  echo "PolarUI build artifact missing: dist/index.html" >&2
  exit 1
fi
if [ ! -f "$PROJECT_DIR/node_modules/vite/bin/vite.js" ]; then
  echo "PolarUI Vite executable missing; run npm ci as a transient install" >&2
  exit 1
fi
if ! curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null; then
  echo "PolarPort is unavailable; refusing preferred-port fallback" >&2
  exit 1
fi
if ! curl -fsS --max-time 3 "$POLARPROCESS_URL/api/health" >/dev/null; then
  echo "PolarProcess is unavailable; refusing unmanaged GUI start" >&2
  exit 1
fi

service_status=$(curl -fsS --max-time 3 "$POLARPROCESS_URL/api/services/$SERVICE_ID" | jq -r '.status')
case "$service_status" in
  starting|running) ;;
  *)
    echo "$SERVICE_ID may only be launched by its exact PolarProcess start action" >&2
    exit 1
    ;;
esac

source "$HOME/Polarisor/Agent_core/scripts/port-claim.sh"
PORT=$(claim_port "polarui" "PolarUI" 5170)
if [ "$PORT" -ne "$PREFERRED_PORT" ]; then
  release_port "$PORT"
  echo "PolarPort returned $PORT, but PolarUI GUI requires $PREFERRED_PORT" >&2
  exit 1
fi

cd "$PROJECT_DIR"
export PORT
export POLARUI_PORT=$PORT
export POLAR_RUNTIME_MANAGED=1
exec "$NODE_BIN" node_modules/vite/bin/vite.js preview --port "$PORT" --host 127.0.0.1 --strictPort
