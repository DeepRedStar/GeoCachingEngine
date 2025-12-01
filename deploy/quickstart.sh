#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Dieser Quickstart muss als root ausgeführt werden (sudo -i)." >&2
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "Das Betriebssystem konnte nicht erkannt werden. Bitte nutzen Sie das Expert-Setup." >&2
  exit 1
fi

. /etc/os-release
SUPPORTED=false
case "$ID" in
  debian)
    [[ "$VERSION_ID" == "11" || "$VERSION_ID" == "12" ]] && SUPPORTED=true
    ;;
  ubuntu)
    [[ "$VERSION_ID" == "20.04" || "$VERSION_ID" == "22.04" ]] && SUPPORTED=true
    ;;
esac

if [[ "$SUPPORTED" != "true" ]]; then
  echo "Dieses Quickstart-Skript unterstützt nur Debian 11/12 und Ubuntu 20.04/22.04." >&2
  echo "Bitte verwenden Sie das Expert-Setup in deploy/install.sh." >&2
  exit 1
fi

APP_USER=${APP_USER:-geocaching}
APP_DIR=${APP_DIR:-/opt/geocachingengine}
NODE_MAJOR=${NODE_MAJOR:-20}
DB_NAME=${DB_NAME:-geocaching}
DB_USER=${DB_USER:-geocaching_app}
REPO_URL=${REPO_URL:-"https://github.com/DeepRedStar/GeoCachingEngine.git"}
ENV_FILE=${ENV_FILE:-"$APP_DIR/.env"}
CREDS_FILE=${CREDS_FILE:-/root/geocachingengine-credentials.txt}
DEPLOY_MODE=${DEPLOY_MODE:-public}

random_secret() {
  LC_ALL=C tr -dc 'A-Za-z0-9._%+-' < /dev/urandom | head -c 24
}

read -r -p "Deployment-Modus [public/lan] (Standard: public): " DEPLOY_CHOICE
DEPLOY_MODE="${DEPLOY_MODE:-public}"
if [[ "${DEPLOY_CHOICE:-}" == "lan" ]]; then
  DEPLOY_MODE="local"
fi

PUBLIC_DOMAIN=""
if [[ "$DEPLOY_MODE" == "public" ]]; then
  read -r -p "Domain (z.B. geocache.example.org): " PUBLIC_DOMAIN
fi

PRIMARY_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
BASE_URL="http://${PUBLIC_DOMAIN:-${PRIMARY_IP:-localhost}}"
ADMIN_EMAIL="admin@${PUBLIC_DOMAIN:-localdomain}"
ADMIN_PASSWORD=$(random_secret)
DB_PASSWORD=$(random_secret)

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl git gnupg lsb-release software-properties-common sudo

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

apt-get install -y postgresql postgresql-contrib postgresql-client nginx

id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME') THEN
    CREATE DATABASE $DB_NAME OWNER $DB_USER;
  END IF;
END$$;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL

if [[ ! -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
else
  sudo -u "$APP_USER" git -C "$APP_DIR" pull
fi

cat >"$ENV_FILE" <<EOF_ENV
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
PUBLIC_URL=$BASE_URL
INSTANCE_NAME=GeoCachingEngine
DEFAULT_LOCALES=en
ENABLED_LOCALES=en,de
CACHE_VISIBILITY_RADIUS=1000
CACHE_FOUND_RADIUS=50
IMPRESSUM_URL=${BASE_URL}/impressum
PRIVACY_URL=${BASE_URL}/privacy
SUPPORT_EMAIL=$ADMIN_EMAIL
DATA_RETENTION_DAYS=30
MAX_EMAILS_PER_HOUR_PER_ADMIN=50
MAX_EMAILS_PER_DAY_PER_ADMIN=200
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
BASE_URL=$BASE_URL
DEPLOY_MODE=$DEPLOY_MODE
PUBLIC_DOMAIN=$PUBLIC_DOMAIN
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

sudo -u "$APP_USER" npm install --prefix "$APP_DIR"
sudo -u "$APP_USER" npm run migrate --prefix "$APP_DIR"
sudo -u "$APP_USER" npm run build --prefix "$APP_DIR"

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
nginx -t && systemctl reload nginx

umask 077
cat >"$CREDS_FILE" <<EOF_CREDS
GeoCachingEngine Quickstart Credentials
======================================
Admin URL: ${BASE_URL}/admin
Admin E-Mail: ${ADMIN_EMAIL}
Admin Passwort: ${ADMIN_PASSWORD}

Datenbank:
  Name: ${DB_NAME}
  Nutzer: ${DB_USER}
  Passwort: ${DB_PASSWORD}
  Host: localhost
  Port: 5432

Hinweise:
- Diese Datei enthält sensible Informationen und ist nur für Administratoren bestimmt.
- Laden Sie die Datei auf ein sicheres System herunter und löschen Sie sie anschließend vom Server.
- Ändern Sie das Admin-Passwort nach dem ersten Login im Admin-Bereich.
EOF_CREDS
chmod 600 "$CREDS_FILE"

cat <<EOM
Quickstart abgeschlossen.
Die Zugangsdaten wurden in ${CREDS_FILE} gespeichert.
Bitte sichern Sie die Datei extern und löschen Sie sie anschließend vom Server.
Ändern Sie das Admin-Passwort nach dem ersten Login.
EOM
