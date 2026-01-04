#!/usr/bin/env bash
set -euo pipefail

# Helper: installs deps + installs/starts systemd service.
# Assumes repo is located at /opt/diments-gps-tracker (pas aan als nodig)

APP_DIR="${APP_DIR:-/opt/diments-gps-tracker}"

echo "📁 App dir: $APP_DIR"
cd "$APP_DIR"

echo "📦 Installing dependencies..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "🧷 Installing systemd service..."
sudo cp systemd/diments-gps-tracker.service /etc/systemd/system/diments-gps-tracker.service
sudo systemctl daemon-reload
sudo systemctl enable diments-gps-tracker.service
sudo systemctl restart diments-gps-tracker.service

echo "✅ Service status:"
sudo systemctl --no-pager --full status diments-gps-tracker.service || true

echo "🩺 Health check:"
curl -k "https://localhost:3000/api/health" || true
