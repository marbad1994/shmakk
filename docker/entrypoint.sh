#!/bin/sh
# Container entrypoint: prepare the data volume, then start the web server.
set -e

mkdir -p "$HOME/.config/shmakk" "${SHMAKK_WORKSPACES_DIR:-/data/workspaces}" "$HOME/workspace"

# Built-in skills live in the (possibly brand-new) volume; sync them on boot.
node "${SHMAKK_APP_DIR:-/app}/scripts/install-skills.js" >/dev/null 2>&1 || true

# Cloned repositories are owned by this user, but a mounted volume may not be.
git config --global --add safe.directory '*' 2>/dev/null || true
git config --global init.defaultBranch main 2>/dev/null || true

if [ "$#" -gt 0 ]; then exec "$@"; fi

exec node "${SHMAKK_APP_DIR:-/app}/bin/shmakk.js" --web \
  --host 0.0.0.0 \
  --port "${PORT:-1029}" \
  --no-open \
  --workspace "$HOME/workspace"
