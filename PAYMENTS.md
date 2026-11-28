# Stripe GBP checkout operations

The app supports Stripe-hosted card checkout in GBP, with NUM quoted at
£0.025/NUM. A buyer can select either the pre-funded in-game NUM asset or
native NUM delivered to a validated wallet address. Card details are entered on
Stripe; the server never receives or stores card data.

## Disabled by default

Do not paste keys into source control, chat, logs, or frontend variables. Use
the deployment platform's private server-side secret store. If a credential
was exposed, revoke it and create a replacement.

Configure:

- `STRIPE_SECRET_KEY` (`sk_test_...` for sandbox; `sk_live_...` only for
approved production use)
- `STRIPE_WEBHOOK_SECRET` for the signing secret of the deployed webhook
- `STRIPE_PUBLIC_BASE_URL` as the canonical public HTTPS app URL
- `NUMISTA_ONRAMP_TEST_ENABLED=1` for sandbox only
- `NUMISTA_ONRAMP_LIVE_ENABLED=1` and
  `NUMISTA_ONRAMP_MAINNET_READY=1` only after production readiness review
- `NUMISTA_NETWORK=mainnet` plus a live, synchronized mainnet daemon and wallet

The mainnet switch alone is not proof of mainnet. Mainnet mode has no testnet
RPC, issuer, treasury-address, or currency-asset fallbacks, and live chain
readiness requires the daemon to report `mainnet` or `numista-mainnet`
explicitly and verifies the configured currency asset is the expected fungible
NUM asset. Live order creation also checks the synchronized daemon's network.
This repository's defaults remain testnet, so live checkout should currently
stay disabled.

In Stripe, register the endpoint `<public-base-url>/api/onramp/webhook` and
subscribe it to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `charge.refunded`
- `charge.dispute.created`

The server validates the webhook signature against the raw request body,
checks the order, amount, and currency, and processes event IDs idempotently.
The browser's old payment-completion endpoint cannot mark an order paid.
Successful game-balance delivery is a treasury-funded asset transfer and is
reported complete only after chain confirmation. Wallet delivery is a native
NUM treasury transfer; uncertain outcomes require manual chain reconciliation
and are never automatically resent.

## Before any live sale

1. Verify mainnet RPC endpoints, network identity, currency asset ID, asset
   metadata, and the destination address format against the actual daemon.
2. Fund and verify both treasury inventories if both delivery options will be
   offered. Checkout rejects orders when the matching inventory is already
   reserved or unavailable.
3. Configure the production HTTPS origin and webhook; verify signatures and
   successful, failed, duplicate, expired, refunded, and disputed event paths
   using Stripe test mode first.
4. Define and publish refund, cancellation, delivery, support, privacy, and
   consumer terms. A refund or dispute after irreversible NUM delivery is
   flagged for manual review; this app does not automatically claw back NUM or
   issue Stripe refunds.
5. Confirm the business is approved by Stripe for the actual product and
   jurisdictions, and review applicable legal, tax, consumer-protection, and
   cryptoasset obligations with qualified advisers.
6. Back up and restrict access to `server/data/stripeOrders.json` (or the path
   configured by `NUMISTA_ONRAMP_ORDERS_FILE`). It contains order and delivery
   state needed for idempotent fulfillment and recovery.

This is not a declaration that the current testnet or game token has real-world
value, nor that the app is ready to accept live payments.

The systemd daemon and wallet-RPC units in `deploy/` are testnet-specific.
Do not use them for mainnet; provision separate services with the official
mainnet network arguments, data directory, ports, and wallet configuration.
