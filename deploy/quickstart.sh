#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-0} -ne 0 ]]; then
  echo "Bitte als root (sudo -i) ausführen." >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "/etc/os-release fehlt, OS konnte nicht erkannt werden. Bitte Expert-Setup verwenden." >&2
  exit 1
fi

. /etc/os-release
SUPPORTED=false
case "${ID:-}" in
  debian)
    [[ "${VERSION_ID:-}" == "11" || "${VERSION_ID:-}" == "12" ]] && SUPPORTED=true
    ;;
  ubuntu)
    [[ "${VERSION_ID:-}" == "20.04" || "${VERSION_ID:-}" == "22.04" ]] && SUPPORTED=true
    ;;
esac

if [[ "$SUPPORTED" != "true" ]]; then
  echo "Unterstützt sind Debian 11/12 sowie Ubuntu 20.04/22.04. Nutzen Sie sonst deploy/install.sh (Expert-Setup)." >&2
  exit 1
fi

APP_USER=${APP_USER:-geocaching}
APP_DIR=${APP_DIR:-/opt/geocachingengine}
NODE_MAJOR=${NODE_MAJOR:-20}
DB_NAME=${DB_NAME:-geocaching}
DB_USER=${DB_USER:-geocaching_app}
DB_PASSWORD=${DB_PASSWORD:-}
REPO_URL=${REPO_URL:-"https://github.com/DeepRedStar/GeoCachingEngine.git"}
ENV_FILE=${ENV_FILE:-"$APP_DIR/.env"}
CREDS_FILE=${CREDS_FILE:-/root/geocachingengine-credentials.txt}
DEPLOY_MODE=${DEPLOY_MODE:-public}
PUBLIC_DOMAIN=${PUBLIC_DOMAIN:-}

random_secret() {
  python3 - <<'PY'
import secrets
import string
alphabet = string.ascii_letters + string.digits + "._%+-"
print(''.join(secrets.choice(alphabet) for _ in range(24)))
PY
}

read -r -p "Deployment-Modus [public/lan] (Standard: public): " DEPLOY_CHOICE || true
DEPLOY_MODE="public"
if [[ "${DEPLOY_CHOICE,,}" == "lan" ]]; then
  DEPLOY_MODE="lan"
fi

if [[ "$DEPLOY_MODE" == "public" ]]; then
  read -r -p "Domain (z.B. geocache.example.org): " PUBLIC_DOMAIN || true
fi

PRIMARY_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
BASE_URL="http://${PUBLIC_DOMAIN:-${PRIMARY_IP:-localhost}}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl git gnupg lsb-release software-properties-common sudo python3

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

apt-get install -y postgresql postgresql-contrib postgresql-client nginx

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$APP_USER"
fi

mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

DB_PASSWORD=${DB_PASSWORD:-$(random_secret)}
ADMIN_EMAIL="admin@${PUBLIC_DOMAIN:-localdomain}"
ADMIN_PASSWORD=$(random_secret)

sudo -u postgres -H psql -v ON_ERROR_STOP=1 <<EOF_SQL
DO
\$do\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE "${DB_USER}" LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}') THEN
    CREATE DATABASE "${DB_NAME}" OWNER "${DB_USER}";
  END IF;
END
\$do\$;
GRANT ALL PRIVILEGES ON DATABASE "${DB_NAME}" TO "${DB_USER}";
EOF_SQL

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
else
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
fi

cat >"$ENV_FILE" <<EOF_ENV
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
PUBLIC_URL=${BASE_URL}
INSTANCE_NAME=GeoCachingEngine
DEFAULT_LOCALES=en
ENABLED_LOCALES=en,de
CACHE_VISIBILITY_RADIUS=1000
CACHE_FOUND_RADIUS=50
IMPRESSUM_URL=${BASE_URL}/impressum
PRIVACY_URL=${BASE_URL}/privacy
SUPPORT_EMAIL=${ADMIN_EMAIL}
DATA_RETENTION_DAYS=30
MAX_EMAILS_PER_HOUR_PER_ADMIN=50
MAX_EMAILS_PER_DAY_PER_ADMIN=200
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
BASE_URL=${BASE_URL}
DEPLOY_MODE=${DEPLOY_MODE}
PUBLIC_DOMAIN=${PUBLIC_DOMAIN}
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
SMTP_USE_TLS=false
SMTP_FROM_ADDRESS=
SMTP_FROM_NAME=
EOF_ENV
chmod 600 "$ENV_FILE"
chown "$APP_USER":"$APP_USER" "$ENV_FILE"

sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm install"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm run migrate"
sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm run build"

cat >/etc/systemd/system/geocaching-backend.service <<SERVICE
[Unit]
Description=GeoCachingEngine API
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm run start:backend --prefix $APP_DIR
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
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm run start:frontend --prefix $APP_DIR
Restart=on-failure

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable geocaching-backend.service geocaching-frontend.service
systemctl restart geocaching-backend.service geocaching-frontend.service

SERVER_NAME="${PUBLIC_DOMAIN:-_}"
cat >/etc/nginx/sites-available/geocachingengine.conf <<NGINX
server {
    listen 80;
    server_name ${SERVER_NAME};

    location /api/ {
        proxy_pass http://127.0.0.1:4000/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    location / {
        proxy_pass http://127.0.0.1:4173/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/geocachingengine.conf /etc/nginx/sites-enabled/geocachingengine.conf
if [[ -f /etc/nginx/sites-enabled/default ]]; then
  rm /etc/nginx/sites-enabled/default
fi
nginx -t
systemctl reload nginx

umask 077
cat >"$CREDS_FILE" <<EOF_CREDS
GeoCachingEngine – Schnellstart

Basis-URL: ${BASE_URL}
Admin-Login: ${ADMIN_EMAIL}
Admin-Passwort: ${ADMIN_PASSWORD}

Datenbank:
Name: ${DB_NAME}
Benutzer: ${DB_USER}
Passwort: ${DB_PASSWORD}
Host: localhost
Port: 5432

Hinweis:
Diese Datei enthält sensible Zugangsdaten. Bitte speichern Sie sie lokal und löschen Sie sie anschließend sicher vom Server (z.B. mit 'shred -u ${CREDS_FILE}'). Ändern Sie das Admin-Passwort beim ersten Login.
EOF_CREDS
chmod 600 "$CREDS_FILE"

echo "Quickstart abgeschlossen." >&2
echo "Zugangsdaten: $CREDS_FILE" >&2
echo "Bitte extern sichern und anschließend vom Server löschen. Admin-Passwort nach dem ersten Login ändern." >&2
