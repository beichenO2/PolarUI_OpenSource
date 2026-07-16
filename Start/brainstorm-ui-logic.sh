#!/usr/bin/env bash
set -euo pipefail

POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}
BRAINSTORM_DIR=${BRAINSTORM_DIR:-~/Polarisor/PolarUI/.superpowers/brainstorm/ui-logic-20260716-v2}
BRAINSTORM_SERVER=${BRAINSTORM_SERVER:-~/.agents/skills/brainstorming/scripts/server.cjs}
NODE_BINARY=${BRAINSTORM_NODE_BINARY:-node}

curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null
curl -fsS --max-time 3 "$POLARPROCESS_URL/api/health" >/dev/null

source ~/Polarisor/Agent_core/scripts/port-claim.sh
BRAINSTORM_PORT=$(claim_port "polarui-brainstorm-ui-logic" "PolarUI" 14950)
if [ "$BRAINSTORM_PORT" != 14950 ]; then
  release_port "$BRAINSTORM_PORT"
  printf 'polarui brainstorm: expected PolarPort 14950, got %s\n' "$BRAINSTORM_PORT" >&2
  exit 1
fi

export BRAINSTORM_DIR BRAINSTORM_PORT
export BRAINSTORM_HOST=${BRAINSTORM_HOST:-127.0.0.1}
export BRAINSTORM_URL_HOST=${BRAINSTORM_URL_HOST:-localhost}
exec "$NODE_BINARY" "$BRAINSTORM_SERVER"
