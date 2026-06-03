#!/usr/bin/env bash
# evolution-loop 单次 Cron tick — launchd / 手动调用
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p logs

export PATH="${PATH:-}:${HOME}/.nvm/versions/node/v22.22.2/bin:/opt/homebrew/bin:/usr/local/bin"

preflight() {
  local ok=1
  curl -sf --max-time 5 http://127.0.0.1:12790/health >/dev/null && ok=0
  curl -sf --max-time 5 http://127.0.0.1:8040/api/ui/agents >/dev/null || true
  curl -sf --max-time 5 http://127.0.0.1:3800/api/health >/dev/null || true
  return "$ok"
}

if ! curl -sf --max-time 3 http://127.0.0.1:3922/health >/dev/null 2>&1; then
  node scripts/run-trace-bridge.mjs >>logs/run-trace-bridge.log 2>&1 &
  sleep 1
fi

if ! preflight; then
  echo "[cron-tick] WARN: PolarPrivate/Hub/DIGiST 未全就绪，仍尝试 execute" >&2
fi

ARGS=()
if [[ "${POLAR_EVOLUTION_LIVE_LLM:-0}" == "1" ]]; then
  ARGS+=(--live-llm)
fi

exec npx tsx scripts/run-evolution-loop-execute.ts ${ARGS[@]+"${ARGS[@]}"}
