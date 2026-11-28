'use strict';
// Optional Telegram messages to the operator (the same variables as kilobridge's bridge-watch):
//   TELEGRAM_CHAT        chat id to tell
//   TELEGRAM_TOKEN       bot token, or TELEGRAM_TOKEN_FILE: a file with the token alone or as
//                        a NAME=token line (the first line whose name ends in TELEGRAM_TOKEN)
//   TELEGRAM_API         API base (default https://api.telegram.org; for tests)
// Without a chat and a token nothing is sent; messages only go to the log. A failed send is
// logged, never thrown: an alert must not stop the worker.
const fs = require('fs');

function readToken(env) {
  if (env.TELEGRAM_TOKEN) return env.TELEGRAM_TOKEN.trim();
  if (!env.TELEGRAM_TOKEN_FILE) return '';
  let raw = '';
  try { raw = fs.readFileSync(env.TELEGRAM_TOKEN_FILE, 'utf8'); } catch { return ''; }
  if (!raw.includes('=')) return raw.trim();
  const line = raw.split('\n').find((l) => /^\s*(export\s+)?[A-Z0-9_]*TELEGRAM_TOKEN\s*=/.test(l));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : '';
}

function createAlerter(env = process.env, log = console.log) {
  const chat = env.TELEGRAM_CHAT || '';
  const token = readToken(env);
  const api = (env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
  let queue = Promise.resolve();
  const send = (text) => {
    log('alert', text.replace(/\n/g, ' | '));
    if (!chat || !token) return Promise.resolve();
    queue = queue.then(async () => {
      try {
        const r = await fetch(`${api}/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) log('alert failed', r.status);
      } catch (e) { log('alert failed', e.message); }
    });
    return queue;
  };
  send.enabled = !!(chat && token);
  return send;
}

module.exports = { createAlerter, readToken };
