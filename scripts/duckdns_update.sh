\
#!/usr/bin/env bash
set -euo pipefail

# Updates DuckDNS A record to current public IP.
# Needs DUCKDNS_TOKEN and DUCKDNS_SUBDOMAIN (e.g. "irllogging") in /opt/diments-gps-tracker/.env

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "❌ .env not found at ${ENV_FILE}"
  exit 1
fi

# load .env safely (expects KEY=VALUE lines)
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN missing in .env}"
: "${DUCKDNS_SUBDOMAIN:?DUCKDNS_SUBDOMAIN missing in .env}"

RESP="$(curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&verbose=true" || true)"
echo "$(date -Is) duckdns: ${RESP}"
