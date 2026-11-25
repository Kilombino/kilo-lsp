'use strict';
// node --test coins.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pickCoins } = require('./coins');
const c = (n, sats, type = 'TAPROOT_PUBKEY') => ({ txid: 't' + n, vout: 0, sats, type });
const big = c(1, 346_000_000);
const smalls = [c(2, 5_000), c(3, 30_000), c(4, 12_000), c(5, 200_000), c(6, 3_000_000)];

test('the smallest coin that pays, never the biggest', () => {
  assert.deepStrictEqual(pickCoins([big, ...smalls], 2_000_000, 2).map((x) => x.sats), [3_000_000]);
});
test('no single small coin: the small ones smallest first', () => {
  const r = pickCoins([big, c(2, 5_000), c(3, 30_000), c(4, 12_000), c(5, 200_000)], 220_000, 2);
  assert.deepStrictEqual(r.map((x) => x.sats), [5_000, 12_000, 30_000, 200_000]);
});
test('too many tiny coins for MAX_INPUTS: the fewest, largest first', () => {
  const many = [big, ...Array.from({ length: 15 }, (_, i) => c(10 + i, 10_000)), c(40, 150_000), c(41, 100_000)];
  assert.deepStrictEqual(pickCoins(many, 240_000, 2).map((x) => x.sats), [150_000, 100_000]);
});
test('only the biggest pays: it alone', () => {
  assert.deepStrictEqual(pickCoins([big, ...smalls], 10_000_000, 2).map((x) => x.sats), [346_000_000]);
});
test('a coin worth less than its input is left alone', () => {
  const r = pickCoins([big, c(50, 50), c(51, 30_000), c(52, 30_000)], 50_000, 2);
  assert.ok(!r.some((x) => x.sats === 50));
  assert.strictEqual(r.length, 2);
});
test('nothing pays alone: all coins, as before', () => {
  const r = pickCoins([c(1, 100_000), c(2, 50_000)], 140_000, 2);
  assert.strictEqual(r.length, 2);
});
