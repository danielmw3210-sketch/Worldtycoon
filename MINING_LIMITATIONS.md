# Mining limitations and blockchain-side requirements

The project is experimental and currently targets a Numista testnet.

## Current behavior

- The built-in Stratum server ([`server/mining/stratumServer.js`](./server/mining/stratumServer.js))
  starts with the backend (set `NUMISTA_DISABLE_STRATUM=1` to skip). It listens on
  `NUMISTA_STRATUM_PORT` (default 3333).
- Every share is verified server-side with RandomX
  ([`server/mining/shareVerifier.js`](./server/mining/shareVerifier.js)) against the
  daemon's block template, with per-job duplicate-nonce rejection. Share
  difficulty is `NUMISTA_SHARE_DIFFICULTY` (default 100). A hash that meets network
  difficulty is submitted with `submit_block`.
- PPLNS credit is split from the verified share window only after the block has
  `NUMISTA_PAYOUT_CONFIRMATIONS` confirmations (default 10) and is not orphaned.
  Payout balances are zeroed before sending and restored if the send fails.
- Logins must be a valid Numista address; there is no treasury fallback.
- The browser connects through the bridge, which only allows the built-in pool
  (127.0.0.1 on the Stratum port). External pools are rejected.
- The legacy `/api/mining/job` and `/api/mining/submit` APIs return HTTP 503 by design.

## Remaining limitations

- Tested only against a mock daemon ([`server/test-stratum.mjs`](./server/test-stratum.mjs));
  it has not been run against a live Numista daemon.
- RandomX cache initialisation blocks the event loop for about 5 seconds on each seed change.
- Pool state is a JSON file (`server/data/pplnsStratum.json`).

## NUM quote note

The GBP exchange setting in `server/config.js` is the GBP cost per NUM used by
the quote endpoint. It is `0.025`, so Â£1 quotes as 40 NUM. Stripe Checkout is
implemented behind environment gates. Order completion is driven only by a
signed Stripe webhook; the legacy client completion route is disabled. Live
checkout requires explicit operator flags, `NUMISTA_NETWORK=mainnet`, and a live
chain connection. The current checked-in network defaults remain testnet, so
live payments must remain disabled until mainnet and treasury inventory are
verified.
