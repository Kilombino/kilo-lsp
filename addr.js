'use strict';
// Mainnet address check for refund addresses. Bitcoin BLAKE2b keeps Bitcoin's mainnet address
// formats: bech32 bc1q… (witness v0, 20 or 32 bytes), bech32m bc1p… (taproot, 32 bytes) and the
// legacy base58check ones starting with 1 (P2PKH) or 3 (P2SH). Anything else is refused: test
// networks (tb1, m/n/2…), future witness versions (no wallet can spend them yet) and typos
// (the checksums catch them).
const crypto = require('crypto');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32 = 1, BECH32M = 0x2bc830a3;

function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

function convertBits(data, from, to) {
  let acc = 0, bits = 0;
  const out = [], maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv)) return null; // leftover padding must be zero
  return out;
}

function segwit(addr) {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const s = addr.toLowerCase();
  if (s.length < 14 || s.length > 90) return null;
  const pos = s.lastIndexOf('1');
  if (s.slice(0, pos) !== 'bc') return null;
  const data = [];
  for (const c of s.slice(pos + 1)) { const v = CHARSET.indexOf(c); if (v < 0) return null; data.push(v); }
  if (data.length < 7) return null;
  const spec = polymod([...hrpExpand('bc'), ...data]);
  const ver = data[0];
  const prog = convertBits(data.slice(1, -6), 5, 8);
  if (!prog) return null;
  if (ver === 0 && spec === BECH32 && (prog.length === 20 || prog.length === 32)) return s;
  if (ver === 1 && spec === BECH32M && prog.length === 32) return s;
  return null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function legacy(addr) {
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) return null;
  let n = 0n;
  for (const c of addr) n = n * 58n + BigInt(B58.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  const lead = addr.match(/^1*/)[0].length;
  const bytes = Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
  if (bytes.length !== 25 || (bytes[0] !== 0x00 && bytes[0] !== 0x05)) return null;
  const sum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(bytes.subarray(0, 21)).digest()).digest();
  return sum.subarray(0, 4).equals(bytes.subarray(21)) ? addr : null;
}

// The address in its usual spelling (bech32 in lowercase), or null when it is not a valid
// mainnet address.
function refundAddress(a) {
  if (typeof a !== 'string') return null;
  const s = a.trim();
  return /^bc1/i.test(s) ? segwit(s) : legacy(s);
}

module.exports = { refundAddress };
