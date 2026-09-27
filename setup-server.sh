#!/usr/bin/env bash
# One-time server prep for Ubuntu on AWS Lightsail (safe to re-run).
# Usage: bash scripts/setup-server.sh
set -euo pipefail

echo "==> Updating packages"
sudo apt-get update -y && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y

if ! command -v docker >/dev/null; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  NEED_RELOGIN=1
fi

if ! swapon --show | grep -q /swapfile; then
  echo "==> Adding 2 GB swap"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Enabling automatic security updates"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades >/dev/null
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

mkdir -p backups secrets

if [ ! -f .env ]; then
  echo "==> Creating .env with generated secrets"
  cp .env.example .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^HUB_ENCRYPTION_KEY=.*|HUB_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env
  sed -i "s|^HUB_JWT_SECRET=.*|HUB_JWT_SECRET=$(openssl rand -hex 32)|" .env
  echo "    Now edit .env and set HUB_DOMAIN, ACME_EMAIL and ANTHROPIC_API_KEY:  nano .env"
fi

echo
echo "Done."
if [ "${NEED_RELOGIN:-0}" = "1" ]; then
  echo "Docker was just installed: close this SSH window and open a new one before running docker commands."
fi
