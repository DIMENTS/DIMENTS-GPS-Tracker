\
#!/usr/bin/env bash
set -euo pipefail

# Certbot manual-cleanup-hook for DuckDNS DNS-01
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

if [[ -z "${DUCKDNS_TOKEN:-}" && -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN missing}"
: "${CERTBOT_DOMAIN:?CERTBOT_DOMAIN missing}"

SUB="${CERTBOT_DOMAIN%%.*}"

echo "Clearing DuckDNS TXT for ${SUB}.duckdns.org ..."
RESP="$(curl -fsS "https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&clear=true&verbose=true" || true)"
echo "DuckDNS response: ${RESP}"
