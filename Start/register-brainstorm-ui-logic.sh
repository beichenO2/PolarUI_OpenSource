#!/usr/bin/env bash
set -euo pipefail

POLARPORT_URL=${POLARPORT_URL:-http://127.0.0.1:11050}
POLARPROCESS_URL=${POLARPROCESS_URL:-http://127.0.0.1:11055}

curl -fsS --max-time 3 "$POLARPORT_URL/api/health" >/dev/null
curl -fsS --max-time 3 "$POLARPROCESS_URL/api/health" >/dev/null
curl -fsS -X POST "$POLARPROCESS_URL/api/services/register" \
  -H 'Content-Type: application/json' \
  -d '{"id":"polarui-brainstorm-ui-logic","name":"PolarUI UI Logic Brainstorm","command":"bash Start/brainstorm-ui-logic.sh","work_dir":"~/Polarisor/PolarUI","device_id":"any","auto_start":false,"restart_on_failure":true,"max_restarts":3,"port":14950,"health_check_url":"http://127.0.0.1:14950/","start_script_dir":"-"}'
