'use strict';
// node --test 'test/*.test.js'
const test = require('node:test');
const assert = require('node:assert');
const { requestOptions, checkLimits, outputsTo, advance, createOnchain, DEFAULTS } = require('../onchain');

const ADDR = 'bc1qlspaddressxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const REFUND = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const T0 = 1_800_000_000;
const order = (x = {}) => ({ id: 'aa', pubkey: '02' + 'b'.repeat(64), sats: 2_000_000, fee: 10_000, status: 'waiting_payment',
  created: T0, expires: T0 + 3600, method: 'onchain', address: ADDR, height: 100, public: false, ...x });
const out = (x = {}) => ({ txid: 'f'.repeat(64), vout: 0, sats: 10_000, confs: 0, height: 0, time: T0 + 60, ...x });

// ---- options
test('no options: private channel paid with Lightning (Kilowallet unchanged)', () => {
  assert.deepStrictEqual(requestOptions({ pubkey: 'x', sats: 1 }), { public: false, method: 'lightning', refundAddress: null });
  assert.deepStrictEqual(requestOptions(undefined), { public: false, method: 'lightning', refundAddress: null });
});
test('public must be a boolean; true asks for a public channel', () => {
  assert.strictEqual(requestOptions({ public: true }).public, true);
  assert.strictEqual(requestOptions({ public: false }).public, false);
  assert.throws(() => requestOptions({ public: 'yes' }), /public must be/);
  assert.throws(() => requestOptions({ public: 1 }), /public must be/);
});
test('on-chain needs a valid refund address; Lightning ignores it', () => {
  assert.throws(() => requestOptions({ payment: 'onchain' }), /refund address/);
  assert.throws(() => requestOptions({ payment: 'onchain', refundAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }), /not a valid mainnet/);
  assert.deepStrictEqual(requestOptions({ payment: 'onchain', refundAddress: REFUND, public: true }), { public: true, method: 'onchain', refundAddress: REFUND });
  assert.strictEqual(requestOptions({ payment: 'lightning', refundAddress: 'junk' }).refundAddress, null);
  assert.throws(() => requestOptions({ payment: 'paypal' }), /payment must be/);
});

// ---- limits
test('limits: unpaid on-chain orders overall and per visitor; expired ones do not count', () => {
  const orders = { a: order({ id: 'a', ip: '1.1.1.1' }) };
  assert.doesNotThrow(() => checkLimits(orders, { ip: '2.2.2.2', now: T0 + 10 }));
  assert.throws(() => checkLimits(orders, { ip: '1.1.1.1', now: T0 + 10 }), /already have an on-chain payment/);
  orders.b = order({ id: 'b', ip: '3.3.3.3' });
  assert.throws(() => checkLimits(orders, { ip: '2.2.2.2', now: T0 + 10 }), /too many on-chain/);
  assert.doesNotThrow(() => checkLimits(orders, { ip: '1.1.1.1', now: T0 + 4000 }));          // both expired
  orders.c = order({ id: 'c', method: 'lightning' }); delete orders.a; delete orders.b;
  assert.doesNotThrow(() => checkLimits(orders, { ip: '1.1.1.1', now: T0 + 10 }));            // Lightning ones are not counted here
});

// ---- outputs
test('outputsTo picks only outputs to the address, with their confirmations', () => {
  const txs = [
    { tx_hash: 'a1', num_confirmations: 2, block_height: 101, time_stamp: T0 + 5, output_details: [
      { address: ADDR, output_index: 1, amount: '10000', is_our_address: true }, { address: 'bc1qother', output_index: 0, amount: '5', is_our_address: false }] },
    { tx_hash: 'b2', num_confirmations: 0, output_details: [{ address: 'bc1qother', output_index: 0, amount: '1', is_our_address: true }] },
  ];
  assert.deepStrictEqual(outputsTo(txs, ADDR), [{ txid: 'a1', vout: 1, sats: 10_000, confs: 2, height: 101, time: T0 + 5 }]);
});

// ---- matching
test('exact payment in the window: confirming, then open at 3 confirmations', () => {
  const o = order();
  let r = advance(o, [out()], T0 + 70);
  assert.strictEqual(o.status, 'confirming'); assert.strictEqual(r.open, false);
  assert.strictEqual(r.alerts[0].kind, 'payment');
  r = advance(o, [out({ confs: 2 })], T0 + 900); assert.strictEqual(r.open, false); assert.strictEqual(r.alerts.length, 0);
  r = advance(o, [out({ confs: 3 })], T0 + 1800); assert.strictEqual(r.open, true);
  assert.deepStrictEqual(o.payment, { txid: 'f'.repeat(64), vout: 0, sats: 10_000 });
});
test('a confirmed payment after the window still counts if first seen in it (mempool)', () => {
  const o = order();
  advance(o, [out({ time: T0 + 3000 })], T0 + 3000);
  const r = advance(o, [out({ confs: 3, time: T0 + 3000 })], T0 + 9000);
  assert.strictEqual(r.open, true);
});
test('underpaid, overpaid: operator, never opens', () => {
  for (const [sats, re] of [[9_999, /underpaid/], [10_001, /overpaid/]]) {
    const o = order();
    const r = advance(o, [out({ sats, confs: 6 })], T0 + 100);
    assert.strictEqual(o.status, 'needs_operator'); assert.match(o.reason, re); assert.strictEqual(r.open, false);
    assert.ok(r.alerts.some((a) => a.kind === 'operator'));
  }
});
test('late payment: expired order, then a payment arrives: operator', () => {
  const o = order();
  advance(o, [], T0 + 3601); assert.strictEqual(o.status, 'expired');
  const r = advance(o, [out({ time: T0 + 4000 })], T0 + 4000);
  assert.strictEqual(o.status, 'needs_operator'); assert.match(o.reason, /expired/); assert.strictEqual(r.open, false);
});
test('late payment seen for the first time after the window, order not yet marked expired', () => {
  const o = order();
  advance(o, [out({ time: T0 + 3700 })], T0 + 3700);
  assert.strictEqual(o.status, 'needs_operator'); assert.match(o.reason, /after the window/);
});
test('double payment: two outputs at once, or a second one while confirming, or after the channel', () => {
  let o = order();
  advance(o, [out(), out({ vout: 1 })], T0 + 100);
  assert.strictEqual(o.status, 'needs_operator'); assert.match(o.reason, /more than one/);
  o = order();
  advance(o, [out()], T0 + 100); assert.strictEqual(o.status, 'confirming');
  const r = advance(o, [out({ confs: 3 }), out({ txid: 'e'.repeat(64) })], T0 + 200);
  assert.strictEqual(o.status, 'needs_operator'); assert.strictEqual(r.open, false);
  o = order({ status: 'open', payments: [{ ...out({ confs: 9 }), firstSeen: T0 + 60 }] });
  const r2 = advance(o, [out({ confs: 9 }), out({ txid: 'e'.repeat(64) })], T0 + 9999);
  assert.strictEqual(o.status, 'open'); assert.ok(r2.alerts.some((a) => a.kind === 'operator' && /extra payment/.test(a.reason)));
});
test('reorg: confirmations drop below 3, no open until back; vanished payment goes to the operator', () => {
  const o = order();
  advance(o, [out({ confs: 2 })], T0 + 100);
  assert.strictEqual(advance(o, [out({ confs: 0 })], T0 + 700).open, false);   // block reorged out, tx back in mempool
  assert.strictEqual(o.status, 'confirming');
  assert.strictEqual(advance(o, [out({ confs: 1 })], T0 + 1300).open, false);
  assert.strictEqual(advance(o, [out({ confs: 3 })], T0 + 2500).open, true);
  const o2 = order();
  advance(o2, [out({ confs: 1 })], T0 + 100);
  advance(o2, [], T0 + 200);
  assert.strictEqual(o2.status, 'needs_operator'); assert.match(o2.reason, /disappeared/);
});
test('never confirming within a day: operator', () => {
  const o = order();
  advance(o, [out()], T0 + 100);
  advance(o, [out()], T0 + 100 + DEFAULTS.confirmMaxS + 61);
  assert.strictEqual(o.status, 'needs_operator'); assert.match(o.reason, /unconfirmed/);
});

// ---- worker: idempotent open, offline buyer, restart
function harness({ txs = [], connected = true, memoChannels = [], openImpl } = {}) {
  let t = T0 + 100;
  const state = { orders: {}, channels: [], addresses: [] };
  const calls = { open: 0, saves: 0, alerts: [] };
  let addrN = 0;
  const lnd = {
    tip: async () => 100,
    transactions: async () => txs,
    newAddress: async () => (addrN++ === 1 ? 'bc1qreused' : `bc1qaddr${addrN}`),
    connect: async () => (typeof connected === 'function' ? connected() : connected),
    channelsWithMemo: async () => memoChannels,
  };
  const w = createOnchain({
    state, save: () => calls.saves++, log: () => {}, alert: (m) => calls.alerts.push(m), now: () => t, lnd,
    open: openImpl || (async () => { calls.open++; await new Promise((r) => setTimeout(r, 20)); return { txid: 'c'.repeat(64), index: 0 }; }),
  });
  return { w, state, calls, lnd, setTime: (x) => { t = x; }, setTxs: (x) => { txs.length = 0; txs.push(...x); } };
}
const tx = (confs, sats = 10_000, hash = 'f'.repeat(64)) => ({ tx_hash: hash, num_confirmations: confs, block_height: confs ? 101 : 0, time_stamp: T0 + 60,
  output_details: [{ address: ADDR, output_index: 0, amount: String(sats), is_our_address: true }] });

test('worker: opens exactly one channel even with overlapping passes', async () => {
  const h = harness({ txs: [tx(3)] });
  h.state.orders.aa = order();
  await Promise.all([h.w.tick(), h.w.tick(), h.w.tick()]);      // first pass: confirming → opens
  await h.w.tick(); await h.w.tick();
  assert.strictEqual(h.calls.open, 1);
  assert.strictEqual(h.state.orders.aa.status, 'opening');
  assert.strictEqual(h.state.channels.length, 1);
  assert.ok(h.calls.alerts.some((m) => /canal abierto/.test(m)));
});
test('worker: a restart during an open never opens again; adopts the channel by memo', async () => {
  const h = harness({ txs: [tx(5)], memoChannels: [{ point: 'd'.repeat(64) + ':1' }] });
  h.state.orders.aa = order({ status: 'opening_started', openStarted: T0 + 50, payment: { txid: 'f'.repeat(64), vout: 0, sats: 10_000 },
    payments: [{ ...out({ confs: 3 }), firstSeen: T0 + 60 }] });
  await h.w.tick();
  assert.strictEqual(h.calls.open, 0);
  assert.strictEqual(h.state.orders.aa.status, 'opening');
  assert.strictEqual(h.state.orders.aa.fundingTxid, 'd'.repeat(64));
});
test('worker: interrupted open without a channel: operator, no open', async () => {
  const h = harness({ txs: [tx(5)], memoChannels: [] });
  h.state.orders.aa = order({ status: 'opening_started', openStarted: T0 + 50, payments: [{ ...out({ confs: 3 }), firstSeen: T0 + 60 }] });
  await h.w.tick(); await h.w.tick();
  assert.strictEqual(h.calls.open, 0);
  assert.strictEqual(h.state.orders.aa.status, 'needs_operator');
  assert.match(h.state.orders.aa.reason, /interrupted open/);
});
test('worker: buyer offline after confirmation: retries, then operator after 24 h', async () => {
  const h = harness({ txs: [tx(3)], connected: false });
  h.state.orders.aa = order();
  await h.w.tick();
  assert.strictEqual(h.state.orders.aa.status, 'confirming'); assert.ok(h.state.orders.aa.offlineSince);
  h.setTime(T0 + 100 + 3600); await h.w.tick();
  assert.strictEqual(h.state.orders.aa.status, 'confirming');
  h.setTime(T0 + 100 + 86400 + 120); await h.w.tick();
  assert.strictEqual(h.state.orders.aa.status, 'needs_operator'); assert.match(h.state.orders.aa.reason, /offline/);
  assert.strictEqual(h.calls.open, 0);
});
test('worker: buyer back online within the day: opens', async () => {
  let up = false;
  const h = harness({ txs: [tx(3)], connected: () => up });
  h.state.orders.aa = order();
  await h.w.tick();
  up = true; h.setTime(T0 + 100 + 30); await h.w.tick();
  assert.strictEqual(h.calls.open, 0);                            // waits for the retry time
  h.setTime(T0 + 100 + 61); await h.w.tick();
  assert.strictEqual(h.calls.open, 1); assert.strictEqual(h.state.orders.aa.status, 'opening');
});
test('worker: a failed open goes to the operator (no refund, no retry)', async () => {
  const h = harness({ txs: [tx(3)], openImpl: async () => { throw new Error('not enough confirmed liquidity any more'); } });
  h.state.orders.aa = order();
  await h.w.tick(); await h.w.tick();
  assert.strictEqual(h.state.orders.aa.status, 'needs_operator'); assert.match(h.state.orders.aa.reason, /liquidity/);
  assert.ok(h.calls.alerts.some((m) => /NECESITA OPERADOR/.test(m)));
});
test('worker: never reuses an address', async () => {
  const h = harness();
  const o1 = {}, o2 = {}, o3 = {};
  await h.w.issue(o1);
  h.state.addresses.push('bc1qreused');                            // as if issued long ago
  await assert.rejects(h.w.issue(o2), /already used/);
  await h.w.issue(o3);
  assert.notStrictEqual(o1.address, o3.address);
  assert.strictEqual(o2.address, undefined);
});
