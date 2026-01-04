\
#!/usr/bin/env bash
set -euo pipefail

# Installeer certbot (apt preferred). Fallback naar snap als nodig.
if command -v certbot >/dev/null 2>&1; then
  echo "✅ certbot already installed: $(certbot --version)"
  exit 0
fi

echo "Installing certbot..."
sudo apt update

if sudo apt install -y certbot; then
  echo "✅ certbot installed via apt: $(certbot --version)"
  exit 0
fi

echo "⚠️ apt install certbot failed, trying snap..."
sudo apt install -y snapd
sudo snap install core || true
sudo snap refresh core || true
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot

echo "✅ certbot installed via snap: $(certbot --version)"
