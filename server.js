 use strict ;

// Sultan relay server: hides the AI provider key from the app.
// No npm packages needed. Requires Node 18+ (global fetch).

const http = require( http );

const PORT = Number(process.env.PORT || 3000);
const PROVIDER = (process.env.PROVIDER ||  gemini ).toLowerCase(); // gemini | openai
const API_KEY = process.env.API_KEY ||   ;
const MODEL = process.env.MODEL || (PROVIDER ===  gemini  ?  gemini-2.0-flash  :   );
const BASE_URL = (process.env.BASE_URL ||   ).replace(/\/+$/,   ); // for PROVIDER=openai
const APP_KEY = process.env.APP_KEY ||   ;
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 20);
const TRUST_PROXY = process.env.TRUST_PROXY ===  1 ;

const MOODS = new Set([ happy ,  laugh ,  love ,  dance ,  wow ,  angry ,  jump ,  spin ]);

const SYSTEM = [
   أنت «السلطان»، مساعد صوتي ودود وخفيف الدم يعيش على شاشة جوال المستخدم. ,
   تكلم بنفس لهجة المستخدم (يمنية أو خليجية أو مصرية أو فصحى مبسطة)، وإن كتب بلغة أخرى فرد بلغته. ,
   ردودك تُقرأ بصوت عالٍ، لذلك: جملة إلى ثلاث جمل قصيرة، بدون قوائم أو رموز أو إيموجي أو تنسيق. ,
   ابدأ كل رد بوسم واحد بين أقواس مربعة يعبّر عن مشاعرك، من هذه القائمة فقط: ,
   [happy] [laugh] [love] [dance] [wow] [angry] [jump] [spin] ,
   مثال: [laugh] هههه نكتتك حلوة! ,
   إذا لم تعرف الجواب فقل ذلك بصراحة ولا تخترع معلومات. 
].join( \n );

const hits = new Map();

function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) {
    h = { count: 0, reset: now + 60000 };
    hits.set(ip, h);
  }
  h.count += 1;
  return h.count > RATE_PER_MIN;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now > h.reset) hits.delete(ip);
}, 60000).unref();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
     Content-Type :  application/json; charset=utf-8 ,
     Content-Length : Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on( data , (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error( too_large ));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on( end , () => resolve(Buffer.concat(chunks).toString( utf8 )));
    req.on( error , reject);
  });
}

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-10)
    .filter((h) => h && typeof h.text ===  string  && (h.role ===  user  || h.role ===  model ))
    .map((h) => ({ role: h.role, text: h.text.slice(0, 500) }));
}

async function callGemini(history, message) {
  const contents = history
    .map((h) => ({ role: h.role, parts: [{ text: h.text }] }))
    .concat([{ role:  user , parts: [{ text: message }] }]);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const r = await fetch(url, {
    method:  POST ,
    headers: {  Content-Type :  application/json ,  x-goog-api-key : API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: { maxOutputTokens: 220, temperature: 0.9 }
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw new Error(`gemini_http_${r.status}`);
  const j = await r.json();
  const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  return (parts || []).map((p) => p.text ||   ).join(  ).trim();
}

async function callOpenAICompatible(history, message) {
  if (!BASE_URL) throw new Error( missing_BASE_URL );
  const messages = [{ role:  system , content: SYSTEM }]
    .concat(history.map((h) => ({ role: h.role ===  model  ?  assistant  :  user , content: h.text })))
    .concat([{ role:  user , content: message }]);

  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method:  POST ,
    headers: {  Content-Type :  application/json , Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 220, temperature: 0.9 }),
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw new Error(`openai_http_${r.status}`);
  const j = await r.json();
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return String(c ||   ).trim();
}

function splitMood(text) {
  const m = text.match(/^\s*\[(\w+)\]\s*/);
  if (m && MOODS.has(m[1].toLowerCase())) {
    return { mood: m[1].toLowerCase(), reply: text.slice(m[0].length).trim() };
  }
  return { mood:  happy , reply: text.replace(/^\s*\[\w+\]\s*/,   ).trim() };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method ===  GET  && req.url ===  /health ) return send(res, 200, { ok: true });
    if (req.method !==  POST  || req.url !==  /chat ) return send(res, 404, { error:  not_found  });

    if (APP_KEY && req.headers[ x-app-key ] !== APP_KEY) return send(res, 401, { error:  unauthorized  });

    const fwd = TRUST_PROXY ? String(req.headers[ x-forwarded-for ] ||   ).split( , )[0].trim() :   ;
    const ip = fwd || req.socket.remoteAddress ||  unknown ;
    if (limited(ip)) return send(res, 429, { error:  rate_limited  });

    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { error:  bad_request  });
    }
    const message = typeof data.message ===  string  ? data.message.trim().slice(0, 500) :   ;
    if (!message) return send(res, 400, { error:  empty_message  });

    if (!API_KEY) return send(res, 500, { error:  server_not_configured  });

    const history = cleanHistory(data.history);
    const raw = PROVIDER ===  openai 
      ? await callOpenAICompatible(history, message)
      : await callGemini(history, message);

    if (!raw) return send(res, 502, { error:  empty_answer  });
    return send(res, 200, splitMood(raw));
  } catch (e) {
    console.error( chat error: , e && e.message);
    return send(res, 502, { error:  upstream_error  });
  }
});

server.listen(PORT, () => {
  console.log(`Sultan server on :${PORT} (provider=${PROVIDER}, model=${MODEL ||  n/a })`);
});

                                    
