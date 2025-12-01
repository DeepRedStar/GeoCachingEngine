#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-$(pwd)}
ENV_FILE=${ENV_FILE:-$APP_DIR/.env}
NODE_CMD=${NODE_CMD:-node}
NPM_CMD=${NPM_CMD:-npm}

missing=()
for cmd in "$NODE_CMD" "$NPM_CMD" psql git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Fehlende Tools: ${missing[*]}. Bitte installieren Sie sie manuell (Expert-Setup)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Keine .env gefunden ($ENV_FILE). Legen Sie eine Umgebungskonfiguration an, bevor Sie fortfahren." >&2
  exit 1
fi

pushd "$APP_DIR" >/dev/null
$NPM_CMD install
$NPM_CMD run migrate || true
$NPM_CMD run build
popd >/dev/null

echo "Build und Migrationen abgeschlossen."
echo "Nutzen Sie deploy/nginx.conf.template und die systemd-Beispielservice-Datei als Vorlage für Ihre Umgebung." 
