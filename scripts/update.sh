#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$APP_DIR"

echo "📦 Pulling latest code..."
git pull --ff-only

echo "📦 Installing dependencies..."
# op Jetson (langzaam): npm ci is het netst als package-lock aanwezig is
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "🔁 Restarting service..."
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart diments-gps-tracker.service
  sudo systemctl --no-pager --full status diments-gps-tracker.service || true
else
  echo "⚠️ systemctl niet gevonden. Restart handmatig (pm2 of node)."
fi

echo "✅ Done."
