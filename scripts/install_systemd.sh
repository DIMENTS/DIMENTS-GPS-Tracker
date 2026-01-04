\
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sudo cp "${APP_DIR}/systemd/diments-gps-tracker.service" /etc/systemd/system/diments-gps-tracker.service
sudo cp "${APP_DIR}/systemd/duckdns.service" /etc/systemd/system/duckdns.service
sudo cp "${APP_DIR}/systemd/duckdns.timer" /etc/systemd/system/duckdns.timer
sudo cp "${APP_DIR}/systemd/diments-certbot-renew.service" /etc/systemd/system/diments-certbot-renew.service
sudo cp "${APP_DIR}/systemd/diments-certbot-renew.timer" /etc/systemd/system/diments-certbot-renew.timer

sudo systemctl daemon-reload

echo "✅ systemd units installed."
echo "Next:"
echo "  sudo systemctl enable --now diments-gps-tracker.service"
echo "  sudo systemctl enable --now duckdns.timer"
echo "  sudo systemctl enable --now diments-certbot-renew.timer"
