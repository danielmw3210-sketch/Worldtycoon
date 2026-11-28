import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load an ignored project-local .env before reading CONFIG. Existing process
// environment values always take precedence (for deployment/service managers).
function loadLocalEnvFile() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}

loadLocalEnvFile();

const NUMISTA_NETWORK = String(process.env.NUMISTA_NETWORK || 'mainnet').trim().toLowerCase();
if (!['mainnet', 'testnet'].includes(NUMISTA_NETWORK)) {
  throw new Error('NUMISTA_NETWORK must be either "mainnet" or "testnet"');
}
const IS_MAINNET = NUMISTA_NETWORK === 'mainnet';

export const CONFIG = {
  PORT: process.env.PORT || 3001,
  NUMISTA: {
    NAME: "Numista Coin",
    TICKER: "NUM",
    DECIMALS: 12, // Atomic units like Monero piconero (1 NUM = 10^12 atomic units)
    GAME_FUND_BLOCK_REWARD_NUM: Number(process.env.NUMISTA_BLOCK_REWARD || 0.00005),
    BLOCK_TIME_SECS: 120,
    DAEMON_RPC_URL: process.env.NUMISTA_DAEMON_RPC || (IS_MAINNET ? "" : "http://127.0.0.1:48081"),
    // 48082 is the daemon ZMQ port on Numista testnet, NOT wallet RPC.
    // Wallet RPC uses an operator-chosen port (48083 by default).
    WALLET_RPC_URL: process.env.NUMISTA_WALLET_RPC || (IS_MAINNET ? "" : "http://127.0.0.1:48083"),
    WALLET_RPC_LOGIN_FILE: process.env.NUMISTA_WALLET_LOGIN_FILE || "",
    // Numista testnet address prefix is 153 (addresses begin with "S").
    // Do not hardcode foreign addresses here; wallets are created on the node.
    RPC_USER: process.env.NUMISTA_RPC_USER || "",
    RPC_PASS: process.env.NUMISTA_RPC_PASS || "",
    CROWN_ESTATE_WALLET_RPC_URL: process.env.NUMISTA_CROWN_ESTATE_WALLET_RPC || "",
    CROWN_ESTATE_WALLET_RPC_USER: process.env.NUMISTA_CROWN_ESTATE_WALLET_RPC_USER || "",
    CROWN_ESTATE_WALLET_RPC_PASS: process.env.NUMISTA_CROWN_ESTATE_WALLET_RPC_PASS || "",
    NETTYPE: IS_MAINNET ? 'numista-mainnet' : 'numista-testnet'
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
    // Blocks may stall for hours while a transaction remains valid.
    // Keep the reservation alive long enough to avoid declaring a later-mined
    // payment failed; operators can still tune this through the environment.
    TX_TIMEOUT_MS: Number(process.env.NUMISTA_TX_TIMEOUT_MS) || 86_400_000,
    RECONCILE_MS: Number(process.env.NUMISTA_RECONCILE_MS || 60000),
    REORG_WINDOW_BLOCKS: Number(process.env.NUMISTA_REORG_WINDOW || 20),
    // 1 NUM = 1,000 integer asset units (milli-NUM). Asset quantities are
    // integers on Numista, so all on-chain amounts use this base unit.
    UNITS_PER_NUM: 1000,
    // 1 trillion NUM expressed in asset units (1e15, below 2^53).
    MAX_SUPPLY_UNITS: 1_000_000_000_000 * 1000,
    CURRENCY_ASSET_ID: process.env.NUMISTA_CURRENCY_ASSET_ID || "",
    ISSUER_PUBLIC_KEY: process.env.NUMISTA_ISSUER_PUBLIC_KEY || (IS_MAINNET ? "" : "3f50a0c86240ef57be837c5c3e6ca4f669db3b13e7954700337b0613bdd08b04"),
    ISSUER_WALLET_FILE: process.env.NUMISTA_ISSUER_WALLET || (IS_MAINNET ? "" : "goldnumista"),
    ISSUER_WALLET_PASSWORD: process.env.NUMISTA_ISSUER_WALLET_PASSWORD || "",
    // Native coin address that receives block rewards and backs the game
    // treasury. From the node's miner wallet document.
    TREASURY_ADDRESS: process.env.NUMISTA_TREASURY_ADDRESS ||
      (IS_MAINNET ? "" : "SbMqyiLDAv6QtTCX1n1JJnLuZL7j3RxKKcdvdTA1F15HeygxXzf982K2CdYGNc7J9pL9ZX71E8byHLFuhSH6TDBx1pNJ46GYn"),
    TREASURY_USERNAME: process.env.NUMISTA_TREASURY_USER || (IS_MAINNET ? "" : "crown_treasury")
  },

  SIM: {
    // Simulated block time. Faster than the 120s real target so the 10-block
    // confirmation flow is usable while the upgraded chain is being built.
    BLOCK_MS: Number(process.env.NUMISTA_SIM_BLOCK_MS || 2000),
    FILE: process.env.NUMISTA_SIM_FILE || "",
    GENESIS_BALANCES: {
      danie: Number(process.env.NUMISTA_SIM_DANIE || 150),
      mercantile: Number(process.env.NUMISTA_SIM_MERCANTILE || 250),
      crown_treasury: Number(process.env.NUMISTA_SIM_TREASURY || 0)
    }
  },

  ECONOMY: {
    LAUNCH_REFERENCE_GBP_PER_NUM: Number(process.env.NUMISTA_LAUNCH_REFERENCE_GBP_PER_NUM || 0.25),
    PLOT_CLAIM_PRICE_NUM: 50, // Base price = rarity tier 1 (Common)
    TAX_RATE_TOWN_HALL: 0.035,
    SECONDARY_MARKET_TAX_RATE: 0.05,
    TRANSFER_NETWORK_FEE_NUM: 0.05, // 3.5%
    BANK_BASE_APY: 0.092, // 9.2%
    TREASURY_BLOCK_REWARD_NUM: Number(process.env.NUMISTA_TREASURY_BLOCK_REWARD || 0.25),
    MINING_SCHEME: process.env.NUMISTA_MINING_SCHEME || 'PPLNS', // 'PPLNS' or 'PPS'
    PPLNS_WINDOW_SIZE: Number(process.env.NUMISTA_PPLNS_WINDOW || 1000),
    MINING_ROUND_REWARD: Number(process.env.NUMISTA_MINING_ROUND_REWARD || 50),
    MINING_POOL_FEE_RATE: Number(process.env.NUMISTA_MINING_POOL_FEE || 0.02),
    MINING_SHARE_REWARD: 0.05, // NUM rewarded per accepted share (fallback under PPS)
    MINING_PAYOUT_THRESHOLD: 0.25, // mining rewards settle on-chain once they reach 1 NUM
    MINING_DIFFICULTY: 16017, // Matches user's live daemon difficulty
    EXCHANGE_RATE_GBP: 0.025,
    EXCHANGE_RATE_XMR: 0.0035,
    EXCHANGE_RATE_USDT: 0.58,

    // Property economy
    INCOME_PAYBACK_HOURS: 1440, // price / 240 = base income per hour
    INCOME_ACCRUAL_CAP_HOURS: 24, // uncollected income caps at 24h
    UPGRADE_MAX_LEVEL: 10,
    UPGRADE_COST_RATE: 0.4, // cost per level = 40% of plot price * current level
    UPGRADE_INCOME_STEP: 1.25, // income multiplier per level
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
