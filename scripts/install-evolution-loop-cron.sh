#!/usr/bin/env bash
# 安装 evolution-loop launchd Cron（用户级 LaunchAgents）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$ROOT/scripts/com.polarisor.evolution-loop-cron.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.polarisor.evolution-loop-cron.plist"
TICK="$ROOT/scripts/evolution-loop-cron-tick.sh"

chmod +x "$TICK"
mkdir -p "$ROOT/logs"

if launchctl list 2>/dev/null | grep -q com.polarisor.evolution-loop-cron; then
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

cp "$PLIST_SRC" "$PLIST_DST"
launchctl load "$PLIST_DST"

echo "OK: loaded $PLIST_DST"
echo "日志: $ROOT/logs/evolution-loop-cron.{stdout,stderr}.log"
echo "启用真实 LLM: 编辑 plist 中 POLAR_EVOLUTION_LIVE_LLM=1 后 launchctl unload/load"
echo "卸载: launchctl unload $PLIST_DST && rm $PLIST_DST"
