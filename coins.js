'use strict';
// Coin selection for a channel's funding (the same rules as Kiloswap's guard for its lockups):
// the smallest coin that covers the channel and its fee, other than the biggest; or else the
// smaller coins smallest first (dust consolidates), up to MAX_INPUTS; or else the fewest of them
// largest first; and the biggest coin only when nothing else pays (alone if it can, all coins as
// a last resort). A coin worth less than spending it costs is left alone.
const MAX_INPUTS = 10;
const inputVbytes = (t) => (/WITNESS_PUBKEY_HASH/.test(t) && !/NESTED/.test(t) ? 68 : /NESTED/.test(t) ? 91 : 58);
const fundingFee = (rate, inputs) => Math.ceil((11 + 43 + 43 + 20 + inputs.reduce((v, c) => v + inputVbytes(c.type), 0)) * rate);
function pickCoins(coins, amount, rate) {
  const sorted = [...coins].filter((c) => c.sats > 0).sort((a, b) => a.sats - b.sats);
  if (!sorted.length) return [];
  const biggest = sorted[sorted.length - 1], others = sorted.slice(0, -1);
  const pays = (inputs) => inputs.reduce((s, c) => s + c.sats, 0) >= amount + fundingFee(rate, inputs);
  for (const c of others) if (pays([c])) return [c];
  const worth = others.filter((c) => c.sats > inputVbytes(c.type) * rate);
  let inputs = [];
  for (const c of worth) { if (inputs.length >= MAX_INPUTS) break; inputs.push(c); if (pays(inputs)) return inputs; }
  inputs = [];
  for (const c of [...worth].reverse()) { if (inputs.length >= MAX_INPUTS) break; inputs.push(c); if (pays(inputs)) return inputs; }
  if (pays([biggest])) return [biggest];
  return sorted;
}

module.exports = { pickCoins, fundingFee, inputVbytes, MAX_INPUTS };
