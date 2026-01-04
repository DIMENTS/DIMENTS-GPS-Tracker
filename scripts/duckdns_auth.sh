\
#!/usr/bin/env bash
set -euo pipefail

# Certbot manual-auth-hook for DuckDNS DNS-01
# Uses DuckDNS API to set TXT record.
# Expects DUCKDNS_TOKEN in environment or in /opt/diments-gps-tracker/.env

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
: "${CERTBOT_VALIDATION:?CERTBOT_VALIDATION missing}"

# DuckDNS expects the subdomain name (not the full irllogging.duckdns.org)
SUB="${CERTBOT_DOMAIN%%.*}"

echo "Setting DuckDNS TXT for ${SUB}.duckdns.org ..."
RESP="$(curl -fsS "https://www.duckdns.org/update?domains=${SUB}&token=${DUCKDNS_TOKEN}&txt=${CERTBOT_VALIDATION}&verbose=true")"
echo "DuckDNS response: ${RESP}"

# Give DNS some time to propagate
sleep 35
