#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '\n  Node.js is not installed.\n  Get it from https://nodejs.org then run this again.\n\n'
  exit 1
fi
exec node server.js
