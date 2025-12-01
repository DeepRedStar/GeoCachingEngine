#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOCK_BIN="$ROOT_DIR/scripts/mock-bin"
LOG_DIR="$ROOT_DIR/tmp"
LOG_FILE="$LOG_DIR/quickstart-mock.log"

mkdir -p "$LOG_DIR"
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/systemd/system /opt/geocachingengine /var/lib/postgresql

cat >/etc/os-release <<'OSRELEASE'
NAME="Ubuntu"
VERSION_ID="22.04"
ID=ubuntu
OSRELEASE

PATH="$MOCK_BIN:$PATH"
export PATH

bash -x "$ROOT_DIR/deploy/quickstart.sh" 2>&1 | tee "$LOG_FILE"

echo "Mock run complete. Log stored at ${LOG_FILE}".
echo "Credential file content (if created):"
if [[ -f /root/geocachingengine-credentials.txt ]]; then
  cat /root/geocachingengine-credentials.txt
else
  echo "not created"
fi
