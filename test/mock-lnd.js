'use strict';
// A fake LND REST server for the end-to-end test: just the calls kilo-lsp makes, with a
// control API (/_ctl/…) to add wallet transactions, accept invoices and deny permissions.
const https = require('https');
const crypto = require('crypto');

function createMockLnd({ key, cert, pubkey }) {
  const s = {
    peers: new Set(), txs: [], invoices: {}, opens: [], settles: 0, cancels: 0, addrN: 0, height: 1000,
    denied: new Set(), channels: [], pending: [], streams: {},
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const deny = (res) => json(res, 500, { code: 2, message: 'permission denied' });
  const server = https.createServer({ key, cert }, async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    const u = new URL(req.url, 'https://x');
    const p = u.pathname;
    const route = `${req.method} ${p}`;
    if (s.denied.has(p)) return deny(res);
    switch (route) {
      case 'GET /v1/getinfo': return json(res, 200, { identity_pubkey: pubkey, uris: [`${pubkey}@lsp.example.onion:9735`], block_height: s.height });
      case 'GET /v1/utxos': return json(res, 200, { utxos: [
        { outpoint: { txid_str: 'a'.repeat(64), output_index: 0 }, amount_sat: '3000000', address_type: 'TAPROOT_PUBKEY' },
        { outpoint: { txid_str: 'b'.repeat(64), output_index: 1 }, amount_sat: '90000000', address_type: 'TAPROOT_PUBKEY' }] });
      case 'GET /v1/peers': return json(res, 200, { peers: [...s.peers].map((k) => ({ pub_key: k })) });
      case 'POST /v1/peers': s.peers.add(b.addr.pubkey); return json(res, 200, {});
      case 'GET /v1/channels': return json(res, 200, { channels: s.channels });
      case 'GET /v1/channels/pending': return json(res, 200, { pending_open_channels: s.pending });
      case 'GET /v1/newaddress': s.addrN++; return json(res, 200, { address: `bc1qmockaddress${String(s.addrN).padStart(4, '0')}` });
      case 'GET /v1/transactions': return json(res, 200, { transactions: s.txs });
      case 'POST /v1/verifymessage': return json(res, 200, { valid: false, pubkey: s.signer });
      case 'POST /v2/invoices/hodl': {
        const hash = Buffer.from(b.hash, 'base64').toString('hex');
        s.invoices[hash] = { state: 'OPEN', value: b.value };
        return json(res, 200, { payment_request: 'lnbcmock' + hash.slice(0, 20) });
      }
      case 'GET /v2/invoices/lookup': {
        const hash = Buffer.from(u.searchParams.get('payment_hash').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');
        return json(res, 200, s.invoices[hash] || { state: 'OPEN' });
      }
      case 'POST /v2/invoices/settle': s.settles++; return json(res, 200, {});
      case 'POST /v2/invoices/cancel': s.cancels++; return json(res, 200, {});
      case 'POST /v2/wallet/psbt/fund': return json(res, 200, { funded_psbt: Buffer.from(JSON.stringify(b.raw)).toString('base64'), locked_utxos: [] });
      case 'POST /v2/wallet/psbt/finalize': return json(res, 200, { signed_psbt: b.funded_psbt });
      case 'POST /v2/wallet/utxos/release': return json(res, 200, {});
      case 'POST /v1/funding/step': {
        if (b.psbt_finalize) {
          const st = s.streams[b.psbt_finalize.pending_chan_id];
          const txid = crypto.randomBytes(32);
          const point = `${Buffer.from(txid).reverse().toString('hex')}:0`;
          s.pending.push({ channel: { remote_node_pub: st.pubkey, capacity: st.sats, memo: st.memo, channel_point: point } });
          st.res.write(JSON.stringify({ result: { chan_pending: { txid: txid.toString('base64'), output_index: 0 } } }) + '\n');
        }
        return json(res, 200, {});
      }
      case 'POST /v1/channels/stream': {
        const pubkey = Buffer.from(b.node_pubkey, 'base64').toString('hex');
        s.opens.push({ pubkey, sats: Number(b.local_funding_amount), private: b.private, memo: b.memo });
        res.writeHead(200, { 'content-type': 'application/json' });
        s.streams[b.funding_shim.psbt_shim.pending_chan_id] = { res, pubkey, sats: b.local_funding_amount, memo: b.memo };
        res.write(JSON.stringify({ result: { psbt_fund: { funding_address: 'bc1qfunding', funding_amount: b.local_funding_amount } } }) + '\n');
        return;
      }
      // ---- control
      case 'POST /_ctl/tx': {
        const t = { tx_hash: b.txid || crypto.randomBytes(32).toString('hex'), num_confirmations: b.confs || 0, block_height: b.confs ? s.height : 0,
          time_stamp: Math.floor(Date.now() / 1000), output_details: [{ address: b.address, output_index: b.vout || 0, amount: String(b.sats), is_our_address: true }] };
        s.txs.push(t); return json(res, 200, t);
      }
      case 'POST /_ctl/confs': for (const t of s.txs) if (t.tx_hash === b.txid) { t.num_confirmations = b.confs; t.block_height = b.confs ? s.height : 0; } return json(res, 200, {});
      case 'POST /_ctl/accept': for (const v of Object.values(s.invoices)) if (v.state === 'OPEN') v.state = 'ACCEPTED'; return json(res, 200, {});
      case 'POST /_ctl/deny': s.denied = new Set(b.paths || []); return json(res, 200, {});
      case 'POST /_ctl/signer': s.signer = b.pubkey; return json(res, 200, {});
      case 'GET /_ctl/state': return json(res, 200, { opens: s.opens, settles: s.settles, cancels: s.cancels, peers: [...s.peers] });
      default: return json(res, 404, { code: 5, message: 'not found ' + route });
    }
  });
  return { server, s };
}
module.exports = { createMockLnd };
