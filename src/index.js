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
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '6894522404')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => Number(id));
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const TELEGRAM_LONG_POLL_SECONDS = Number(process.env.TELEGRAM_LONG_POLL_SECONDS || 50);
const RUN_MODE = process.env.RUN_MODE || (process.argv.includes('--daemon') ? 'daemon' : 'once');

const ROOT = path.resolve(process.cwd());
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SUBSCRIBERS_FILE = path.join(DATA_DIR, 'subscribers.json');
const UPDATES_FILE = path.join(DATA_DIR, 'updates.json');
const DELIVERY_FILE = path.join(DATA_DIR, 'delivery.json');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(text = '') {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function isOriginalPost(item) {
  const title = (item.title || '').trim();
  const description = item.description || '';
  const text = stripHtml(description || title);

  if (!text) return false;
  if (/^\[No Title\]/i.test(title)) return false;
  if (/^RT\b/i.test(title)) return false;
  if (/^RT\b/i.test(text)) return false;
  if (/quote-inline/i.test(description)) return false;
  return true;
}

function normalizeItems(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  return items
    .filter(isOriginalPost)
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
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
  return json.result;
}

async function translateToChinese(text) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', 'zh-CN');
  url.searchParams.set('dt', 't');
  url.searchParams.set('q', text);

  const res = await fetch(url, { headers: { 'user-agent': 'trump-truth-bot/1.0' } });
  if (!res.ok) throw new Error(`Translate request failed: ${res.status}`);

  const data = await res.json();
  return Array.isArray(data?.[0]) ? data[0].map((part) => part?.[0] || '').join('') : '';
}

function formatPost(post) {
  const zh = post.translation
    ? ['🇨🇳 <b>中文翻译</b>', '', escapeHtml(post.translation), '', '🇺🇸 <b>原文</b>', '']
    : [];
  return [
    '🇺🇸 <b>Trump Truth 更新</b>',
    '',
    ...zh,
    escapeHtml(post.text),
    '',
    `🕒 ${escapeHtml(post.pubDate)}`,
    `🔗 ${escapeHtml(post.link)}`,
  ].join('\n');
}

function isAdmin(chatId) {
  return ADMIN_CHAT_IDS.includes(Number(chatId));
}

function formatSubscriberList(chats) {
  if (!chats.length) return '当前没有订阅用户。';
  return ['当前订阅用户：', ...chats.map((id, index) => `${index + 1}. ${id}`)].join('\n');
}

function loadDeliveryState() {
  return loadJson(DELIVERY_FILE, { posts: {} });
}

function saveDeliveryState(state) {
  saveJson(DELIVERY_FILE, state);
}

function getDeliveredChatsForPost(deliveryState, postId) {
  return new Set(deliveryState?.posts?.[postId]?.deliveredChats || []);
}

function markChatDelivered(deliveryState, post, chatId) {
  if (!deliveryState.posts) deliveryState.posts = {};
  if (!deliveryState.posts[post.id]) {
    deliveryState.posts[post.id] = {
      link: post.link,
      pubDate: post.pubDate,
      deliveredChats: [],
      completed: false,
      lastAttemptAt: null,
      completedAt: null,
    };
  }

  const delivered = new Set(deliveryState.posts[post.id].deliveredChats || []);
  delivered.add(Number(chatId));
  deliveryState.posts[post.id].deliveredChats = [...delivered];
  deliveryState.posts[post.id].lastAttemptAt = new Date().toISOString();
}

function markDeliveryAttempt(deliveryState, post) {
  if (!deliveryState.posts) deliveryState.posts = {};
  if (!deliveryState.posts[post.id]) {
    deliveryState.posts[post.id] = {
      link: post.link,
      pubDate: post.pubDate,
      deliveredChats: [],
      completed: false,
      lastAttemptAt: null,
      completedAt: null,
    };
  }
  deliveryState.posts[post.id].lastAttemptAt = new Date().toISOString();
}

function finalizeDeliveryIfComplete(deliveryState, post, subscribers) {
  const delivered = getDeliveredChatsForPost(deliveryState, post.id);
  const allDelivered = subscribers.every((chatId) => delivered.has(Number(chatId)));
  if (!deliveryState.posts?.[post.id]) return allDelivered;

  deliveryState.posts[post.id].completed = allDelivered;
  deliveryState.posts[post.id].completedAt = allDelivered ? new Date().toISOString() : null;
  return allDelivered;
}

async function deliverPostToSubscribers(post, subscribers) {
  const deliveryState = loadDeliveryState();
  const deliveredBefore = getDeliveredChatsForPost(deliveryState, post.id);
  let successCount = 0;
  let failureCount = 0;

  for (const chatId of subscribers) {
    if (deliveredBefore.has(Number(chatId))) continue;

    markDeliveryAttempt(deliveryState, post);
    try {
      await sendLatest(chatId, post);
      markChatDelivered(deliveryState, post, chatId);
      saveDeliveryState(deliveryState);
      successCount += 1;
    } catch (error) {
      failureCount += 1;
      console.error(`Failed to send message to ${chatId}:`, error.message);
    }
  }

  const complete = finalizeDeliveryIfComplete(deliveryState, post, subscribers);
  saveDeliveryState(deliveryState);
  return { successCount, failureCount, complete, deliveredCount: getDeliveredChatsForPost(deliveryState, post.id).size };
}

async function notifyAdmins(text) {
  for (const chatId of ADMIN_CHAT_IDS) {
    try {
      await telegram('sendMessage', { chat_id: chatId, text });
    } catch (error) {
      console.error(`Failed to notify admin ${chatId}:`, error.message);
    }
  }
}

async function fetchLatestPosts() {
  const res = await fetch(FEED_URL, { headers: { 'user-agent': 'trump-truth-bot/1.0' } });
  if (!res.ok) throw new Error(`Feed request failed: ${res.status}`);

  const xml = await res.text();
  const parsed = parser.parse(xml);
  return normalizeItems(parsed?.rss?.channel?.item || []);
}

async function enrichPostWithTranslation(post) {
  if (!post) return null;
  return {
    ...post,
    translation: await translateToChinese(post.text).catch((error) => {
      console.error('Translation failed:', error.message);
      return '';
    }),
  };
}

async function getLatestPostWithTranslation() {
  const posts = await fetchLatestPosts();
  const latestPost = posts[posts.length - 1] || null;
  if (!latestPost) return null;

  return enrichPostWithTranslation(latestPost);
}

async function sendLatest(chatId, latestPost) {
  if (!latestPost) {
    await telegram('sendMessage', { chat_id: chatId, text: '还没抓到最新帖子，稍后再试。' });
    return;
  }

  await telegram('sendMessage', {
    chat_id: chatId,
    text: formatPost(latestPost),
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
}

async function processUpdates({ timeoutSeconds = 0, latestPost = null } = {}) {
  const updatesState = loadJson(UPDATES_FILE, { lastUpdateId: 0 });
  const subscribersState = loadJson(SUBSCRIBERS_FILE, { chats: [] });
  const chats = new Set(subscribersState.chats || []);

  const updates = await telegram('getUpdates', {
    offset: updatesState.lastUpdateId + 1,
    timeout: timeoutSeconds,
    allowed_updates: ['message'],
  });

  for (const update of updates) {
    updatesState.lastUpdateId = update.update_id;
    const message = update.message;
    if (!message || !message.chat || !message.text) continue;

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text.startsWith('/start')) {
      const wasSubscribed = chats.has(chatId);
      chats.add(chatId);
      await telegram('sendMessage', {
        chat_id: chatId,
        text: `✅ 订阅成功\n\n我会秒级响应命令，并持续检查特朗普 Truth Social，只推原创帖，并附中文翻译。\n\n可用命令：\n/start 订阅\n/stop 取消订阅\n/latest 查看最新一条\n/subscribers 查看订阅列表（管理员）\n/count 查看订阅人数（管理员）\n\n当前订阅人数：${chats.size}`,
      });
      if (!wasSubscribed) {
        await notifyAdmins(`📥 新用户订阅\nchat_id: ${chatId}\n当前订阅人数: ${chats.size}`);
      }
    } else if (text.startsWith('/stop')) {
      const wasSubscribed = chats.delete(chatId);
      await telegram('sendMessage', {
        chat_id: chatId,
        text: `✅ 已取消订阅\n\n之后不会再给你推送新帖。\n当前订阅人数：${chats.size}`,
      });
      if (wasSubscribed) {
        await notifyAdmins(`📤 用户取消订阅\nchat_id: ${chatId}\n当前订阅人数: ${chats.size}`);
      }
    } else if (text.startsWith('/latest')) {
      const latest = latestPost || loadJson(STATE_FILE, {}).latestPost || (await getLatestPostWithTranslation());
      await sendLatest(chatId, latest);
    } else if (text.startsWith('/count')) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: isAdmin(chatId) ? `当前订阅人数：${chats.size}` : '这个命令仅管理员可用。',
      });
    } else if (text.startsWith('/subscribers')) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: isAdmin(chatId) ? formatSubscriberList([...chats]) : '这个命令仅管理员可用。',
      });
    }
  }

  subscribersState.chats = [...chats];
  saveJson(UPDATES_FILE, updatesState);
  saveJson(SUBSCRIBERS_FILE, subscribersState);
  return subscribersState.chats;
}

async function checkForNewPost() {
  const state = loadJson(STATE_FILE, { lastSeenId: null, lastCheckedAt: null, latestPost: null });
  const posts = await fetchLatestPosts();
  const latestPost = posts[posts.length - 1] || null;

  if (!latestPost) {
    state.lastCheckedAt = new Date().toISOString();
    saveJson(STATE_FILE, state);
    return null;
  }

  const subscribers = loadJson(SUBSCRIBERS_FILE, { chats: [] }).chats || [];

  if (!state.lastSeenId) {
    const latestPostWithTranslation = await enrichPostWithTranslation(latestPost);
    state.lastSeenId = latestPost.id;
    state.latestPost = latestPostWithTranslation;
    state.lastCheckedAt = new Date().toISOString();
    saveJson(STATE_FILE, state);
    console.log('Initialized with latest post:', latestPost.id);
    return latestPostWithTranslation;
  }

  const lastSeenIndex = posts.findIndex((post) => post.id === state.lastSeenId);
  const newPosts = lastSeenIndex >= 0 ? posts.slice(lastSeenIndex + 1) : posts;

  if (!newPosts.length) {
    if (!state.latestPost || state.latestPost.id !== latestPost.id) {
      state.latestPost = await enrichPostWithTranslation(latestPost);
    }

    if (state.latestPost) {
      const delivery = await deliverPostToSubscribers(state.latestPost, subscribers);
      if (delivery.successCount || delivery.failureCount) {
        console.log(
          `Retried latest post ${state.latestPost.id}: +${delivery.successCount} sent, ${delivery.failureCount} failed, ${delivery.deliveredCount}/${subscribers.length} delivered.`
        );
      } else {
        console.log('No new post.');
      }
    } else {
      console.log('No new post.');
    }

    state.lastCheckedAt = new Date().toISOString();
    saveJson(STATE_FILE, state);
    return state.latestPost;
  }

  let latestTranslatedPost = state.latestPost;
  for (const post of newPosts) {
    const postWithTranslation = await enrichPostWithTranslation(post);
    latestTranslatedPost = postWithTranslation;

    const delivery = await deliverPostToSubscribers(postWithTranslation, subscribers);
    console.log(
      `Processed post ${post.id}: +${delivery.successCount} sent, ${delivery.failureCount} failed, ${delivery.deliveredCount}/${subscribers.length} delivered.`
    );
  }

  state.lastSeenId = latestPost.id;
  state.latestPost = latestTranslatedPost;
  state.lastCheckedAt = new Date().toISOString();
  saveJson(STATE_FILE, state);
  return latestTranslatedPost;
}

async function runOnce() {
  const latestPost = await getLatestPostWithTranslation().catch((error) => {
    console.error('Prefetch latest post failed:', error.message);
    return loadJson(STATE_FILE, {}).latestPost || null;
  });
  await processUpdates({ timeoutSeconds: 0, latestPost });
  await checkForNewPost();
}

async function runDaemon() {
  console.log(`Starting daemon mode. command latency: seconds; feed check interval: ${POLL_INTERVAL_SECONDS}s`);

  let nextFeedCheckAt = 0;
  while (true) {
    try {
      const now = Date.now();
      if (now >= nextFeedCheckAt) {
        await checkForNewPost();
        nextFeedCheckAt = now + POLL_INTERVAL_SECONDS * 1000;
      }

      const latestPost = loadJson(STATE_FILE, {}).latestPost || null;
      await processUpdates({ timeoutSeconds: TELEGRAM_LONG_POLL_SECONDS, latestPost });
    } catch (error) {
      console.error('Daemon loop error:', error);
      await sleep(3000);
    }
  }
}

if (RUN_MODE === 'daemon') {
  runDaemon().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  runOnce().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
