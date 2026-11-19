export const CONFIG = {
  PORT: process.env.PORT || 3001,
  NUMISTA: {
    NAME: "Numista Coin",
    TICKER: "NUM",
    DECIMALS: 12, // Atomic units like Monero piconero (1 NUM = 10^12 atomic units)
    BLOCK_TIME_SECS: 120,
    DAEMON_RPC_URL: process.env.NUMISTA_DAEMON_RPC || "http://127.0.0.1:48081",
    // 48082 is the daemon ZMQ port on Numista testnet, NOT wallet RPC.
    // Wallet RPC uses an operator-chosen port (48083 by default).
    WALLET_RPC_URL: process.env.NUMISTA_WALLET_RPC || "http://127.0.0.1:48083",
    // Numista testnet address prefix is 94 (addresses begin with "S").
    // Do not hardcode foreign addresses here; wallets are created on the node.
    RPC_USER: process.env.NUMISTA_RPC_USER || "",
    RPC_PASS: process.env.NUMISTA_RPC_PASS || "",
    NETTYPE: "numista-testnet"
  },

  // UK land grid: 50 columns x 70 rows = 3,500 square plots
  GRID: {
    COLS: Number(process.env.NUMISTA_GRID_COLS || 50),
    ROWS: Number(process.env.NUMISTA_GRID_ROWS || 70),
    SEED: Number(process.env.NUMISTA_GRID_SEED || 20261119),
    VERSION: "uk-numista-2026-11-v2",
    MIN_LAT: 49.9,
    MAX_LAT: 59.0,
    CENTER_LNG: -2.5
  },

  /**
   * On-chain deed / currency layer.
   *
   * MODE:
   *   auto     – use the live Numista node when it exposes the asset RPC and
   *              signing wallet; otherwise remain off.
   *   live     – require the real node (remain off if unavailable).
   *   simulate – deterministic local chain used only for development/testing.
   *   off      – disable minting entirely.
   */
  CHAIN: {
    MODE: (process.env.NUMISTA_CHAIN_MODE || "live").toLowerCase(),
    CONFIRMATIONS: Number(process.env.NUMISTA_CONFIRMATIONS || 10),
    POLL_MS: Number(process.env.NUMISTA_QUEUE_POLL_MS || 3000),
    TX_TIMEOUT_MS: Number(process.env.NUMISTA_TX_TIMEOUT_MS || 45 * 60 * 1000),
    RECONCILE_MS: Number(process.env.NUMISTA_RECONCILE_MS || 60000),
    REORG_WINDOW_BLOCKS: Number(process.env.NUMISTA_REORG_WINDOW || 20),
    // 1 NUM = 1,000 integer asset units (milli-NUM). Asset quantities are
    // integers on Numista, so all on-chain amounts use this base unit.
    UNITS_PER_NUM: 1000,
    // 1 trillion NUM expressed in asset units (1e15, below 2^53).
    MAX_SUPPLY_UNITS: 1_000_000_000_000 * 1000,
    CURRENCY_ASSET_ID: process.env.NUMISTA_CURRENCY_ASSET_ID || "",
    ISSUER_PUBLIC_KEY: process.env.NUMISTA_ISSUER_PUBLIC_KEY || "",
    ISSUER_WALLET_FILE: process.env.NUMISTA_ISSUER_WALLET || "townforge_issuer",
    TREASURY_USERNAME: process.env.NUMISTA_TREASURY_USER || "crown_treasury"
  },

  SIM: {
    // Simulated block time. Faster than the 120s real target so the 10-block
    // confirmation flow is usable while the upgraded chain is being built.
    BLOCK_MS: Number(process.env.NUMISTA_SIM_BLOCK_MS || 2000),
    FILE: process.env.NUMISTA_SIM_FILE || "",
    GENESIS_BALANCES: {
      danie: Number(process.env.NUMISTA_SIM_DANIE || 150),
      mercantile: Number(process.env.NUMISTA_SIM_MERCANTILE || 250)
    }
  },

  ECONOMY: {
    PLOT_CLAIM_PRICE_NUM: 50, // Base price = rarity tier 1 (Common)
    TAX_RATE_TOWN_HALL: 0.035, // 3.5%
    BANK_BASE_APY: 0.092, // 9.2%
    MINING_SHARE_REWARD: 0.05, // NUM rewarded per accepted share
    MINING_PAYOUT_THRESHOLD: 1, // mining rewards settle on-chain once they reach 1 NUM
    MINING_DIFFICULTY: 16017, // Matches user's live daemon difficulty
    EXCHANGE_RATE_GBP: 0.45,
    EXCHANGE_RATE_XMR: 0.0035,
    EXCHANGE_RATE_USDT: 0.58,

    // Property economy
    INCOME_PAYBACK_HOURS: 240, // price / 240 = base income per hour
    INCOME_ACCRUAL_CAP_HOURS: 24, // uncollected income caps at 24h
    UPGRADE_MAX_LEVEL: 5,
    UPGRADE_COST_RATE: 0.4, // cost per level = 40% of plot price * current level
    UPGRADE_INCOME_STEP: 1.5, // income multiplier per level
    MINT_FEE_PER_GRAM: {
      gold: 1.25,
      silver: 0.08
    }
  },

  BUILDING_TYPES: {
    TOWN_HALL: 'town_hall',
    BANK: 'bank',
    AUCTION_HOUSE: 'auction_house',
    STOCK_BROKER: 'stock_broker',
    OPEN_LOT: 'open_lot'
  },

  ADMIN_USERS: (process.env.NUMISTA_ADMINS || 'danie')
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean)
};
