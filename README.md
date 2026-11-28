# Worldtycoon

Worldtycoon is an experimental UK land, settlement, and strategy game with a
React/Vite frontend and an Express backend. It is designed to integrate with
the Numista testnet asset and wallet RPCs.

> **Experimental software:** Numista testnet balances, deeds, and assets have
> no production or monetary value. The project is not a payment processor or
> financial service. Do not use real funds or expose private RPC services to
> the public internet.

## What is implemented

- **UK land map:** A deterministic, seeded registry of 3,500 plots by default
  (50 columns × 70 rows). Plot rarity, prices, labels, and resource deposits
  are generated from the configured grid seed. Hand-authored landmarks are
  pinned to the map.
- **Land and settlement progression:** Claim a plot, develop its Peasant Lodge
  through level 10, and collect accrued property income. Level 5 becomes a
  Motte-and-Bailey; level 10 becomes a player-owned Castle Keep.
- **Plot resources:** Build a Woodcutter Camp for renewable wood or mines for
  finite iron, tin, copper, silver, and gold deposits. Production and stockpiles
  belong to the plot.
- **Forge and armies:** Build a Settlement Forge, craft bronze and iron weapons
  or armor, equip soldiers, recruit troops, form armies, and march or siege.
  Army marches and attacks use a distance-based silver payroll.
- **Game artwork:** Claimed settlements appear on the map from zoom level 6;
  zoom in to see additional buildings. Settlement, resource, troop, equipment,
  and metal artwork also appears in their respective panels. Artwork is bundled
  locally in `public/assets` and is included in production builds.
- **Owner-issued metal assets:** Owners can submit stored silver or gold as
  fungible Numista assets in coin or bar form. The plot stock is reserved for
  the transaction and restored if it reverts.
- **Other game systems:** Peerage, castles, town-hall taxes, banking, stocks,
  auctions, coin collections, account/deed views, and blockchain explorers.
- **Mining:** A RandomX worker can connect to a configured Stratum endpoint;
  the interface also provides a solo-mining command. Mining requires a usable
  Numista node/pool and wallet address. The built-in pool and legacy local
  share API are disabled because their share verification and payout
  accounting are not production-ready; use a trusted external pool instead.
- **Chain modes:** Use a local simulated chain for development, or connect a
  compatible Numista testnet daemon and wallet RPC for live testnet operations.

### Settlement progression and buildings

| Settlement level | Milestone |
| ---: | --- |
| 1–4 | Peasant Lodge settlement |
| 5–9 | Motte-and-Bailey |
| 10 | Castle Keep (1,000 maximum integrity) |

Each settlement level allows one additional structure slot, up to 10. The
current structure catalogue has seven distinct options; duplicate structures
are not allowed, and a mine can only be built where the plot has that deposit.

| Structure | Production | Build cost |
| --- | ---: | --- |
| Settlement Forge | — | 12 wood + 2 iron |
| Woodcutter Camp | 15 wood/hour | 10 wood |
| Iron Mine | 8 iron/hour | 12 wood |
| Tin Mine | 7 tin/hour | 12 wood |
| Copper Mine | 6 copper/hour | 12 wood |
| Silver Mine | 3.5 silver/hour | 16 wood + 2 iron |
| Gold Mine | 2 gold/hour | 20 wood + 4 iron |

The starting stockpile includes 24 wood and 6 iron. Bronze equipment consumes
tin and copper; iron equipment consumes iron. Production rates are game values,
not real-world extraction rates.

## Requirements

- Node.js **22.5 or later** (see `package.json`).
- npm.
- For live chain transactions: a synchronized Numista testnet daemon with the
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
| `live` | Requires a compatible Numista testnet daemon and wallet RPC. If the required services or asset methods are unavailable, chain operations remain disabled. |
| `auto` | Probes the live services and uses them only when ready; otherwise chain operations remain disabled. It does not silently switch to simulation. |
| `off` | Disables chain operations. |

The default is `live`. For testnet operation, configure the daemon and wallet
RPC URLs and credentials in `.env`; keep both RPCs bound to loopback or another
private, access-controlled network. Do not expose wallet RPC or unrestricted
daemon RPC to the public internet.

See [gamedev.md](./gamedev.md) for Numista testnet ports, local node and wallet
setup, RPC details, and Windows scripts.

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
| `NUMISTA_CONFIRMATIONS` | Confirmations required before queued operations settle (default `10`) |
| `NUMISTA_DAEMON_RPC` | Numista daemon RPC URL (default `http://127.0.0.1:48081`) |
| `NUMISTA_WALLET_RPC` | Numista wallet RPC URL (default `http://127.0.0.1:48083`) |
| `NUMISTA_WALLET_LOGIN_FILE` | Path to the wallet RPC login file |
| `NUMISTA_RPC_USER`, `NUMISTA_RPC_PASS` | Wallet RPC credentials, when not using a login file |
| `NUMISTA_ISSUER_PUBLIC_KEY` | Public key configured for the asset issuer |
| `NUMISTA_ISSUER_WALLET`, `NUMISTA_ISSUER_WALLET_PASSWORD` | Issuer wallet configuration; keep passwords private |
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
- Live chain features require a compatible Numista testnet node and wallet
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

Set `PORT` and all live RPC/wallet settings through the service manager. Place
the app behind HTTPS and a reverse proxy, keep daemon and wallet RPC private,
and provision persistent storage for `server/data/`. The `deploy/` directory
contains Nginx and systemd examples; adapt them to the host before enabling
services. The VPS helper currently needs review against the Node.js engine
requirement above.
