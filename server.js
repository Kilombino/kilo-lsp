'use strict';
// Kilombino's inbound liquidity service for Kilowallet (Lightning on BLAKE2b).
//
// A wallet asks for a channel of N million sats from Kilombino's node. It proves it owns its
// node key by signing the request, pays a hold invoice for the fee (5,000 sats per million),
// and only once the channel's funding transaction is out is that invoice settled; if the
// channel cannot be opened, the invoice is cancelled and the payment goes back.
//
// Guarding the node's liquidity:
//  - only confirmed coins (1+ confirmations) count, minus a reserve kept for fees and anchors;
//  - every open request still unpaid holds its amount, so two requests at once cannot both
//    count the same coins; quotes and opens go through one lock, one at a time;
//  - one open request per node, a few at once overall, and at most MAX_PER_PEER of channels
//    opened by us to the same node;
//  - the wallet must be connected to us when it asks and when the channel opens;
//  - requests are signed with the node key and only good for a few minutes.
// Each channel is opened with all the confirmed coins, so the change consolidates them.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Lnd, hexToB64 } = require('./lnd');

const CONFIG_DIR = process.env.LSP_CONFIG_DIR || path.join(process.env.HOME, '.config/kilo-lsp');
const PORT = parseInt(process.env.LSP_PORT || '3240', 10);
const STATE = path.join(CONFIG_DIR, 'state.json');
const LOG = path.join(CONFIG_DIR, 'lsp.log');

const MIN_SATS = 1_000_000;
const MAX_SATS = 50_000_000;
const FEE_PER_MILLION = 5_000;
const RESERVE_SATS = 300_000;          // never committed: fees, anchors, the next close
const MIN_DAYS = 90;                   // channels are kept open at least this long
const QUOTE_TTL_S = 600;
const MAX_PER_PEER = 50_000_000;       // channels opened by us to one node, in total
const MAX_ACTIVE = 3;                  // open requests at once, overall
const SIG_WINDOW_S = 300;
const QUOTES_PER_IP_HOUR = 20;

const lnd = new Lnd({
  host: '127.0.0.1', port: 8280,
  macaroonFile: path.join(CONFIG_DIR, 'macaroon.hex'),
  certFile: path.join(CONFIG_DIR, 'tls.cert'),
});

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', { mode: 0o600 }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- state
let state = { orders: {}, channels: [] };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* fresh */ }
function save() {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}

// One at a time for anything that counts or spends the node's coins.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const ACTIVE = ['waiting_payment', 'paid'];
const active = () => Object.values(state.orders).filter((o) => ACTIVE.includes(o.status));

// ---------------------------------------------------------------- LND helpers
async function confirmedUtxos() {
  const r = await lnd.get('/v1/utxos?min_confs=1&max_confs=2147483647');
  return (r.utxos || []).map((u) => ({
    txid: u.outpoint.txid_str, vout: u.outpoint.output_index || 0, sats: Number(u.amount_sat || 0),
  }));
}

async function available(excludeId) {
  const coins = await confirmedUtxos();
  const total = coins.reduce((s, c) => s + c.sats, 0);
  const held = active().filter((o) => o.id !== excludeId).reduce((s, o) => s + o.sats, 0);
  return { total, held, free: Math.max(0, total - RESERVE_SATS - held), coins };
}

async function peerConnected(pubkey) {
  const r = await lnd.get('/v1/peers');
  return (r.peers || []).some((p) => p.pub_key === pubkey);
}

// The buyer may give its node's address (host:port, as in pubkey@host:port): then we connect
// to it ourselves instead of waiting for it to connect to us. Only Tor addresses and public
// IPs or names that resolve to public IPs: an address is the buyer's to choose, and it must
// not point our node at our own network.
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/, /^::$/, /^f[cd]/i, /^fe80/i, /^::ffff:/i];
async function checkHost(host) {
  const m = /^(?:\[([0-9a-f:]+)\]|([a-z0-9.-]+)):(\d{1,5})$/i.exec(host || '');
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65535) throw bad('the address must look like host:port');
  const name = (m[1] || m[2]).toLowerCase();
  if (/^[a-z2-7]{56}\.onion$/.test(name)) return;
  const addrs = require('net').isIP(name) ? [name]
    : (await require('dns').promises.lookup(name, { all: true }).catch(() => { throw bad('that address does not resolve'); })).map((a) => a.address);
  if (!addrs.length || addrs.some((a) => PRIVATE.some((r) => r.test(a)))) throw bad('that address is not a public one');
}
async function connectTo(pubkey, host) {
  if (await peerConnected(pubkey)) return;
  await lnd.post('/v1/peers', { addr: { pubkey, host }, perm: false, timeout: '25' }).catch(() => {});
  for (let i = 0; i < 10 && !(await peerConnected(pubkey)); i++) await new Promise((r) => setTimeout(r, 1000));
}

async function openedToPeer(pubkey) {
  const r = await lnd.get(`/v1/channels?peer=${encodeURIComponent(hexToB64(pubkey))}`);
  const open = (r.channels || []).filter((c) => c.initiator).reduce((s, c) => s + Number(c.capacity || 0), 0);
  const p = await lnd.get('/v1/channels/pending');
  const pend = (p.pending_open_channels || []).filter((c) => c.channel?.remote_node_pub === pubkey)
    .reduce((s, c) => s + Number(c.channel?.capacity || 0), 0);
  return open + pend;
}

async function feeRate() {
  try {
    const r = await new Promise((res, rej) => {
      require('https').get('https://mempool.kilombino.com/api/v1/fees/recommended', (x) => {
        let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
      }).on('error', rej);
    });
    return Math.max(1, Math.min(50, Math.ceil(r.hourFee || 1)));
  } catch { return 2; }
}

// ---------------------------------------------------------------- requests
const ipHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600_000);
  hits.push(now); ipHits.set(ip, hits);
  return hits.length > QUOTES_PER_IP_HOUR;
}

function feeFor(sats) { return (sats / 1_000_000) * FEE_PER_MILLION; }

async function info() {
  const gi = await lnd.getInfo();
  const a = await available();
  return {
    pubkey: gi.identity_pubkey,
    uris: gi.uris || [],
    minSats: MIN_SATS, maxSats: MAX_SATS, stepSats: 1_000_000,
    feePerMillion: FEE_PER_MILLION,
    availableSats: Math.floor(Math.min(a.free, MAX_SATS) / 1_000_000) * 1_000_000,
    minDays: MIN_DAYS,
    private: true,
    quoteSeconds: QUOTE_TTL_S,
  };
}

async function quote(body) {
  const { pubkey, sats, ts, signature } = body || {};
  const host = body?.host ? String(body.host).trim() : null;
  if (!/^0[23][0-9a-f]{64}$/.test(pubkey || '')) throw bad('pubkey');
  if (!Number.isInteger(sats) || sats < MIN_SATS || sats > MAX_SATS || sats % 1_000_000) throw bad('sats must be whole millions from 1 to 50');
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > SIG_WINDOW_S) throw bad('the request is too old: check the phone clock');
  if (typeof signature !== 'string' || signature.length < 20 || signature.length > 200) throw bad('signature');

  const msg = `kilowallet-lsp:v1:${pubkey}:${sats}:${ts}`;
  const v = await lnd.post('/v1/verifymessage', { msg: Buffer.from(msg).toString('base64'), signature });
  // LND's `valid` is only true for nodes in its public graph, and a wallet's node is private.
  // The pubkey it recovers from the signature is what proves it: a signature not made by that
  // key over this exact message recovers a different one.
  if (v.pubkey !== pubkey) throw bad('the signature is not from that node');
  if (Object.values(state.orders).some((o) => o.sig === signature)) throw bad('this request was already used');
  if (host) await checkHost(host);

  return locked(async () => {
    if (active().some((o) => o.pubkey === pubkey)) throw bad('your node already has a request in progress');
    if (active().length >= MAX_ACTIVE) throw busy('busy with other requests: try again in a few minutes');
    if (host) await connectTo(pubkey, host);
    if (!(await peerConnected(pubkey))) {
      throw bad(host ? 'could not connect to your node at that address: check it is online and reachable'
        : 'your node is not connected to ours: open the LIGHTNING tab and wait for "1 peer"');
    }
    const already = await openedToPeer(pubkey);
    if (already + sats > MAX_PER_PEER) throw bad(`we already have ${already} sats of channels with your node; the most is ${MAX_PER_PEER}`);
    const a = await available();
    if (a.free < sats) {
      throw busy(`not enough confirmed liquidity right now (${Math.floor(a.free / 1e6)} million free): try a smaller channel, or again after the next block`);
    }
    const preimage = crypto.randomBytes(32);
    const hash = crypto.createHash('sha256').update(preimage).digest();
    const fee = feeFor(sats);
    const inv = await lnd.post('/v2/invoices/hodl', {
      memo: `Inbound channel of ${sats} sats from Kilombino (kept ${MIN_DAYS}+ days)`,
      hash: hash.toString('base64'), value: String(fee), expiry: String(QUOTE_TTL_S),
    });
    const id = crypto.randomBytes(8).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    state.orders[id] = {
      id, pubkey, sats, fee, status: 'waiting_payment', created: now, expires: now + QUOTE_TTL_S,
      hash: hash.toString('hex'), preimage: preimage.toString('hex'), sig: signature, host,
    };
    save();
    log('quote', id, pubkey.slice(0, 16), sats, 'fee', fee);
    return { id, invoice: inv.payment_request, fee, sats, expires: now + QUOTE_TTL_S, minDays: MIN_DAYS };
  });
}

function view(o) {
  return {
    id: o.id, status: o.status, sats: o.sats, fee: o.fee, expires: o.expires,
    fundingTxid: o.fundingTxid || null, reason: o.reason || null, minUntil: o.minUntil || null,
  };
}

// ---------------------------------------------------------------- the worker
async function lookup(hashHex) {
  const h = Buffer.from(hashHex, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return lnd.get(`/v2/invoices/lookup?payment_hash=${h}`);
}
const cancel = (o) => lnd.post('/v2/invoices/cancel', { payment_hash: Buffer.from(o.hash, 'hex').toString('base64') }).catch((e) => log('cancel failed', o.id, e.message));

async function open(o) {
  return locked(async () => {
    if (o.host) await connectTo(o.pubkey, o.host);
    if (!(await peerConnected(o.pubkey))) throw new Error('your node went offline before the channel could open');
    const a = await available(o.id);
    if (a.free < o.sats) throw new Error('not enough confirmed liquidity any more');
    const rate = await feeRate();
    // Every confirmed coin goes in: the channel gets o.sats and the change comes back as one
    // coin. LND's own coin selection would take only what it needs even from a given list, so
    // the funding transaction is built here as a PSBT with all of them (the PSBT funding flow).
    const r = await openWithAllCoins(o, a.coins, rate);
    return { ...r, rate, coins: a.coins.length };
  });
}

// OpenChannel with a PSBT shim: LND gives the channel's funding address and amount; FundPsbt
// builds a transaction spending exactly the coins given (plus change); LND checks it, the wallet
// signs it, and LND publishes it. Any failure cancels the pending channel and frees the coins.
function openWithAllCoins(o, coins, rate) {
  const pendingId = crypto.randomBytes(32);
  return new Promise((resolve, reject) => {
    let step = 'start', done = false, buf = '', leases = [];
    const fail = async (e) => {
      if (done) return; done = true; req.destroy();
      await lnd.post('/v1/funding/step', { shim_cancel: { pending_chan_id: pendingId.toString('base64') } }).catch(() => {});
      // FundPsbt leases the coins for ten minutes: give them back at once.
      for (const l of leases) await lnd.post('/v2/wallet/utxos/release', { id: l.id, outpoint: l.outpoint }).catch(() => {});
      reject(e);
    };
    const body = JSON.stringify({
      node_pubkey: hexToB64(o.pubkey), local_funding_amount: String(o.sats), private: true,
      memo: `kilowallet-lsp ${o.id}`,
      funding_shim: { psbt_shim: { pending_chan_id: pendingId.toString('base64'), no_publish: false } },
    });
    const req = require('https').request({
      host: '127.0.0.1', port: 8280, path: '/v1/channels/stream', method: 'POST', agent: lnd.agent,
      headers: { 'Grpc-Metadata-macaroon': lnd.macaroon, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', async (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.error) return fail(new Error(m.error.message || 'LND refused the channel'));
          const u = m.result || {};
          if (u.psbt_fund && step === 'start') {
            step = 'funding';
            try {
              const addr = u.psbt_fund.funding_address, amt = Number(u.psbt_fund.funding_amount);
              const funded = await lnd.post('/v2/wallet/psbt/fund', {
                raw: { inputs: coins.map((c) => ({ txid_str: c.txid, output_index: c.vout })), outputs: { [addr]: String(amt) } },
                sat_per_vbyte: String(rate), min_confs: 1, spend_unconfirmed: false,
                change_type: 'CHANGE_ADDRESS_TYPE_P2TR',
              });
              leases = funded.locked_utxos || [];
              await lnd.post('/v1/funding/step', { psbt_verify: { pending_chan_id: pendingId.toString('base64'), funded_psbt: funded.funded_psbt } });
              const fin = await lnd.post('/v2/wallet/psbt/finalize', { funded_psbt: funded.funded_psbt });
              await lnd.post('/v1/funding/step', { psbt_finalize: { pending_chan_id: pendingId.toString('base64'), signed_psbt: fin.signed_psbt } });
              step = 'published';
            } catch (e) { return fail(e); }
          } else if (u.chan_pending && !done) {
            done = true; req.destroy();
            const txid = Buffer.from(u.chan_pending.txid || '', 'base64').reverse().toString('hex');
            return resolve({ txid, index: u.chan_pending.output_index || 0 });
          }
        }
      });
      res.on('end', () => { if (!done) fail(new Error('LND closed the channel stream at step ' + step)); });
    });
    req.on('error', (e) => fail(e));
    setTimeout(() => fail(new Error('the channel did not open in time (step ' + step + ')')), 180000);
    req.end(body);
  });
}

async function tick() {
  const now = Math.floor(Date.now() / 1000);
  for (const o of Object.values(state.orders)) {
    try {
      if (o.status === 'waiting_payment') {
        const inv = await lookup(o.hash);
        if (inv.state === 'ACCEPTED') {
          o.status = 'paid'; save();
          log('paid', o.id);
          try {
            const r = await open(o);
            // The channel is out: take the fee. If that fails (the payment timed out meanwhile)
            // the channel stays, the fee is lost; it is logged.
            await lnd.post('/v2/invoices/settle', { preimage: Buffer.from(o.preimage, 'hex').toString('base64') })
              .catch((e) => log('settle failed after opening', o.id, e.message));
            o.status = 'opening'; o.fundingTxid = r.txid; o.minUntil = now + MIN_DAYS * 86400;
            state.channels.push({ pubkey: o.pubkey, point: `${r.txid}:${r.index}`, sats: o.sats, opened: now, minUntil: o.minUntil, order: o.id });
            delete o.preimage; save();
            log('opened', o.id, r.txid, 'coins', r.coins, 'rate', r.rate);
          } catch (e) {
            await cancel(o);
            o.status = 'failed'; o.reason = e.message; delete o.preimage; save();
            log('open failed, refunded', o.id, e.message);
          }
        } else if (inv.state === 'CANCELED' || now > o.expires + 60) {
          if (inv.state !== 'CANCELED') await cancel(o);
          o.status = 'expired'; delete o.preimage; save();
        }
      } else if (o.status === 'opening') {
        const r = await lnd.get(`/v1/channels?peer=${encodeURIComponent(hexToB64(o.pubkey))}`);
        if ((r.channels || []).some((c) => c.channel_point?.startsWith(o.fundingTxid))) { o.status = 'open'; save(); log('active', o.id); }
      }
    } catch (e) { log('tick', o.id, e.message); }
  }
  // Old finished orders: keep a week for the wallet to read, then drop.
  for (const [id, o] of Object.entries(state.orders)) {
    if (['expired', 'failed', 'open'].includes(o.status) && now - o.created > 7 * 86400) delete state.orders[id];
  }
}
// One pass at a time: an open can take minutes, and two passes seeing the same accepted payment
// would each open a channel for it.
let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  tick().catch((e) => log('tick', e.message)).finally(() => { ticking = false; });
}, 3000);

// ---------------------------------------------------------------- HTTP
const bad = (m) => Object.assign(new Error(m), { http: 400 });
const busy = (m) => Object.assign(new Error(m), { http: 503 });

function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

http.createServer(async (req, res) => {
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1/info') return send(res, 200, await info());
    if (req.method === 'GET' && url.pathname.startsWith('/v1/order/')) {
      const o = state.orders[url.pathname.slice(10)];
      return o ? send(res, 200, view(o)) : send(res, 404, { error: 'no such request' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/quote') {
      if (rateLimited(ip)) return send(res, 429, { error: 'too many requests: try again later' });
      let body = '';
      for await (const c of req) { body += c; if (body.length > 4096) return send(res, 413, { error: 'too big' }); }
      return send(res, 200, await quote(JSON.parse(body || '{}')));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!e.http) log('error', req.method, req.url, e.message);
    send(res, e.http || 500, { error: e.http ? e.message : 'internal error' });
  }
}).listen(PORT, '127.0.0.1', () => log('kilo-lsp listening on', PORT));
