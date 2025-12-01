#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/geocachingengine}

cd "$APP_DIR"
git pull
npm install
npm run migrate || true
npm run build
systemctl restart geocaching-backend.service geocaching-frontend.service
