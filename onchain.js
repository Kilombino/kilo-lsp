'use strict';
// On-chain payment of the fee, as an alternative to the Lightning hold invoice, and the
// request options shared by both (public or private channel, how to pay).
//
// An on-chain order gets a fresh address of the LSP's own wallet and must receive exactly the
// fee there, in one output, first seen (mempool or block) within the window. Once that payment
// has CONFIRMATIONS confirmations the channel opens the same way as for Lightning. Anything
// else stops the order for the operator ("needs_operator") and tells them: under- or
// overpayment, a payment after the window or to an order that ended, more than one payment,
// a payment that disappears, one that never confirms, the buyer's node offline for a day after
// confirmation, an open that fails. Nothing is ever refunded or sent automatically: the only
// coins the LSP moves are a channel's funding.
//
// Idempotence: an order goes to "opening_started" (saved) before the channel is asked for, and
// only an order in "confirming" can get there. An "opening_started" order found by a new
// process (a restart in the middle of an open) is never opened again: if its channel is there
// (by the memo `kilowallet-lsp <id>`), it is adopted, otherwise the operator looks.
const { refundAddress } = require('./addr');

const DEFAULTS = {
  windowS: 3600,          // the payment must be first seen within this time of the order
  confirmations: 3,       // before the channel opens
  confirmMaxS: 86400,     // a payment still unconfirmed after this goes to the operator
  offlineMaxS: 86400,     // keep trying to reach the buyer's node this long after confirmation
  retryS: 60,             // between connection attempts
  maxUnpaid: 2,           // on-chain orders waiting for payment at once, overall
  maxUnpaidPerIp: 1,
  keepS: 30 * 86400,      // on-chain orders are watched (late or extra payments) this long
};

const bad = (m) => Object.assign(new Error(m), { http: 400 });
const busy = (m) => Object.assign(new Error(m), { http: 503 });

// Request options. Both are optional and default to what Kilowallet always got: a private
// channel paid with Lightning.
function requestOptions(body) {
  const b = body || {};
  if (b.public != null && typeof b.public !== 'boolean') throw bad('public must be true or false');
  const method = b.payment == null || b.payment === '' ? 'lightning' : b.payment;
  if (method !== 'lightning' && method !== 'onchain') throw bad('payment must be lightning or onchain');
  let refund = null;
  if (method === 'onchain') {
    if (b.refundAddress == null || b.refundAddress === '') throw bad('an on-chain payment needs a refund address');
    refund = refundAddress(b.refundAddress);
    if (!refund) throw bad('the refund address is not a valid mainnet address (bc1…, 1… or 3…)');
  }
  return { public: b.public === true, method, refundAddress: refund };
}

const isOnchain = (o) => o.method === 'onchain';
const UNPAID = (o, now) => isOnchain(o) && o.status === 'waiting_payment' && now <= o.expires;

// May one more on-chain order be issued? (The general limits, one request per node and a few
// at once overall, are checked by the caller as for Lightning.)
function checkLimits(orders, { ip, now }, cfg = DEFAULTS) {
  const unpaid = Object.values(orders).filter((o) => UNPAID(o, now));
  if (unpaid.length >= cfg.maxUnpaid) throw busy('too many on-chain payments waiting right now: pay with Lightning or try again later');
  if (ip && unpaid.filter((o) => o.ip === ip).length >= cfg.maxUnpaidPerIp) throw busy('you already have an on-chain payment waiting: pay it or let it expire first');
}

// The outputs paying an address, from LND's GetTransactions.
function outputsTo(txs, address) {
  const out = [];
  for (const t of txs || []) {
    for (const d of t.output_details || []) {
      if (d.address !== address || d.is_our_address === false) continue;
      out.push({
        txid: t.tx_hash, vout: Number(d.output_index || 0), sats: Number(d.amount || 0),
        confs: Number(t.num_confirmations || 0), height: Number(t.block_height || 0), time: Number(t.time_stamp || 0),
      });
    }
  }
  return out;
}

// Moves an order along with what the wallet shows paying its address. Pure: it changes the
// order and returns what to tell the operator and whether the channel may open now.
function advance(o, outs, now, cfg = DEFAULTS) {
  const alerts = [];
  const flag = (reason) => {
    o.operator = o.operator || [];
    o.operator.push({ reason, at: now });
    if (['waiting_payment', 'confirming', 'expired'].includes(o.status)) { o.status = 'needs_operator'; o.reason = reason; }
    alerts.push({ kind: 'operator', reason });
  };
  o.payments = o.payments || [];
  const key = (p) => `${p.txid}:${p.vout}`;
  const seen = new Map(o.payments.map((p) => [key(p), p]));
  const fresh = [];
  for (const x of outs) {
    const p = seen.get(key(x));
    if (p) { p.confs = x.confs; p.height = x.height; p.gone = false; continue; }
    const np = { txid: x.txid, vout: x.vout, sats: x.sats, confs: x.confs, height: x.height,
      firstSeen: x.time > 0 ? Math.min(now, x.time) : now };
    o.payments.push(np); fresh.push(np);
  }
  const live = new Set(outs.map(key));
  for (const p of o.payments) if (!live.has(key(p))) { p.gone = true; p.confs = 0; }
  for (const p of fresh) alerts.push({ kind: 'payment', payment: p });

  switch (o.status) {
    case 'waiting_payment': {
      if (!o.payments.length) {
        if (now > o.expires) o.status = 'expired';
        break;
      }
      if (o.payments.length > 1) { flag('more than one payment to the address'); break; }
      const p = o.payments[0];
      if (p.firstSeen > o.expires) flag(`payment after the window (${p.sats} sats)`);
      else if (p.sats < o.fee) flag(`underpaid: ${p.sats} of ${o.fee} sats`);
      else if (p.sats > o.fee) flag(`overpaid: ${p.sats} instead of ${o.fee} sats`);
      else {
        o.status = 'confirming'; o.payment = { txid: p.txid, vout: p.vout, sats: p.sats };
        if (p.confs >= cfg.confirmations) return { alerts, open: true };   // first seen already deep
      }
      break;
    }
    case 'confirming': {
      if (o.payments.length > 1) { flag('more than one payment to the address'); break; }
      const p = o.payments[0];
      if (p.gone) { flag('the payment disappeared from the wallet (double spend?)'); break; }
      if (p.confs >= cfg.confirmations) return { alerts, open: true };
      if (now - p.firstSeen > cfg.confirmMaxS) flag(`still unconfirmed after ${Math.round(cfg.confirmMaxS / 3600)} h`);
      break;
    }
    default:
      // Ended or already handled: any new payment is the operator's to look at.
      for (const p of fresh) {
        if (o.status === 'expired' || o.status === 'needs_operator') flag(`payment to an order that is ${o.status === 'expired' ? 'expired' : 'already stopped'} (${p.sats} sats)`);
        else flag(`extra payment after the channel (${p.sats} sats); order stays ${o.status}`);
      }
  }
  return { alerts, open: false };
}

// The worker. deps: state, save(), log(), alert(text), now() (seconds), lnd: { tip(),
// transactions(startHeight), connect(order) (connects if it can, true when connected),
// channelsWithMemo(order) → [{point}] }, open(order) → {txid, index} (the same open as for
// Lightning: checks the peer and the liquidity, picks the coins).
function createOnchain(deps, cfg = DEFAULTS) {
  const { state, save, log, alert, lnd, open } = deps;
  const now = deps.now || (() => Math.floor(Date.now() / 1000));
  const inFlight = new Set();
  let running = false;

  const watched = () => Object.values(state.orders).filter((o) => isOnchain(o) && o.address);

  function say(o, a) {
    const who = `${o.id} · ${o.sats.toLocaleString('es-ES')} sats · ${o.public ? 'público' : 'privado'} · ${o.pubkey.slice(0, 16)}…`;
    if (a.kind === 'payment') return alert(`LSP on-chain: pago visto ${a.payment.sats} sats (${a.payment.confs} conf) para ${who}\ntx ${a.payment.txid}:${a.payment.vout}`);
    if (a.kind === 'operator') return alert(`⚠️ LSP on-chain NECESITA OPERADOR: ${a.reason}\npedido ${who}\ndirección ${o.address}\nreembolso ${o.refundAddress || '-'}\nNada automático: revisar a mano.`);
    return alert(`LSP on-chain: ${a.text} · ${who}`);
  }

  async function startOpen(o) {
    const t = now();
    const connected = await lnd.connect(o).catch(() => false);
    if (!connected) {
      o.offlineSince = o.offlineSince || t;
      if (t - o.offlineSince > cfg.offlineMaxS) {
        const r = advanceFlag(o, `buyer node offline for ${Math.round(cfg.offlineMaxS / 3600)} h after the payment confirmed`);
        save(); say(o, r);
      } else { o.nextTry = t + cfg.retryS; save(); }
      return;
    }
    // Saved before the channel is asked for: whatever happens next, this order is never opened twice.
    o.status = 'opening_started'; o.openStarted = t; delete o.nextTry;
    inFlight.add(o.id); save();
    try {
      const r = await open(o);
      o.status = 'opening'; o.fundingTxid = r.txid; o.minUntil = t + (deps.minDays || 90) * 86400;
      state.channels.push({ pubkey: o.pubkey, point: `${r.txid}:${r.index}`, sats: o.sats, opened: t, minUntil: o.minUntil, order: o.id, public: !!o.public, paid: 'onchain' });
      save();
      log('opened (on-chain)', o.id, r.txid);
      say(o, { kind: 'info', text: `canal abierto, tx ${r.txid}:${r.index}` });
    } catch (e) {
      const r = advanceFlag(o, `the channel could not open: ${e.message}`, true);
      save(); say(o, r);
      log('open failed (on-chain), operator', o.id, e.message);
    } finally { inFlight.delete(o.id); }
  }

  function advanceFlag(o, reason, force) {
    o.operator = o.operator || [];
    o.operator.push({ reason, at: now() });
    if (force || ['waiting_payment', 'confirming', 'expired', 'opening_started'].includes(o.status)) { o.status = 'needs_operator'; o.reason = reason; }
    return { kind: 'operator', reason };
  }

  // An open cut short by a restart: adopt the channel if LND has it, else stop for the operator.
  async function recover(o) {
    const found = await lnd.channelsWithMemo(o);
    if (found.length === 1) {
      const [txid, index] = found[0].point.split(':');
      o.status = 'opening'; o.fundingTxid = txid; o.minUntil = (o.openStarted || now()) + (deps.minDays || 90) * 86400;
      if (!state.channels.some((c) => c.order === o.id)) state.channels.push({ pubkey: o.pubkey, point: found[0].point, sats: o.sats, opened: o.openStarted, minUntil: o.minUntil, order: o.id, public: !!o.public, paid: 'onchain' });
      save(); log('recovered open', o.id, txid, index);
      say(o, { kind: 'info', text: `apertura interrumpida recuperada, tx ${found[0].point}` });
    } else {
      const r = advanceFlag(o, found.length ? `interrupted open: ${found.length} channels carry this order's memo` : 'interrupted open: no channel found for it; check LND before doing anything');
      save(); say(o, r);
    }
  }

  async function pass() {
    const list = watched();
    if (!list.length) return;
    const t = now();
    for (const o of list) {
      if (o.status === 'opening_started' && !inFlight.has(o.id)) {
        try { await recover(o); } catch (e) { log('recover', o.id, e.message); }
      }
    }
    const from = Math.max(0, Math.min(...list.map((o) => o.height || 0)) - 6);
    const txs = await lnd.transactions(from);
    for (const o of list) {
      if (inFlight.has(o.id)) continue;
      const r = advance(o, outputsTo(txs, o.address), t, cfg);
      if (r.alerts.length || r.open) save();
      for (const a of r.alerts) say(o, a);
      if (r.open && !(o.nextTry && t < o.nextTry)) await startOpen(o);
    }
    for (const [id, o] of Object.entries(state.orders)) {
      if (isOnchain(o) && ['expired', 'open', 'needs_operator'].includes(o.status) && t - o.created > cfg.keepS) delete state.orders[id];
    }
  }

  // Issue the address for a new order (the caller holds the lock and has checked everything else).
  async function issue(o) {
    const addr = await lnd.newAddress();
    state.addresses = state.addresses || [];
    if (!addr || state.addresses.includes(addr)) throw new Error('the wallet gave an address already used');
    state.addresses.push(addr);
    o.address = addr; o.height = await lnd.tip();
    return addr;
  }

  return {
    issue, advanceFlag,
    // One pass at a time, like the Lightning worker.
    async tick() {
      if (running) return;
      running = true;
      try { await pass(); } finally { running = false; }
    },
    inFlight,
  };
}

module.exports = { DEFAULTS, requestOptions, checkLimits, outputsTo, advance, createOnchain, isOnchain };
