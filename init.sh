#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "[init] 已创建 .env，请先填入 BOT_TOKEN 后再启动。"
else
  echo "[init] .env 已存在，跳过创建。"
fi

mkdir -p data

[[ -f data/state.json ]] || cp data/state.example.json data/state.json
[[ -f data/subscribers.json ]] || cp data/subscribers.example.json data/subscribers.json
[[ -f data/updates.json ]] || cp data/updates.example.json data/updates.json

/home/ubuntu/nvm/versions/node/v24.14.0/bin/npm install

echo "[init] 初始化完成。"
echo "[init] 下一步："
echo "  1) 编辑 $ROOT/.env"
echo "  2) 运行: npm start"
echo "  3) 或配置 systemd 服务"
