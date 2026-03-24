import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { XMLParser } from 'fast-xml-parser';
import { Agent, setGlobalDispatcher } from 'undici';

dotenv.config();
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const FEED_URL = process.env.FEED_URL || 'https://www.trumpstruth.org/feed';
const ROOT = path.resolve(process.cwd());
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const UPDATES_FILE = path.join(DATA_DIR, 'updates.json');

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  parseTagValue: false,
});

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return items
    .map((item) => {
      const link = item.link || item.guid;
      const text = stripHtml(item.description || item.title || '');
      const pubDate = item.pubDate || item.published || new Date().toUTCString();
      return {
        id: link || `${pubDate}:${text.slice(0, 80)}`,
        link,
        text,
        title: stripHtml(item.title || ''),
        pubDate,
        timestamp: new Date(pubDate).toISOString(),
      };
    })
    .filter((item) => item.text && item.link)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

async function telegram(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.description}`);
  }
  return json.result;
}

function formatPost(post) {
  return [
    '🇺🇸 <b>Trump Truth 更新</b>',
    '',
    escapeHtml(post.text),
    '',
    `🕒 ${escapeHtml(post.pubDate)}`,
    `🔗 ${escapeHtml(post.link)}`,
  ].join('\n');
}

async function handleUpdates(latestPost) {
  const updatesState = loadJson(UPDATES_FILE, { lastUpdateId: 0 });
  const subscribersState = loadJson(SUBSCRIBERS_FILE, { chats: [] });
  const chats = new Set(subscribersState.chats || []);

  const updates = await telegram('getUpdates', {
    offset: updatesState.lastUpdateId + 1,
    timeout: 0,
    allowed_updates: ['message'],
  });

  for (const update of updates) {
    updatesState.lastUpdateId = update.update_id;
    const message = update.message;
    if (!message || !message.chat || !message.text) continue;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text.startsWith('/start')) {
      chats.add(chatId);
      await telegram('sendMessage', {
        chat_id: chatId,
        text: '已订阅特朗普 Truth Social 更新。我会每分钟检查一次，有新帖就推送给你。\n\n命令：\n/start 订阅\n/stop 取消订阅\n/latest 查看最新一条',
      });
    } else if (text.startsWith('/stop')) {
      chats.delete(chatId);
      await telegram('sendMessage', {
        chat_id: chatId,
        text: '已取消订阅。',
      });
    } else if (text.startsWith('/latest')) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: latestPost ? stripHtml(formatPost(latestPost)) : '还没抓到最新帖子，稍后再试。',
      });
    }
  }

  subscribersState.chats = [...chats];
  saveJson(UPDATES_FILE, updatesState);
  saveJson(SUBSCRIBERS_FILE, subscribersState);
  return subscribersState.chats;
}

async function fetchLatestPosts() {
  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': 'trump-truth-bot/1.0' },
  });

  if (!res.ok) {
    throw new Error(`Feed request failed: ${res.status}`);
  }

  const xml = await res.text();
  const parsed = parser.parse(xml);
  return normalizeItems(parsed?.rss?.channel?.item || []);
}

async function main() {
  const state = loadJson(STATE_FILE, { lastSeenId: null, lastCheckedAt: null, latestPost: null });
  const posts = await fetchLatestPosts();
  const latestPost = posts[posts.length - 1] || null;

  const subscribers = await handleUpdates(latestPost);

  if (!latestPost) {
    state.lastCheckedAt = new Date().toISOString();
    saveJson(STATE_FILE, state);
    console.log('No posts found.');
    return;
  }

  state.latestPost = latestPost;

  const isNew = state.lastSeenId && state.lastSeenId !== latestPost.id;

  if (!state.lastSeenId) {
    state.lastSeenId = latestPost.id;
    state.lastCheckedAt = new Date().toISOString();
    saveJson(STATE_FILE, state);
    console.log('Initialized with latest post:', latestPost.id);
    return;
  }

  if (isNew) {
    for (const chatId of subscribers) {
      try {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: formatPost(latestPost),
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        });
      } catch (error) {
        console.error(`Failed to send message to ${chatId}:`, error.message);
      }
    }
    state.lastSeenId = latestPost.id;
  }

  state.lastCheckedAt = new Date().toISOString();
  saveJson(STATE_FILE, state);
  console.log(isNew ? `Sent new post ${latestPost.id} to ${subscribers.length} chats.` : 'No new post.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
