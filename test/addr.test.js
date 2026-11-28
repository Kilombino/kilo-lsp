'use strict';
// node --test 'test/*.test.js'
const test = require('node:test');
const assert = require('node:assert');
const { refundAddress } = require('../addr');

test('valid mainnet addresses (BIP173/BIP350 vectors and known legacy ones)', () => {
  for (const a of [
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
    '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  ]) assert.strictEqual(refundAddress(a), a, a);
});
test('uppercase bech32 is accepted and given back in lowercase; spaces trimmed', () => {
  assert.strictEqual(refundAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  assert.strictEqual(refundAddress('  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 '), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
});
test('refused: test networks, typos, wrong checksum kind, future versions, junk', () => {
  for (const a of [
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',                       // testnet
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',                       // checksum
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',   // v1 with bech32
    'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',                             // witness v2
    'bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',                       // mixed case
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3',                               // legacy checksum
    'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',                               // testnet legacy
    'lnbc1...', '', null, 42, '02' + 'a'.repeat(64),
  ]) assert.strictEqual(refundAddress(a), null, String(a));
});
