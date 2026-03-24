#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/.openclaw/workspace/trump-truth-bot
export RUN_MODE=daemon
exec /home/ubuntu/nvm/versions/node/v24.14.0/bin/node src/index.js
