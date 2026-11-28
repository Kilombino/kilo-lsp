# kilo-lsp

Kilombino's inbound liquidity service for Kilowallet (Lightning on Bitcoin BLAKE2b).
A wallet asks for a channel (private unless it asks for a public one) of 1–50 million sats from Kilombino's node, signs the
request with its node key and pays a hold invoice for the fee (5,000 sats per million). The
invoice is settled only once the channel's funding transaction is published; otherwise it is
cancelled and the payment goes back. Channels are kept open at least 90 days.

API (https://lsp.kilombino.com):
- `GET /v1/info` — limits, fee, liquidity available now; `private: true` (the default),
  `publicChannels: true` (a request may ask for an announced channel) and `payments`
  (`lightning: true`, `onchain: {confirmations, windowSeconds, …}` or `false` when not offered).
- `POST /v1/quote` `{pubkey, sats, ts, signature}` — signature = LND SignMessage of
  `kilowallet-lsp:v1:<pubkey>:<sats>:<ts>`; returns `{id, method, invoice, fee, public, expires}`.
  Instead of the signature, `host` (`host:port` of the node; we connect to it).
  Optional: `public` (boolean, default `false`: a private channel, as before) and
  `payment` (`"lightning"`, the default, or `"onchain"` with `refundAddress`).
- `GET /v1/order/<id>` — `waiting_payment`, `paid`, `confirming` (on-chain), `opening` (with `fundingTxid`),
  `open`, `failed` (with `reason`), `expired`, `needs_operator` (on-chain, with `reason`); plus `public`, `method`
  and, on-chain, `address`, `amount`, `confirmations`, `confirmationsNeeded`, `paymentTxid`.

Without options a request is exactly what it always was: a private channel paid with a hold invoice.

## On-chain payment of the fee

Offered only when our node is connected to the buyer's right now, the buyer gives a refund
address (a mainnet `bc1…`, `1…` or `3…` address; anything else is refused) and the macaroon
allows `NewAddress` and `GetTransactions` (without them the option is simply hidden).
Each order gets a fresh address of the node's wallet (never reused) for exactly the fee. The
payment must be first seen (mempool or block) within 60 minutes; after 3 confirmations the
channel opens like any other (coins chosen by `coins.js`). If confirmations drop (a reorg) it
waits until they are back to 3.

Anything unusual stops the order as `needs_operator` and tells the operator: under- or
overpayment, a payment after the window or to an order that ended, more than one payment, a
payment that disappears or never confirms (24 h), the buyer's node unreachable for 24 h after
confirmation, a failed open. **Nothing is refunded or sent automatically**: the only coins the
LSP moves are channel fundings; refunds are the operator's, by hand, to the refund address.
An order is saved as `opening_started` before its channel is asked for; after a restart such an
order is never opened again (its channel is adopted by the memo `kilowallet-lsp <id>`, or the
operator looks). At most 2 on-chain orders wait for payment at once, 1 per visitor and per node.

Alerts (new on-chain order, payment seen, channel opened, every `needs_operator`) go to
Telegram when `TELEGRAM_CHAT` and `TELEGRAM_TOKEN` (or `TELEGRAM_TOKEN_FILE`: the token alone,
or an env file with a `…TELEGRAM_TOKEN=` line) are set; otherwise only to the log.

Other settings: `LSP_ONCHAIN=0` turns on-chain off; `LSP_ONCHAIN_ADDRESS_TYPE=p2tr` for
taproot addresses (default p2wkh); `LSP_LND_HOST`/`LSP_LND_PORT` (default 127.0.0.1:8280);
`LSP_FEE_URL` (`off` = 2 sat/vB).

Macaroon URIs: `/lnrpc.Lightning/GetInfo`, `ListUnspent`, `ListPeers`, `ConnectPeer`,
`ListChannels`, `PendingChannels`, `VerifyMessage`, `OpenChannel`, `FundingStateStep`,
`/invoicesrpc.Invoices/AddHoldInvoice`, `CancelInvoice`, `SettleInvoice`, `LookupInvoiceV2`,
`/walletrpc.WalletKit/FundPsbt`, `FinalizePsbt`, `ReleaseOutput`; for on-chain payment also
`/lnrpc.Lightning/NewAddress` and `/lnrpc.Lightning/GetTransactions`.

Each channel is funded with chosen coins (`coins.js`): the smallest that pays, else the small
ones smallest first (dust consolidates, up to 10), and the biggest coin only when nothing else
pays. Tests: `node --test 'test/*.test.js'` (unit tests and an end-to-end run of `server.js`
against a mock LND; needs `openssl`).

Runs as the user service `kilo-lsp` on 127.0.0.1:3240; config, macaroon and state in `~/.config/kilo-lsp` (not in this repo).

License: MIT (see LICENSE).
