#!/bin/bash
# Stable source launcher for PiWeb Miro. Never switches branches or updates code.
set -euo pipefail
readonly APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--check' ) ]]; then
  echo 'Usage: bash bin/miro-start.sh [--check]' >&2
  exit 2
fi
branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ "$branch" != 'miro/main' ]]; then
  echo "PiWeb Miro: refusing to start branch '${branch:-detached HEAD}'; expected miro/main. Finish and merge development work first." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'PiWeb Miro: refusing to start an uncommitted worktree. Commit/review changes before using the stable launcher.' >&2
  exit 1
fi
if [[ "${1:-}" == '--check' ]]; then
  echo 'PiWeb Miro: clean miro/main checkout verified.'
  exit 0
fi
if [[ ! -f node_modules/next/dist/bin/next ]]; then
  echo 'PiWeb Miro: dependencies are missing; install the reviewed package-lock.json first.' >&2
  exit 1
fi
export PI_WEB_NO_OPEN=1
echo "PiWeb Miro: starting miro/main ($(git rev-parse --short HEAD)) on ${PI_WEB_HOSTNAME:-127.0.0.1}:30141."
exec node "$APP_DIR/node_modules/next/dist/bin/next" dev --hostname "${PI_WEB_HOSTNAME:-127.0.0.1}" --port 30141
