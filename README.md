# trump-truth-bot

一个每分钟检查一次特朗普 Truth Social 新帖，并通过 Telegram bot 推送给订阅用户的小项目。

## 功能

- 每分钟抓取 `https://www.trumpstruth.org/feed`
- 只推送原创帖，自动过滤转发 / 无标题分享帖
- 自动附带中文翻译
- 支持 Telegram 命令：
  - `/start` 开始订阅
  - `/stop` 取消订阅
  - `/latest` 查看最新一条
- 本地 JSON 状态存储，避免重复推送
- 适合用 `cron` 每分钟运行一次

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

```bash
BOT_TOKEN=你的 Telegram Bot Token
FEED_URL=https://www.trumpstruth.org/feed
```

## 本地运行

```bash
npm install
npm run run-once
```

## 配置每分钟运行

```bash
* * * * * cd /path/to/trump-truth-bot && /usr/bin/env bash -lc 'npm run run-once >> cron.log 2>&1'
```

## 已配置的机器人

- Bot 名称：`川普说`
- 用户名：`@trump_taco_truth_bot`

用户需要先在 Telegram 里打开 bot 并发送 `/start`，之后才能收到推送。
