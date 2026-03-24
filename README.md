# trump-truth-bot

一个每分钟检查一次特朗普 Truth Social 新帖，并通过 Telegram bot 推送给订阅用户的小项目。

## 功能

- 常驻长轮询，Telegram 命令秒级响应
- 持续检查 `https://www.trumpstruth.org/feed`，默认每分钟一次
- 只推送原创帖，自动过滤转发 / 无标题分享帖
- 自动附带中文翻译
- 支持 Telegram 命令：
  - `/start` 开始订阅
  - `/stop` 取消订阅
  - `/latest` 查看最新一条
  - `/count` 查看订阅人数（管理员）
  - `/subscribers` 查看订阅列表（管理员）
- 新用户订阅 / 取消订阅时，管理员会收到提醒
- 本地 JSON 状态存储，避免重复推送

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

```bash
BOT_TOKEN=你的 Telegram Bot Token
FEED_URL=https://www.trumpstruth.org/feed
```

## 本地运行

单次执行：

```bash
npm install
npm run run-once
```

常驻运行：

```bash
npm install
npm start
```

也可以直接运行：

```bash
./run-bot.sh
```

## 已配置的机器人

- Bot 名称：`川普说`
- 用户名：`@trump_taco_truth_bot`

用户需要先在 Telegram 里打开 bot 并发送 `/start`，之后才能收到推送。
