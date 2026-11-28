# Worldtycoon

Worldtycoon is an experimental UK land, settlement, and strategy game with a
React/Vite frontend and an Express backend. It is designed to integrate with
Numista mainnet asset and wallet RPCs, with separate simulation and testnet modes.

> **Experimental software:** Mainnet operations may affect real assets.
> The game and its transaction recovery are not yet production-ready. Do not
> use real funds or expose private RPC services to the public internet.

## What is implemented

- **UK land map:** A deterministic, seeded registry of 3,500 plots by default
  (50 columns × 70 rows). Plot rarity, prices, labels, and legacy resource deposits
  are generated from the configured grid seed. Hand-authored landmarks are
  pinned to the map.
- **Land and settlement progression:** Claim a plot, develop its Peasant Lodge
  through level 10, and collect accrued property income. Level 5 becomes a
  Motte-and-Bailey; level 10 becomes a player-owned Castle Keep.
- **Plot resources:** Every claimed plot produces 5 wood per hour for free.
  Build resource structures on any settlement for unlimited wood, iron, tin,
  copper, silver, or gold production. Their output scales with settlement level,
  and stockpiles belong to the plot.
- **Forge and armies:** Build a Settlement Forge, craft bronze and iron weapons
  or armor, equip soldiers, recruit troops, form armies, and march or siege.
  Army marches and attacks use a distance-based silver payroll.
- **Game artwork:** Claimed settlements appear on the map from zoom level 6;
  zoom in to see additional buildings. Settlement, resource, troop, equipment,
  and metal artwork also appears in their respective panels. Artwork is bundled
  locally in `public/assets` and is included in production builds.
- **Owner-issued assets:** A Resource Mint lets the owner issue any stored
  resource as a fungible Numista asset, or issue silver and gold as coins or
  bars. Stock is reserved while the transaction is pending and restored if it
  definitively fails.
- **Other game systems:** Peerage, castles, town-hall taxes, banking, stocks,
  auctions, coin collections, account/deed views, and blockchain explorers.
- **Mining:** A RandomX worker can connect to a configured Stratum endpoint;
  the interface also provides a solo-mining command. Mining requires a usable
  Numista node/pool and wallet address. The built-in pool and legacy local
  share API are disabled because their share verification and payout
  accounting are not production-ready; use a trusted external pool instead.
- **Chain modes:** Use a local simulated chain for development, or connect a
  compatible Numista daemon and wallet RPC for mainnet or testnet operations.

### Settlement progression and buildings

| Settlement level | Milestone |
| ---: | --- |
| 1–4 | Peasant Lodge settlement |
| 5–9 | Motte-and-Bailey |
| 10 | Castle Keep (1,000 maximum integrity) |

Each settlement level allows one additional structure slot, up to 10. The
current structure catalogue has eight distinct options; duplicate structures
are not allowed. All resource buildings can be built on any settlement.

| Structure | Production | Build cost |
| --- | ---: | --- |
| Settlement Forge | — | 12 wood + 2 iron |
| Resource Mint | — | 12 wood + 2 iron |
| Woodcutter Camp | 15 wood/hour | 10 wood |
| Iron Mine | 8 iron/hour | 12 wood |
| Tin Mine | 7 tin/hour | 12 wood |
| Copper Mine | 6 copper/hour | 12 wood |
| Silver Mine | 3.5 silver/hour | 16 wood + 2 iron |
| Gold Mine | 2 gold/hour | 20 wood + 4 iron |

The listed hourly rates are multiplied by settlement level (and structure
level). The free 5 wood/hour is additional and does not scale. Legacy deposit
values are retained in saved data but no longer limit production. Production
ticks while the server is running; offline time is not accrued. The starting
stockpile includes 24 wood and 6 iron. Bronze equipment consumes
tin and copper; iron equipment consumes iron. Production rates are game values,
not real-world extraction rates. Resource assets use 1,000 chain units per
resource unit; coin and bar assets retain their fine-gram representation.
Existing silver assets and newly minted silver resource units can both pay army
payroll.

**Production limitation:** The mint queue and plot state are persisted
separately, and submitted transactions can be retried or refunded after an
ambiguous chain outcome. Crash-safe, exactly-once minting and reconciliation
have not been established. Do not use resource or metal minting with real
funds until these issues are resolved and live chain behavior is validated.
Resource and metal minting is disabled on mainnet for this reason; simulation
and live testnet remain available.

## Requirements

- Node.js **22.5 or later** (see `package.json`).
- npm.
- For live chain transactions: a synchronized Numista daemon on the configured network with the
  required asset RPCs and an accessible, authenticated wallet RPC.
- For local simulation: no external Numista node is required.

## Run locally

1. Install dependencies and create a local environment file:

   ```sh
   npm ci
   cp .env.example .env
   ```

2. Edit `.env` and set:

   ```dotenv
   NUMISTA_CHAIN_MODE=simulate
   NUMISTA_SESSION_SECRET=replace-with-a-long-random-secret
   ```

   Production startup requires `NUMISTA_SESSION_SECRET`; use a unique random
   value and keep it private. Admin vault wallet login also has no built-in
   password: set `NUMISTA_ADMIN_PASSWORD` explicitly if using that login path.

   Keep `.env`, wallet login files, wallet credentials, and private keys out of
   source control. `.env` is ignored by Git.

3. Start the backend and frontend in separate terminals:

   ```sh
   npm run server
   ```

   ```sh
   npm run dev
   ```

4. Open <http://localhost:5173>. Vite proxies `/api` requests to the backend on
   port 3001. The backend also serves the built frontend from `dist/` when
   available.

On Windows, `launch.bat` / `run-game.ps1` start both services. They use the
project-local `.env` settings loaded by the backend. The full-game and
server-only Windows launchers build the frontend before starting the backend,
so port 3001 does not serve an old `dist/` after a source update. For other
launch methods, run `npm run build` after updating the source and before
starting or restarting the server.

Deploy the current source, including `public/assets`, to the machine behind a
funnel before building there; a build in another checkout does not update that
machine. Verify `/assets/building-atlas.png` returns an image, not the app's
HTML, and check that the funnel and local server serve the expected build.
Existing services may need to be restarted; do not reset game or chain data.

### Chain modes

Set `NUMISTA_CHAIN_MODE` before starting the backend:

| Mode | Behavior |
| --- | --- |
| `simulate` | Uses a local simulated chain and confirmation queue. Intended for development and tests; it does not create real Numista transactions. |
| `live` | Requires a compatible Numista daemon and wallet RPC on the configured network. If the required services or asset methods are unavailable, chain operations remain disabled. |
| `auto` | Probes the live services and uses them only when ready; otherwise chain operations remain disabled. It does not silently switch to simulation. |
| `off` | Disables chain operations. |

The default chain mode is `live` and the default network is `mainnet`.
Mainnet requires explicit private daemon and wallet RPC URLs, issuer identity
and wallet, treasury username and address, and NUM currency asset ID. The
daemon must report mainnet and confirm synchronization, and the configured NUM
asset must match the expected metadata. Missing or mismatched settings leave
chain operations disabled. Set `NUMISTA_NETWORK=testnet` explicitly for a
separate testnet deployment.

Keep both RPCs on loopback or another private, access-controlled network. Do not
expose wallet RPC or unrestricted daemon RPC to the public internet.

See [gamedev.md](./gamedev.md) for historical testnet node and wallet setup and
RPC details. Its testnet scripts and ports are not mainnet configuration.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependencies |
| `npm run dev` | Start the Vite development frontend on port 5173 |
| `npm run server` | Start the Express API server (default port 3001) |
| `npm run build` | Create the production frontend in `dist/` |
| `npm start` | Start the Express server |
| `npm run test:simulated-e2e` | Run the simulated signup-to-conquest and regression suite |

There is no `npm test` script configured. The integration suite starts its own
test server and exercises claims, upgrades through level 10, resources,
owner-issued metal assets, equipment, army actions, and transaction rollback.

## Configuration

The server loads an optional project-root `.env` before reading its settings.
Process environment variables take precedence. `.env.example` contains
additional node, wallet, and mining settings.

| Variable | Purpose |
| --- | --- |
| `PORT` | Express server port (default `3001`) |
| `NUMISTA_CHAIN_MODE` | `live`, `simulate`, `auto`, or `off` |
| `NUMISTA_NETWORK` | `mainnet` (default) or `testnet` |
| `NUMISTA_METADATA_DIR` | Optional directory for immutable deed and asset metadata |
| `NUMISTA_CONFIRMATIONS` | Confirmations required before queued operations settle (default `10`) |
| `NUMISTA_DAEMON_RPC` | Private daemon RPC URL (required for mainnet) |
| `NUMISTA_WALLET_RPC` | Private wallet RPC URL (required for mainnet) |
| `NUMISTA_WALLET_LOGIN_FILE` | Path to the wallet RPC login file |
| `NUMISTA_RPC_USER`, `NUMISTA_RPC_PASS` | Wallet RPC credentials, when not using a login file |
| `NUMISTA_ISSUER_PUBLIC_KEY` | Public key configured for the asset issuer |
| `NUMISTA_ISSUER_WALLET`, `NUMISTA_ISSUER_WALLET_PASSWORD` | Issuer wallet configuration; keep passwords private |
| `NUMISTA_TREASURY_USER`, `NUMISTA_TREASURY_ADDRESS` | Mainnet treasury username and native address |
| `NUMISTA_CURRENCY_ASSET_ID` | Verified mainnet NUM currency asset ID |
| `NUMISTA_SESSION_SECRET` | Secret used to sign game session tokens; set a unique random value |
| `NUMISTA_ADMIN_PASSWORD` | Optional password override for admin vault wallet login; no default is provided |
| `NUMISTA_ADMINS` | Comma-separated game administrator usernames |
| `NUMISTA_DATABASE_FILE` | SQLite game-state database location |
| `NUMISTA_STATE_FILE` | JSON game-state persistence location |
| `NUMISTA_USERS_FILE` | Game account data location |
| `NUMISTA_LEDGER_FILE` | Game ledger persistence location |
| `NUMISTA_QUEUE_FILE` | Persistent chain transaction queue location |
| `NUMISTA_SIM_FILE` | Simulated-chain state location |
| `NUMISTA_SIM_BLOCK_MS` | Simulated block interval in milliseconds |

Do not commit production secrets or wallet files. Set a private session secret
and use authenticated RPC endpoints for any shared deployment.

The external blockchain E2E script is intentionally opt-in because it changes
wallet labels and submits transactions. Run it only against a controlled test
environment with explicit `BASE_URL`, `TEST_PW`, and `NUMISTA_ADMIN_PASSWORD`
environment variables.

## Project layout

```text
src/
  components/       React screens and modal interfaces
  context/          Shared application and API state
  data/             Frontend map data
  workers/          Browser RandomX mining worker
server/
  data/             Plot registry, game state, accounts, and ledger
  mining/           Mining and Stratum services
  numista/          Numista RPC adapter, simulated chain, and transaction queue
  payment/          Onramp quote calculator
  index.js          Express routes and server startup
scripts/            External/deployment test helpers
deploy/             Service and reverse-proxy templates
```

The backend persists game state in SQLite when available and also writes JSON
state files for compatibility. Accounts, transaction queues, ledgers, chain
state, and deed metadata are stored separately under `server/data/` by default.
Back up the relevant data files before moving or replacing a deployment.
The Worldtycoon rebrand preserves existing browser-storage keys, wallet
accounts, and on-chain metadata schema identifiers so existing sessions and
assets remain compatible.

## API overview

The frontend uses the Express API under `/api`. Main route groups include:

- `/api/auth/*`, `/api/account/*`, `/api/wallet/*`
- `/api/plots`, `/api/plots/:id/*`, `/api/deeds/*`, `/api/assets/*`
- `/api/army/*`, `/api/soldiers/*`, `/api/castles/*`, `/api/battles/*`
- `/api/bank/*`, `/api/auctions/*`, `/api/stocks/*`, `/api/mints/*`
- `/api/mining/*`, `/api/explorer/*`, `/api/network/*`

Authenticated game actions use a bearer token. Chain-backed actions return a
job that remains pending until it confirms or reverts. The API route
definitions in [server/index.js](./server/index.js) are the source of truth for
request and response details.

## Current limitations

- GBP card checkout uses Stripe Checkout when explicitly enabled in the private
  server environment. Stripe webhook signatures are verified before any NUM
  delivery; the client cannot mark an order paid. Checkout and NUM delivery are
  disabled by default. Live mode additionally requires an explicit mainnet
  readiness flag and live chain connection. Native wallet delivery has
  non-automatic reconciliation for uncertain transfers; review the operational
  requirements in [MINING_LIMITATIONS.md](./MINING_LIMITATIONS.md) before
  enabling real payments. Crypto swaps are not implemented.
- Live chain features require a compatible Numista node and wallet
  build. The simulator is not a production blockchain.
- `deploy/setup-vps.sh` and deployment templates are starting points, not a
  verified turnkey production deployment. Check the Node.js version and review
  all service, firewall, RPC, and secret settings before use.
- Tile-map providers require network access; map tiles are not bundled with the
  application.

## Deployment and operations

Build the frontend before starting the production server:

```sh
npm ci
npm run build
NUMISTA_CHAIN_MODE=live npm start
```

On Oracle, set `NUMISTA_NETWORK=mainnet`, `PORT`, and all live RPC/wallet
settings through the service manager. A public web endpoint is not a reason to
expose daemon or wallet RPCs. Before switching an existing installation, back
up its state and reconcile all queued transactions against the intended chain;
the queue and game state are not automatically migrated or isolated by network.
Do not replay testnet or simulated jobs on mainnet.

Place
the app behind HTTPS and a reverse proxy, keep daemon and wallet RPC private,
and provision persistent storage for `server/data/`. The `deploy/` directory
contains Nginx and systemd examples; adapt them to the host before enabling
services. The VPS helper currently needs review against the Node.js engine
requirement above.
