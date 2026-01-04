\
#!/usr/bin/env bash
set -euo pipefail

# Installeer Node op basis van Ubuntu versie.
# JetPack 4.x = Ubuntu 18.04 -> Node 16 (meestal veilig)
# JetPack 5.x = Ubuntu 20.04 -> Node 18
# Dit script probeert NodeSource packages te gebruiken.

if ! command -v lsb_release >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y lsb-release
fi

VER="$(lsb_release -rs || true)"
echo "Detected Ubuntu version: ${VER:-unknown}"

if [[ "${VER}" == 18.* ]]; then
  NODE_SETUP="16"
elif [[ "${VER}" == 20.* ]]; then
  NODE_SETUP="18"
else
  echo "⚠️ Onbekende Ubuntu versie. Ik pak Node 18 als default. Als dit faalt: gebruik Node 16."
  NODE_SETUP="18"
fi

echo "Installing Node.js ${NODE_SETUP}.x via NodeSource..."
curl -fsSL "https://deb.nodesource.com/setup_${NODE_SETUP}.x" | sudo -E bash -
sudo apt install -y nodejs

echo "Node: $(node -v)"
echo "NPM : $(npm -v)"
