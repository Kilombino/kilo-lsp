'use strict';
// End to end: the real server.js against a fake LND (test/mock-lnd.js) and a fake Telegram API.
// Needs openssl for a throwaway TLS certificate. node --test 'test/*.test.js'
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { createMockLnd } = require('./mock-lnd');

const LSP_PK = '03' + '1'.repeat(64);
const BUYER = (n) => '02' + String(n).repeat(64).slice(0, 64);
const ONION = 'a'.repeat(56) + '.onion:9735';
const REFUND = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, p, body, ip = '9.9.9.9', https) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const lib = https ? require('https') : http;
    const r = lib.request({ host: '127.0.0.1', port, path: p, method, rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve([res.statusCode, JSON.parse(b || '{}')]));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function until(fn, ms = 15000) {
  const t = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await sleep(250); }
}

test('end to end against a mock LND', async (t) => {
  try { execFileSync('openssl', ['version']); } catch { return t.skip('no openssl'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-lsp-e2e-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'tls.cert')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'macaroon.hex'), '00');
  const mock = createMockLnd({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'tls.cert')), pubkey: LSP_PK });
  await new Promise((r) => mock.server.listen(0, '127.0.0.1', r));
  const lndPort = mock.server.address().port;
  const tg = [];
  const tgServer = http.createServer((q, s) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { tg.push(JSON.parse(b)); s.end('{"ok":true}'); }); });
  await new Promise((r) => tgServer.listen(0, '127.0.0.1', r));
  const lspPort = 32000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, HOME: dir, LSP_CONFIG_DIR: dir, LSP_PORT: String(lspPort), LSP_LND_PORT: String(lndPort), LSP_FEE_URL: 'off',
      LSP_ONCHAIN_POLL_S: '1', TELEGRAM_TOKEN: 'test-token', TELEGRAM_CHAT: '1', TELEGRAM_API: `http://127.0.0.1:${tgServer.address().port}`, LSP_PUBLIC_STATE: path.join(dir, 'public.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  t.after(() => { child.kill(); mock.server.close(); tgServer.close(); });
  const ctl = (p, body) => req(lndPort, 'POST', '/_ctl/' + p, body, undefined, true);
  const lspState = async () => (await req(lndPort, 'GET', '/_ctl/state', null, undefined, true))[1];
  await until(async () => /on-chain payment available/.test(out));

  await t.test('info: public channels supported, on-chain offered', async () => {
    const [st, info] = await req(lspPort, 'GET', '/v1/info');
    assert.strictEqual(st, 200);
    assert.strictEqual(info.private, true);
    assert.strictEqual(info.publicChannels, true);
    assert.strictEqual(info.payments.lightning, true);
    assert.strictEqual(info.payments.onchain.confirmations, 3);
  });

  await t.test('Kilowallet as today (signed, no options): Lightning, PRIVATE channel', async () => {
    await ctl('signer', { pubkey: BUYER(5) });
    await ctl('tx', { address: 'x', sats: 1 });   // unrelated wallet tx
    mock.s.peers.add(BUYER(5));
    const [st, q] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(5), sats: 1_000_000, ts: Math.floor(Date.now() / 1000), signature: 'x'.repeat(40) });
    assert.strictEqual(st, 200, JSON.stringify(q));
    assert.strictEqual(q.method, 'lightning'); assert.ok(q.invoice); assert.strictEqual(q.public, false);
    await ctl('accept', {});
    const o = await until(async () => { const [, v] = await req(lspPort, 'GET', '/v1/order/' + q.id); return v.status === 'opening' && v; });
    assert.strictEqual(o.public, false);
    const s = await lspState();
    assert.strictEqual(s.opens.at(-1).private, true);
    assert.strictEqual(s.settles, 1);
  });

  let oc;
  await t.test('web on-chain + public: address, payment, 3 confirmations, PUBLIC channel, alerts', async () => {
    const [bad1] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(6), sats: 2_000_000, host: ONION, payment: 'onchain' }, '1.1.1.1');
    assert.strictEqual(bad1, 400);
    const [bad2, e2] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(6), sats: 2_000_000, host: ONION, payment: 'onchain', refundAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }, '1.1.1.1');
    assert.strictEqual(bad2, 400); assert.match(e2.error, /refund address/);
    const [st, q] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(6), sats: 2_000_000, host: ONION, payment: 'onchain', refundAddress: REFUND, public: true }, '1.1.1.1');
    assert.strictEqual(st, 200, JSON.stringify(q));
    assert.strictEqual(q.method, 'onchain'); assert.strictEqual(q.amount, 10_000); assert.match(q.address, /^bc1qmock/); assert.strictEqual(q.public, true);
    assert.ok(q.expires - Date.now() / 1000 > 3500);
    oc = q;
    // same visitor, another node: one on-chain order waiting per visitor
    const [st2] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(7), sats: 1_000_000, host: ONION, payment: 'onchain', refundAddress: REFUND }, '1.1.1.1');
    assert.strictEqual(st2, 503);
    const pay = (await ctl('tx', { address: q.address, sats: 10_000, confs: 0 }))[1];
    await until(async () => (await req(lspPort, 'GET', '/v1/order/' + q.id))[1].status === 'confirming');
    await ctl('confs', { txid: pay.tx_hash, confs: 2 });
    await sleep(2500);
    let [, v] = await req(lspPort, 'GET', '/v1/order/' + q.id);
    assert.strictEqual(v.status, 'confirming'); assert.strictEqual(v.confirmations, 2); assert.strictEqual((await lspState()).opens.length, 1);
    await ctl('confs', { txid: pay.tx_hash, confs: 3 });
    v = await until(async () => { const [, x] = await req(lspPort, 'GET', '/v1/order/' + q.id); return x.status === 'opening' && x; });
    assert.ok(v.fundingTxid); assert.strictEqual(v.paymentTxid, pay.tx_hash);
    const s = await lspState();
    assert.strictEqual(s.opens.length, 2);
    assert.strictEqual(s.opens.at(-1).private, false);
    assert.strictEqual(s.opens.at(-1).pubkey, BUYER(6));
    const texts = tg.map((m) => m.text).join('\n');
    assert.match(texts, /pedido nuevo/); assert.match(texts, /pago visto/); assert.match(texts, /canal abierto/);
    // the public copy shows only known statuses
    const pub = JSON.parse(fs.readFileSync(path.join(dir, 'public.json'), 'utf8'));
    assert.ok(Object.values(pub.orders).every((o) => ['waiting_payment', 'paid', 'opening', 'open', 'expired', 'failed', 'needs_operator'].includes(o.status)));
  });

  await t.test('a second payment to the opened order alerts the operator; no second channel', async () => {
    await ctl('tx', { address: oc.address, sats: 10_000, confs: 1 });
    await until(async () => tg.some((m) => /extra payment/.test(m.text)));
    await sleep(1500);
    assert.strictEqual((await lspState()).opens.length, 2);
  });

  await t.test('overpayment: needs_operator, no channel', async () => {
    const [st, q] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(8), sats: 1_000_000, host: ONION, payment: 'onchain', refundAddress: REFUND }, '2.2.2.2');
    assert.strictEqual(st, 200, JSON.stringify(q));
    await ctl('tx', { address: q.address, sats: 6_000, confs: 3 });
    const v = await until(async () => { const [, x] = await req(lspPort, 'GET', '/v1/order/' + q.id); return x.status === 'needs_operator' && x; });
    assert.match(v.reason, /overpaid/);
    assert.ok(tg.some((m) => /NECESITA OPERADOR/.test(m.text)));
    assert.strictEqual((await lspState()).opens.length, 2);
  });

  await t.test('macaroon without NewAddress: on-chain refused, Lightning still works', async () => {
    await ctl('deny', { paths: ['/v1/newaddress'] });
    const [st, e] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(9), sats: 1_000_000, host: ONION, payment: 'onchain', refundAddress: REFUND }, '3.3.3.3');
    assert.strictEqual(st, 503); assert.match(e.error, /not available/);
    const [, info] = await req(lspPort, 'GET', '/v1/info');
    assert.strictEqual(info.payments.onchain, false);
    const [st2, q] = await req(lspPort, 'POST', '/v1/quote', { pubkey: BUYER(9), sats: 1_000_000, host: ONION }, '3.3.3.3');
    assert.strictEqual(st2, 200, JSON.stringify(q)); assert.strictEqual(q.method, 'lightning');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
