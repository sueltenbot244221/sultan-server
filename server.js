'use strict';

// Sultan relay server: keeps the AI provider key on the server.
// Requires Node.js 18+ (global fetch).
const http = require('node:http');

const PORT = Number(process.env.PORT || 3000);
const PROVIDER = (process.env.PROVIDER || 'gemini').toLowerCase(); // gemini | openai
const API_KEY = process.env.API_KEY || '';
const MODEL = process.env.MODEL || (PROVIDER === 'gemini' ? 'gemini-2.0-flash' : '');
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, '');
const APP_KEY = process.env.APP_KEY || '';
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_BODY_BYTES = 20_000;

const MOODS = new Set(['happy', 'laugh', 'love', 'dance', 'wow', 'angry', 'jump', 'spin']);
const SYSTEM = [
  'أنت «السلطان»، مساعد صوتي ودود وخفيف الدم يعيش على شاشة جوال المستخدم.',
  'تكلم بنفس لهجة المستخدم (يمنية أو خليجية أو مصرية أو فصحى مبسطة)، وإن كتب بلغة أخرى فرد بلغته.',
  'ردودك تُقرأ بصوت عالٍ، لذلك: جملة إلى ثلاث جمل قصيرة، بدون قوائم أو رموز أو إيموجي أو تنسيق.',
  'ابدأ كل رد بوسم واحد بين أقواس مربعة يعبّر عن مشاعرك، من هذه القائمة فقط:',
  '[happy] [laugh] [love] [dance] [wow] [angry] [jump] [spin]',
  'مثال: [laugh] هههه نكتتك حلوة!',
  'إذا لم تعرف الجواب فقل ذلك بصراحة ولا تخترع معلومات.'
].join('\n');

const hits = new Map();

function limited(ip) {
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + 60_000 };
    hits.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > RATE_PER_MIN;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.reset) hits.delete(ip);
  }
}, 60_000).unref();

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('body_too_large'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-10)
    .filter((item) => item && typeof item.text === 'string' && (item.role === 'user' || item.role === 'model'))
    .map((item) => ({ role: item.role, text: item.text.slice(0, 500) }));
}

async function callGemini(history, message) {
  const contents = history
    .map((item) => ({ role: item.role, parts: [{ text: item.text }] }))
    .concat([{ role: 'user', parts: [{ text: message }] }]);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { maxOutputTokens: 220, temperature: 0.9 }
    }),
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error(`gemini_http_${response.status}`);
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  return (parts || []).map((part) => part.text || '').join('').trim();
}

async function callOpenAICompatible(history, message) {
  if (!BASE_URL) throw new Error('missing_BASE_URL');
  const messages = [{ role: 'system', content: SYSTEM }]
    .concat(history.map((item) => ({ role: item.role === 'model' ? 'assistant' : 'user', content: item.text })))
    .concat([{ role: 'user', content: message }]);
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 220, temperature: 0.9 }),
    signal: AbortSignal.timeout(25_000)
  });
  if (!response.ok) throw new Error(`openai_http_${response.status}`);
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

function splitMood(text) {
  const match = text.match(/^\s*\[(\w+)\]\s*/);
  if (match && MOODS.has(match[1].toLowerCase())) {
    return { mood: match[1].toLowerCase(), reply: text.slice(match[0].length).trim() };
  }
  return { mood: 'happy', reply: text.replace(/^\s*\[\w+\]\s*/, '').trim() };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || req.url !== '/chat') {
    return send(res, 404, { error: 'not_found' });
  }
  if (APP_KEY && req.headers['x-app-key'] !== APP_KEY) {
    return send(res, 401, { error: 'unauthorized' });
  }

  const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = forwarded || req.socket.remoteAddress || 'unknown';
  if (limited(ip)) return send(res, 429, { error: 'rate_limited' });

  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch (error) {
    return send(res, error.message === 'body_too_large' ? 413 : 400,
      { error: error.message === 'body_too_large' ? 'body_too_large' : 'bad_request' });
  }

  const message = typeof data?.message === 'string' ? data.message.trim().slice(0, 500) : '';
  if (!message) return send(res, 400, { error: 'empty_message' });
  if (!API_KEY) return send(res, 500, { error: 'server_not_configured' });

  try {
    const history = cleanHistory(data.history);
    const raw = PROVIDER === 'openai'
      ? await callOpenAICompatible(history, message)
      : await callGemini(history, message);
    if (!raw) return send(res, 502, { error: 'empty_answer' });
    return send(res, 200, splitMood(raw));
  } catch (error) {
    console.error('chat error:', error?.message || error);
    return send(res, 502, { error: 'upstream_error' });
  }
});

server.listen(PORT, () => {
  console.log(`Sultan server on :${PORT} (provider=${PROVIDER}, model=${MODEL || 'n/a'})`);
});
