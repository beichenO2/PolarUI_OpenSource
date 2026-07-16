#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}

curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null
curl -fsS --max-time 3 "$POLARPROCESS_URL/api/health" >/dev/null

# Retire only the duplicate legacy GUI reservation. Native preview and all QA
# service identities are separate protected runtime boundaries.
curl -fsS -X DELETE "$POLARPORT_URL/api/ports/reserve/polarui-dev/PolarUI" >/dev/null
curl -fsS -X POST "$POLARPORT_URL/api/ports/reserve" \
  -H 'Content-Type: application/json' \
  -d '{"service_name":"polarui","project":"PolarUI","preferred_port":5170}' >/dev/null

payload=$(jq -n \
  --arg work_dir "$PROJECT_DIR" \
  '{
    id: "polarui",
    name: "PolarUI GUI Preview",
    command: "bash Start/gui.sh",
    work_dir: $work_dir,
    device_id: "any",
    auto_start: true,
    restart_on_failure: true,
    max_restarts: 10,
    port: 5170,
    health_check_url: "http://127.0.0.1:5170/",
    start_script_dir: "-"
  }')

curl -fsS -X POST "$POLARPROCESS_URL/api/services/register" \
  -H 'Content-Type: application/json' \
  -d "$payload" >/dev/null

echo "Registered polarui GUI runtime without lifecycle actions; native preview and QA services were not modified"
