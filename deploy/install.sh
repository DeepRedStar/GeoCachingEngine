#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root" >&2
  exit 1
fi

APP_USER="geocaching"
APP_DIR="/opt/geocaching"
NODE_VERSION="20"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git gnupg ca-certificates lsb-release software-properties-common

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
fi

if ! command -v npm >/dev/null 2>&1; then
  apt-get install -y npm
fi

apt-get install -y postgresql postgresql-contrib postgresql-client nginx unattended-upgrades

id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"

mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone https://example.com/GeoCachingEngine.git "$APP_DIR"
fi

cd "$APP_DIR"
sudo -u "$APP_USER" npm install
sudo -u "$APP_USER" npm run build || true

cat >/etc/systemd/system/geocaching-backend.service <<SERVICE
[Unit]
Description=GeoCachingEngine API
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $APP_DIR/backend/dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/systemd/system/geocaching-frontend.service <<SERVICE
[Unit]
Description=GeoCachingEngine Frontend
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/npm run start:frontend -- --host 0.0.0.0 --port 4173
Restart=on-failure

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable geocaching-backend.service geocaching-frontend.service
systemctl restart geocaching-backend.service geocaching-frontend.service

dpkg-reconfigure --priority=low unattended-upgrades

echo "Installation complete. Update .env before starting production traffic."
