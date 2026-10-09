#!/usr/bin/env bash
# Usage: bash check.sh [areas]   e.g. bash check.sh chat,call
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund --silent
node setup.mjs
node check.mjs "$@"
