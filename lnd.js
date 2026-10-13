'use strict';
// Thin LND REST client (Lightning Fork, BLAKE2b) with the offersrpc REST paths.
const https = require('https');
const fs = require('fs');

class Lnd {
  constructor({ host = '127.0.0.1', port = 8280, macaroonFile, certFile }) {
    this.host = host;
    this.port = port;
    this.macaroon = fs.readFileSync(macaroonFile, 'utf8').trim();
    this.agent = new https.Agent({ ca: fs.readFileSync(certFile), keepAlive: true });
  }

  // One JSON answer. `stream`: LND streams newline-delimited {"result":…}
  // objects; we collect them and hand back the last one (or the first that
  // `until` accepts, closing the socket then).
  request(method, path, body, { timeout = 30000, stream = false, until } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request({
        host: this.host, port: this.port, path, method, agent: this.agent,
        headers: {
          'Grpc-Metadata-macaroon': this.macaroon,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let buf = '';
        let last = null;
        let done = false;
        const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          if (!stream) return;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj.error) return finish(() => { req.destroy(); reject(lndError(obj.error)); });
            if (res.statusCode >= 400 || (obj.code && obj.message && !obj.result)) return finish(() => { req.destroy(); reject(lndError(obj, res.statusCode)); });
            last = obj.result ?? obj;
            if (until && until(last)) return finish(() => { req.destroy(); resolve(last); });
          }
        });
        res.on('end', () => finish(() => {
          if (stream) {
            if (buf.trim()) {
              try {
                const obj = JSON.parse(buf);
                if (obj.error) return reject(lndError(obj.error));
                if (res.statusCode >= 400 || (obj.code && obj.message && !obj.result)) return reject(lndError(obj, res.statusCode));
                last = obj.result ?? obj;
              } catch { /* ignore */ }
            }
            return last ? resolve(last) : reject(new Error('empty stream from LND'));
          }
          let obj;
          try { obj = JSON.parse(buf || '{}'); } catch { return reject(new Error(`LND ${res.statusCode}: ${buf.slice(0, 200)}`)); }
          if (res.statusCode >= 400 || (obj.code && obj.message)) return reject(lndError(obj, res.statusCode));
          resolve(obj);
        }));
      });
      const timer = setTimeout(() => { req.destroy(new Error(`LND ${path} timed out`)); }, timeout);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  }

  get(path, opts) { return this.request('GET', path, undefined, opts); }
  post(path, body, opts) { return this.request('POST', path, body, opts); }

  getInfo() { return this.get('/v1/getinfo'); }
  channelBalance() { return this.get('/v1/balance/channels'); }
  decodePayReq(payreq) { return this.get(`/v1/payreq/${encodeURIComponent(payreq)}`); }
  addInvoice(body) { return this.post('/v1/invoices', body); }
  lookupInvoice(hashHex) { return this.get(`/v1/invoice/${hashHex}`); }
  listInvoices(q) { return this.get(`/v1/invoices?${new URLSearchParams(q)}`); }
  listPayments(q) { return this.get(`/v1/payments?${new URLSearchParams(q)}`); }
  // routerrpc.TrackPaymentV2: for a finished payment the first message is final
  trackPayment(hashHex) {
    return this.get(`/v2/router/track/${b64url(hashHex)}?no_inflight_updates=true`, {
      stream: true, timeout: 10000, until: () => true,
    });
  }
  // routerrpc.SendPaymentV2 (BOLT11)
  sendPayment(body, timeoutSec) {
    return this.post('/v2/router/send', body, {
      stream: true, timeout: (timeoutSec + 30) * 1000, until: (p) => p.status === 'SUCCEEDED' || p.status === 'FAILED',
    });
  }

  // offersrpc
  listOffers() { return this.get('/v2/offers'); }
  createOffer(body) { return this.post('/v2/offers', body); }
  decodeBolt12(bolt12) { return this.post('/v2/offers/decode', { bolt12 }); }
  fetchInvoice(body) { return this.post('/v2/offers/fetchinvoice', body, { timeout: 90000 }); }
  payOffer(body) { return this.post('/v2/offers/pay', body, { timeout: ((body.timeout_seconds || 60) * 2 + 30) * 1000 }); }
}

function lndError(obj, status) {
  const e = new Error(obj.message || `LND error ${status}`);
  e.lndCode = obj.code;
  e.httpStatus = status;
  return e;
}

const b64ToHex = (s) => (s ? Buffer.from(s, 'base64').toString('hex') : '');
const hexToB64 = (h) => Buffer.from(h, 'hex').toString('base64');
// grpc-gateway wants URL-safe base64 *with* padding in path parameters
const b64url = (h) => Buffer.from(h, 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

module.exports = { Lnd, b64ToHex, hexToB64 };
