#!/bin/sh
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Please install Node.js 20 or newer from https://nodejs.org then run again.'
  printf 'Press Enter to close: '; read -r answer
  exit 1
fi
if [ ! -f node_modules/qrcode/package.json ]; then
  npm ci --no-audit --no-fund || { printf 'Installation failed. Press Enter to close: '; read -r answer; exit 1; }
fi
node server.mjs
printf 'Press Enter to close: '; read -r answer
