\
#!/usr/bin/env bash
set -euo pipefail

# Issues/ensures Let's Encrypt cert for your DuckDNS domain using DNS-01 via DuckDNS TXT API.
# Requires in .env:
#   DOMAIN=irllogging.duckdns.org
#   LE_EMAIL=you@example.com
#   DUCKDNS_TOKEN=...
# Also uses scripts/duckdns_auth.sh and scripts/duckdns_cleanup.sh

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "❌ .env not found at ${ENV_FILE}"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${DOMAIN:?DOMAIN missing in .env}"
: "${LE_EMAIL:?LE_EMAIL missing in .env}"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN missing in .env}"

if ! command -v certbot >/dev/null 2>&1; then
  echo "❌ certbot not found. Run: bash scripts/install_certbot.sh"
  exit 1
fi

sudo mkdir -p /etc/letsencrypt

echo "Requesting certificate for: ${DOMAIN}"
sudo -E certbot certonly \
  --manual \
  --preferred-challenges dns \
  --manual-auth-hook "${APP_DIR}/scripts/duckdns_auth.sh" \
  --manual-cleanup-hook "${APP_DIR}/scripts/duckdns_cleanup.sh" \
  --non-interactive \
  --agree-tos \
  --manual-public-ip-logging-ok \
  -m "${LE_EMAIL}" \
  -d "${DOMAIN}"

echo "✅ Certificate created/updated at: /etc/letsencrypt/live/${DOMAIN}/"
echo "👉 Next: enable renew timer: sudo systemctl enable --now diments-certbot-renew.timer"
