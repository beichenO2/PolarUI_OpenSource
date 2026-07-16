#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1 text=$2
  grep -Fq "$text" "$file" || fail "$file does not contain $text"
}

assert_not_contains() {
  local file=$1 pattern=$2
  if grep -En "$pattern" "$file"; then
    fail "$file contains forbidden runtime behavior"
  fi
}

launcher="$ROOT/Start/gui.sh"
[ -x "$launcher" ] || fail "$launcher must exist and be executable"
assert_contains "$launcher" '127.0.0.1:11050'
assert_contains "$launcher" '127.0.0.1:11055'
assert_contains "$launcher" '/api/health'
assert_contains "$launcher" 'claim_port "polarui" "PolarUI" 5170'
assert_contains "$launcher" 'release_port'
assert_contains "$launcher" 'starting|running)'
assert_contains "$launcher" 'exec '
assert_not_contains "$launcher" '(^|[[:space:]])(nohup|disown|pkill|killall|kill|lsof)([[:space:]]|$)|PID_FILE|[^&]&[[:space:]]*$'

register="$ROOT/scripts/register-gui-runtime.sh"
assert_contains "$register" '/api/ports/reserve/polarui-dev/PolarUI'
assert_contains "$register" '/api/ports/reserve'
assert_contains "$register" 'id: "polarui"'
assert_contains "$register" 'command: "bash Start/gui.sh"'
assert_contains "$register" 'start_script_dir: "-"'
assert_not_contains "$register" 'api/services/.*/(start|stop|restart)'
assert_not_contains "$register" 'polarui-native-web-qa'

jq -e '
  .service_management.services
  | ([.[] | select(.service_id == "polarui" and .preferred_port == 5170 and .auto_start == true)] | length) == 1 and
    ([.[] | select(.service_id == "polarui-native-web-preview" and .preferred_port == 13920 and .auto_start == false)] | length) == 1
' "$ROOT/polaris.json" >/dev/null || fail "polaris.json does not preserve both stable PolarUI services"

jq -e '
  .requirements[]
  | select(.id == "R12")
  | .features[]
  | select(.name == "runtime_governance")
  | .status == "in-progress" or .status == "tested" or .status == "done"
' "$ROOT/polaris.json" >/dev/null || fail "runtime_governance SSoT is missing"

for skill in \
  "$ROOT/skills/polarui-usage/SKILL.md" \
  "$ROOT/skills/polarui-deploy/SKILL.md" \
  "$ROOT/skills/polarui-troubleshoot/SKILL.md"; do
  assert_contains "$skill" 'PolarProcess'
  assert_contains "$skill" 'PolarPort'
  assert_contains "$skill" '127.0.0.1:11055'
  assert_contains "$skill" 'polarui'
  assert_not_contains "$skill" '^[[:space:]]*(npm (run|start)|pnpm|yarn|pgrep|pkill|killall|nohup)|Start/gui\.sh'
done

for doc in "$ROOT/README.md" "$ROOT/docs/FRONTEND.md"; do
  assert_contains "$doc" '127.0.0.1:11055'
  assert_not_contains "$doc" '^[[:space:]]*(npm run (dev|preview)|npx vite|pnpm|yarn)'
done

printf 'PolarUI GUI runtime governance contract passed\n'
