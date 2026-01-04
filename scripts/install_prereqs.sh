\
#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y git curl ca-certificates openssh-server build-essential

sudo systemctl enable --now ssh

echo "✅ Prereqs installed. SSH is enabled."
