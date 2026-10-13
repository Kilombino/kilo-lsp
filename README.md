# kilo-lsp

Kilombino's inbound liquidity service for Kilowallet (Lightning on the BLAKE2b chain).
A wallet asks for a private channel of 1–50 million sats from Kilombino's node, signs the
request with its node key and pays a hold invoice for the fee (5,000 sats per million). The
invoice is settled only once the channel's funding transaction is published; otherwise it is
cancelled and the payment goes back. Channels are kept open at least 90 days.

API (https://lsp.kilombino.com):
- `GET /v1/info` — limits, fee, liquidity available now.
- `POST /v1/quote` `{pubkey, sats, ts, signature}` — signature = LND SignMessage of
  `kilowallet-lsp:v1:<pubkey>:<sats>:<ts>`; returns `{id, invoice, fee, expires}`.
- `GET /v1/order/<id>` — `waiting_payment`, `paid`, `opening` (with `fundingTxid`), `open`, `failed` (with `reason`), `expired`.

Runs as the user service `kilo-lsp` on 127.0.0.1:3240; config, macaroon and state in `~/.config/kilo-lsp` (not in this repo).
