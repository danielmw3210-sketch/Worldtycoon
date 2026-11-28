# Mining limitations and blockchain-side requirements

This note records the current mining behavior and the blockchain integration
gaps to resolve before treating pool shares or payouts as production-ready.
The project is experimental and currently targets a Numista testnet.

## Current behavior

- The built-in TCP Stratum server requests a block template for the pool vault
  and submits a candidate block through the daemon's `submit_block` RPC.
- A Stratum submission is recorded in the built-in PPLNS window only when the
  daemon accepts it as a network block. This prevents arbitrary submissions
  from being counted, but ordinary valid pool shares that do not meet network
  difficulty are not counted. Consequently, this is not conventional PPLNS
  accounting and miners receive no share credit for non-winning work.
- The browser mining API has a separate verifier in
  [`server/mining/pool.js`](./server/mining/pool.js). It compares submissions
  against the local `fastMixHash` function and a hard-coded leading-zero
  threshold. That function is not a server-side RandomX verification path and
  must not be treated as proof of real RandomX work.
- The external Stratum bridge forwards submissions to a configured pool. Its
  accepted/rejected accounting and payout evidence should be reconciled with
  the external pool's actual response, not assumed to be equivalent to the
  built-in pool.
- Native block templates and block submissions are obtained through
  [`server/numista/rpc.js`](./server/numista/rpc.js); mining routes and startup
  wiring are in [`server/index.js`](./server/index.js). Pool and Stratum logic
  live in [`server/mining/pool.js`](./server/mining/pool.js) and
  [`server/mining/stratumServer.js`](./server/mining/stratumServer.js).

## Blockchain-side limitations

The daemon validates full candidate blocks against network consensus. Its
`submit_block` result does not provide a general-purpose lower-difficulty share
verification service. A pool therefore needs a trusted way to verify each
share against a pool target before it can include that share in PPLNS:

1. Use a blockchain/pool RPC that validates shares at a configurable pool
   difficulty; or
2. Verify shares server-side using the exact RandomX implementation, seed,
   block-template format, nonce rules, target calculation, and network
   difficulty rules used by the daemon; or
3. Rely on a separate trusted pool and reconcile its authenticated share and
   payout records.

Until one of these approaches is implemented and tested against the live
daemon, do not count client-provided hashes as verified work. Submitting every
candidate to `submit_block` is safe for consensus but only identifies actual
network blocks; it cannot substitute for pool-share validation.

## Decisions and follow-up

- Confirm which daemon RPCs and RandomX parameters the target Numista network
  exposes, including seed-hash selection and template/nonce serialization.
- Choose whether the built-in pool should support server-side RandomX
  verification or whether mining should use an external pool.
- Define pool difficulty and share target independently from network block
  difficulty, including how variable-difficulty weights are calculated.
- Reject stale, duplicate, malformed, or wrong-worker submissions before they
  affect share accounting. Track accepted and rejected shares from actual
  validation results.
- Credit PPLNS only from verified shares and distribute only block rewards
  confirmed by the chain. Make payout retries and duplicate block handling
  idempotent.
- Keep simulation behavior clearly separated from live mining and expose
  whether work was locally simulated, pool-verified, or accepted as a network
  block.

## NUM quote note

The GBP exchange setting in `server/config.js` is the GBP cost per NUM used by
the quote endpoint. It is `0.025`, so £1 quotes as 40 NUM. Stripe Checkout is
implemented behind environment gates. Order completion is driven only by a
signed Stripe webhook; the legacy client completion route is disabled. Live
checkout requires explicit operator flags, `NUMISTA_NETWORK=mainnet`, and a live
chain connection. The current checked-in network defaults remain testnet, so
live payments must remain disabled until mainnet and treasury inventory are
verified.
