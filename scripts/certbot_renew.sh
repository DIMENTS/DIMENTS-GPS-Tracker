\
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${APP_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot not installed"
  exit 0
fi

# Only attempt renewals; certbot decides if renewal is needed.
# Restart tracker only if renewal happened (deploy-hook runs only on success).
sudo -E certbot renew --quiet --deploy-hook "systemctl restart diments-gps-tracker.service"
