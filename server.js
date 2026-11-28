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
// Each channel is funded with chosen coins (pickCoins): the smallest one that pays, or else the
// small ones smallest first, so dust consolidates and the big coins stay free for other uses.
//
// Options of a request (both optional, defaults = what Kilowallet always got): `public` true
// for an announced channel (default private), and `payment: "onchain"` with a `refundAddress`
// to pay the fee on-chain to a fresh address of the node's wallet instead of with the hold
// invoice (see onchain.js: exact amount, 60 minute window, 3 confirmations; anything unusual
// waits for the operator, nothing is ever refunded automatically).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Lnd, hexToB64 } = require('./lnd');
const onchainLib = require('./onchain');
const { createAlerter } = require('./alert');

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
const UNSIGNED_TTL_S = 300;
const MAX_PER_PEER = 50_000_000;       // channels opened by us to one node, in total
const MAX_ACTIVE = 3;                  // open requests at once, overall
const SIG_WINDOW_S = 300;
const QUOTES_PER_IP_HOUR = 20;
// On-chain payment (LSP_ONCHAIN=0 turns it off). It also needs the macaroon to allow
// NewAddress and GetTransactions; without them it is simply not offered.
const ONCHAIN_ON = process.env.LSP_ONCHAIN !== '0';
const ONCHAIN_ADDR_TYPE = process.env.LSP_ONCHAIN_ADDRESS_TYPE === 'p2tr' ? 'TAPROOT_PUBKEY' : 'WITNESS_PUBKEY_HASH';
const ONCHAIN_POLL_MS = Math.max(1, Number(process.env.LSP_ONCHAIN_POLL_S || 20)) * 1000;
const ONCHAIN_CFG = { ...onchainLib.DEFAULTS };
// Fee rate source for the funding transactions ("off": a fixed 2 sat/vB).
const FEE_URL = process.env.LSP_FEE_URL || 'https://mempool.kilombino.com/api/v1/fees/recommended';

const lnd = new Lnd({
  host: process.env.LSP_LND_HOST || '127.0.0.1', port: Number(process.env.LSP_LND_PORT || 8280),
  macaroonFile: path.join(CONFIG_DIR, 'macaroon.hex'),
  certFile: path.join(CONFIG_DIR, 'tls.cert'),
});

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n', { mode: 0o600 }); } catch { /* ignore */ }
}
const alert = createAlerter(process.env, log);

// ---------------------------------------------------------------- state
let state = { orders: {}, channels: [], addresses: [] };
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* fresh */ }
// A reduced copy for other services on the node that must keep the LSP's
// coins aside (Kiloswap's guard): amounts, statuses and expiry only, no
// keys, preimages or node ids. LSP_PUBLIC_STATE is its path (unset: none).
const PUBLIC_STATE = process.env.LSP_PUBLIC_STATE || '';
function savePublic() {
  if (!PUBLIC_STATE) return;
  const orders = {};
  for (const [id, o] of Object.entries(state.orders || {})) {
    // Readers know "waiting_payment" and "paid": an on-chain payment being confirmed, or an
    // open under way, holds its coins like a paid order.
    const status = ['confirming', 'opening_started'].includes(o.status) ? 'paid' : o.status;
    orders[id] = { sats: o.sats, status, expires: o.expires, unsigned: !!o.unsigned };
  }
  try {
    const tmp = PUBLIC_STATE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ orders }), { mode: 0o644 });
    fs.renameSync(tmp, PUBLIC_STATE);
  } catch (e) { console.error('public state:', e.message); }
}
function save() {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
  savePublic();
}
savePublic();

// One at a time for anything that counts or spends the node's coins.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const ACTIVE = ['waiting_payment', 'paid', 'confirming', 'opening_started'];
const active = () => Object.values(state.orders).filter((o) => ACTIVE.includes(o.status));

// ---------------------------------------------------------------- LND helpers
async function confirmedUtxos() {
  const r = await lnd.get('/v1/utxos?min_confs=1&max_confs=2147483647');
  return (r.utxos || []).map((u) => ({
    txid: u.outpoint.txid_str, vout: u.outpoint.output_index || 0, sats: Number(u.amount_sat || 0),
    type: u.address_type || '',
  }));
}

const { pickCoins } = require('./coins');

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
    if (FEE_URL === 'off') return 2;
    const r = await new Promise((res, rej) => {
      require(FEE_URL.startsWith('http:') ? 'http' : 'https').get(FEE_URL, (x) => {
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
    private: true,                      // the default when a request does not say
    publicChannels: true,               // a request may ask for a public channel ("public": true)
    quoteSeconds: QUOTE_TTL_S,
    payments: {
      lightning: true,
      onchain: onchainOk() ? {
        confirmations: ONCHAIN_CFG.confirmations, windowSeconds: ONCHAIN_CFG.windowS,
        needsRefundAddress: true, needsConnectedNode: true,
      } : false,
    },
  };
}

// On-chain payment is offered only while the macaroon lets us read the wallet's transactions
// and make addresses: checked now and then, and turned off at the first "permission denied".
const onchainState = { ok: false, checked: 0, deniedUntil: 0 };
const denied = (e) => /permission denied|verification failed|cannot get macaroon|unauthorized/i.test(e?.message || '');
function onchainOk() { return ONCHAIN_ON && onchainState.ok && Date.now() > onchainState.deniedUntil; }
async function probeOnchain() {
  if (!ONCHAIN_ON) return;
  try {
    const gi = await lnd.getInfo();
    await lnd.get(`/v1/transactions?start_height=${Number(gi.block_height || 0)}&end_height=-1`);
    if (!onchainState.ok) log('on-chain payment available');
    onchainState.ok = true;
  } catch (e) {
    if (onchainState.ok || !onchainState.checked) log('on-chain payment not available:', e.message);
    onchainState.ok = false;
  }
  onchainState.checked = Date.now();
}

const onchain = onchainLib.createOnchain({
  state, save: () => save(), log, alert, minDays: MIN_DAYS,
  open: (o) => open(o),
  lnd: {
    tip: async () => Number((await lnd.getInfo()).block_height || 0),
    transactions: async (from) => (await lnd.get(`/v1/transactions?start_height=${from}&end_height=-1`)).transactions || [],
    newAddress: async () => (await lnd.get(`/v1/newaddress?type=${ONCHAIN_ADDR_TYPE}`)).address,
    connect: async (o) => { if (o.host) await connectTo(o.pubkey, o.host); return peerConnected(o.pubkey); },
    channelsWithMemo: async (o) => {
      const memo = `kilowallet-lsp ${o.id}`;
      const r = await lnd.get(`/v1/channels?peer=${encodeURIComponent(hexToB64(o.pubkey))}`);
      const p = await lnd.get('/v1/channels/pending');
      return [
        ...(r.channels || []).filter((c) => c.memo === memo).map((c) => ({ point: c.channel_point })),
        ...(p.pending_open_channels || []).filter((c) => c.channel?.memo === memo).map((c) => ({ point: c.channel.channel_point })),
      ];
    },
  },
}, ONCHAIN_CFG);

async function quote(body, ip) {
  const { pubkey, sats, ts, signature } = body || {};
  const host = body?.host ? String(body.host).trim() : null;
  if (!/^0[23][0-9a-f]{64}$/.test(pubkey || '')) throw bad('pubkey');
  if (!Number.isInteger(sats) || sats < MIN_SATS || sats > MAX_SATS || sats % 1_000_000) throw bad('sats must be whole millions from 1 to 50');
  const opt = onchainLib.requestOptions(body);
  const onchainPay = opt.method === 'onchain';
  if (onchainPay && !onchainOk()) throw busy('on-chain payment is not available right now: pay with Lightning');
  // Signed requests (Kilowallet) prove the node is the buyer's. Unsigned ones (the web page)
  // must give the node's address so we connect to it; whoever pays gets a channel opened to
  // that node, which still has to accept it. To keep unpaid unsigned quotes from holding the
  // liquidity, each visitor can only have one waiting at a time, for a shorter time.
  const signed = signature != null && signature !== '';
  if (signed) {
    if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > SIG_WINDOW_S) throw bad('the request is too old: check the phone clock');
    if (typeof signature !== 'string' || signature.length < 20 || signature.length > 200) throw bad('signature');
    const msg = `kilowallet-lsp:v1:${pubkey}:${sats}:${ts}`;
    const v = await lnd.post('/v1/verifymessage', { msg: Buffer.from(msg).toString('base64'), signature });
    // LND's `valid` is only true for nodes in its public graph, and a wallet's node is private.
    // The pubkey it recovers from the signature is what proves it: a signature not made by that
    // key over this exact message recovers a different one.
    if (v.pubkey !== pubkey) throw bad('the signature is not from that node');
    if (Object.values(state.orders).some((o) => o.sig === signature)) throw bad('this request was already used');
  } else {
    if (!host) throw bad('give your node as pubkey@host:port');
    const mine = active().filter((o) => o.unsigned && o.ip === ip && o.status === 'waiting_payment').length;
    if (mine >= (ip === 'tor' ? 3 : 1)) throw busy('you already have a request waiting for payment: pay it or let it expire first');
  }
  if (host) await checkHost(host);
  const ttl = onchainPay ? ONCHAIN_CFG.windowS : signed ? QUOTE_TTL_S : UNSIGNED_TTL_S;

  return locked(async () => {
    if (active().some((o) => o.pubkey === pubkey)) throw bad('your node already has a request in progress');
    if (active().length >= MAX_ACTIVE) throw busy('busy with other requests: try again in a few minutes');
    if (onchainPay) onchainLib.checkLimits(state.orders, { ip, now: Math.floor(Date.now() / 1000) }, ONCHAIN_CFG);
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
    const fee = feeFor(sats);
    const id = crypto.randomBytes(8).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    if (onchainPay) {
      // Our node is connected to the buyer's right now (checked above): a fresh address of the
      // wallet for exactly the fee.
      const o = {
        id, pubkey, sats, fee, status: 'waiting_payment', created: now, expires: now + ttl, unsigned: !signed, ip,
        sig: signature, host, public: opt.public, method: 'onchain', refundAddress: opt.refundAddress,
      };
      try { await onchain.issue(o); } catch (e) {
        if (denied(e)) { onchainState.deniedUntil = Date.now() + 10 * 60_000; log('NewAddress denied: on-chain payment off for 10 minutes'); }
        throw busy('on-chain payment is not available right now: pay with Lightning');
      }
      state.orders[id] = o;
      save();
      log('quote (on-chain)', id, pubkey.slice(0, 16), sats, 'fee', fee, o.public ? 'public' : 'private');
      alert(`LSP on-chain: pedido nuevo ${id} · ${sats.toLocaleString('es-ES')} sats · ${o.public ? 'público' : 'privado'} · comisión ${fee} sats a ${o.address} · ${pubkey.slice(0, 16)}…`);
      return {
        id, method: 'onchain', address: o.address, amount: fee, fee, sats, public: o.public, expires: o.expires,
        confirmations: ONCHAIN_CFG.confirmations, minDays: MIN_DAYS,
      };
    }
    const preimage = crypto.randomBytes(32);
    const hash = crypto.createHash('sha256').update(preimage).digest();
    const inv = await lnd.post('/v2/invoices/hodl', {
      memo: `Inbound channel of ${sats} sats from Kilombino (kept ${MIN_DAYS}+ days)`,
      hash: hash.toString('base64'), value: String(fee), expiry: String(ttl),
    });
    state.orders[id] = {
      id, pubkey, sats, fee, status: 'waiting_payment', created: now, expires: now + ttl, unsigned: !signed, ip: signed ? undefined : ip,
      hash: hash.toString('hex'), preimage: preimage.toString('hex'), sig: signature, host, public: opt.public, method: 'lightning',
    };
    save();
    log('quote', id, pubkey.slice(0, 16), sats, 'fee', fee, opt.public ? 'public' : 'private');
    return { id, method: 'lightning', invoice: inv.payment_request, fee, sats, public: opt.public, expires: now + ttl, minDays: MIN_DAYS };
  });
}

function view(o) {
  const v = {
    id: o.id, status: o.status, sats: o.sats, fee: o.fee, expires: o.expires,
    fundingTxid: o.fundingTxid || null, reason: o.reason || null, minUntil: o.minUntil || null,
    public: !!o.public, method: o.method || 'lightning',
  };
  if (onchainLib.isOnchain(o)) {
    const p = o.payment ? (o.payments || []).find((x) => x.txid === o.payment.txid && x.vout === o.payment.vout) : (o.payments || [])[0];
    Object.assign(v, {
      address: o.address, amount: o.fee, confirmationsNeeded: ONCHAIN_CFG.confirmations,
      confirmations: p ? p.confs : 0, paymentTxid: p ? p.txid : null, paymentSats: p ? p.sats : null,
      // 'opening_started' is internal: to the buyer it is the open under way.
      status: o.status === 'opening_started' ? 'confirming' : o.status,
    });
  }
  return v;
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
    // The chosen coins go in (pickCoins), built here as a PSBT with exactly them (the PSBT
    // funding flow): LND's own selection would rather spend the biggest coin.
    const coins = pickCoins(a.coins, o.sats, rate);
    const r = await openWithCoins(o, coins, rate);
    return { ...r, rate, coins: coins.length };
  });
}

// OpenChannel with a PSBT shim: LND gives the channel's funding address and amount; FundPsbt
// builds a transaction spending exactly the coins given (plus change); LND checks it, the wallet
// signs it, and LND publishes it. Any failure cancels the pending channel and frees the coins.
function openWithCoins(o, coins, rate) {
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
      node_pubkey: hexToB64(o.pubkey), local_funding_amount: String(o.sats), private: !o.public,
      memo: `kilowallet-lsp ${o.id}`,
      funding_shim: { psbt_shim: { pending_chan_id: pendingId.toString('base64'), no_publish: false } },
    });
    const req = require('https').request({
      host: lnd.host, port: lnd.port, path: '/v1/channels/stream', method: 'POST', agent: lnd.agent,
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
    // A visitor's address is only kept while its quote waits for payment.
    if (o.ip && o.status !== 'waiting_payment') { delete o.ip; save(); }
    if (onchainLib.isOnchain(o)) continue;   // the on-chain worker's
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
            state.channels.push({ pubkey: o.pubkey, point: `${r.txid}:${r.index}`, sats: o.sats, opened: now, minUntil: o.minUntil, order: o.id, public: !!o.public });
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
      }
    } catch (e) { log('tick', o.id, e.message); }
  }
  // Channels opening (either payment) become open once LND lists them active.
  for (const o of Object.values(state.orders)) {
    try {
      if (o.status === 'opening') {
        const r = await lnd.get(`/v1/channels?peer=${encodeURIComponent(hexToB64(o.pubkey))}`);
        if ((r.channels || []).some((c) => c.channel_point?.startsWith(o.fundingTxid))) { o.status = 'open'; save(); log('active', o.id); }
      }
    } catch (e) { log('tick', o.id, e.message); }
  }
  // Old finished orders: keep a week for the wallet to read, then drop.
  for (const [id, o] of Object.entries(state.orders)) {
    if (!onchainLib.isOnchain(o) && ['expired', 'failed', 'open'].includes(o.status) && now - o.created > 7 * 86400) delete state.orders[id];
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

// The on-chain worker: payments to the issued addresses, every ONCHAIN_POLL_MS.
probeOnchain();
setInterval(probeOnchain, 10 * 60_000);
setInterval(() => {
  if (!ONCHAIN_ON || !onchainState.checked) return;
  onchain.tick().catch((e) => log('on-chain tick', e.message));
}, ONCHAIN_POLL_MS);

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
      return send(res, 200, await quote(JSON.parse(body || '{}'), ip));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!e.http) log('error', req.method, req.url, e.message);
    send(res, e.http || 500, { error: e.http ? e.message : 'internal error' });
  }
}).listen(PORT, '127.0.0.1', () => log('kilo-lsp listening on', PORT));

