#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source ~/Polarisor/Agent_core/scripts/port-claim.sh

if ! curl -fsS --max-time 3 http://127.0.0.1:11050/api/health >/dev/null; then
  echo "PolarPort is unavailable; refusing to start an unmanaged preview." >&2
  exit 1
fi

PORT="$(claim_port "polarui-native-web-preview" "PolarUI" 13920)"
export POLAR_WEB_PORT="$PORT"
export POLAR_WEB_BIND="${POLAR_WEB_BIND:-127.0.0.1}"
export POLAR_NATIVE_IMAGE="${POLAR_NATIVE_IMAGE:-polar-native-web:local}"
export NODE_ENV="${NODE_ENV:-development}"
export POSTGRES_USER="${POSTGRES_USER:-polar}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-polar-native-local-preview}"
export POSTGRES_DB="${POSTGRES_DB:-polar_native_preview}"
export AUTH_PEPPER="${AUTH_PEPPER:-polar-native-local-preview-pepper-2026}"
export PUBLIC_APP_ORIGIN="${PUBLIC_APP_ORIGIN:-http://127.0.0.1:${PORT}}"
export COOKIE_SECURE="${COOKIE_SECURE:-false}"
export SMTP_HOST="${SMTP_HOST:-host.docker.internal}"
export SMTP_PORT="${SMTP_PORT:-1025}"
export SMTP_FROM="${SMTP_FROM:-Polar Native Preview <preview@polar.local>}"
export SMTP_SECURE="${SMTP_SECURE:-false}"

cd "$PROJECT_ROOT/templates/native-web"
echo "port=$PORT"
exec docker compose --project-name polarui-native-web-preview up --build
