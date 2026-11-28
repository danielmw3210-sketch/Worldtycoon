import { deriveDeterministicCoinEra } from '../numista/chainIndexer.js';
import { randomUUID } from 'crypto';
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* JSON persistence remains available on older Node runtimes. */ }
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateGridPlots,
  generateResourceDeposits,
  rarityByTier,
  baseIncomeForPrice,
  incomePerHourFor,
  upgradeCostFor
} from './plotGrid.js';
import { CONFIG } from '../config.js';
import { mintQueue } from '../numista/mintQueue.js';
import { chainAdapter } from '../numista/chainAdapter.js';
import { chainLedger } from './chainLedger.js';
import { userManager } from './users.js';
import {
  NUM_ASSET_ID,
  CURRENCY_ASSET_TYPE,
  DEED_ASSET_TYPE,
  DEED_SCHEMA,
  deedAssetId,
  deedMetadata,
  metadataHash,
  assetSprite,
  sha256Hex,
  saveDeedMetadata,
  readDeedMetadata,
  METADATA_DIR,
  toUnits,
  fromUnits
} from './deedRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TREASURY = CONFIG.CHAIN.TREASURY_USERNAME;
const REQUIRED_CONFIRMATIONS = CONFIG.CHAIN.CONFIRMATIONS;
const FAILED_JOB_STATUSES = new Set(['reverted', 'failed', 'revert_failed']);

function round(n, places = 6) {
  return +(Number(n) || 0).toFixed(places);
}

const ARMY_SILVER_PER_TILE_PER_SOLDIER = 0.01;
const PLOT_RESOURCES = ['wood', 'iron', 'tin', 'copper', 'silver', 'gold'];

function itemIsUsable(item) {
  return !!item && (item.health === undefined || Number(item.health) > 0);
}

function gearStat(item, stat) {
  return itemIsUsable(item) ? Number(item?.[stat] || 0) : 0;
}

function equippedHpBonus(soldier) {
  return ['armor', 'helmet'].reduce((sum, slot) => {
    const item = soldier?.[slot];
    return sum + (itemIsUsable(item) ? Number(item.hpBonus || 0) : 0);
  }, 0);
}

function refreshSoldierMaxHp(soldier) {
  const baseMaxHp = Number(soldier.baseMaxHp) ||
    Math.max(1, Number(soldier.maxHp || 1) - equippedHpBonus(soldier));
  soldier.baseMaxHp = baseMaxHp;
  const previousMax = Math.max(1, Number(soldier.maxHp || baseMaxHp));
  const healthRatio = Math.max(0, Math.min(1, Number(soldier.hp || 0) / previousMax));
  soldier.maxHp = baseMaxHp + equippedHpBonus(soldier);
  soldier.hp = Math.min(soldier.maxHp, Math.round(soldier.maxHp * healthRatio));
}

class GameStore {
  constructor() {
    this.plots = generateGridPlots();
    this.plots.forEach(plot => { plot.maxHealth = plot.isCastle ? 1000 : 100; plot.health = plot.maxHealth; plot.fortificationLevel ||= 0; });
    this.mintLedger = [];
    this.statePath = process.env.NUMISTA_STATE_FILE || path.join(__dirname, 'gameState.json');
    this.databasePath = process.env.NUMISTA_DATABASE_FILE || path.join(__dirname, 'gameState.sqlite');
    this.gameDb = null;
    if (DatabaseSync) {
      try {
        this.gameDb = new DatabaseSync(this.databasePath);
        this.gameDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS battle_events (asset_id TEXT PRIMARY KEY, report_json TEXT NOT NULL, tx_hash TEXT NOT NULL, block_height INTEGER NOT NULL, created_at TEXT NOT NULL); INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, CURRENT_TIMESTAMP);');
      } catch (err) { console.warn('[store] SQLite unavailable; using JSON persistence:', err.message); this.gameDb = null; }
    }
    this.seasonStartedAt = null;
    this._saveTimer = null;
    this.pendingMining = new Map();
    this.pendingUsernameRegistrations = new Set();
    this._deedReconcileAt = 0;
    this._deedReconcilePromise = null;
    this.playerTitles = {};
    this.playerArmies = {};
    this.playerSoldiers = {};
    this.playerCoinPurses = {};
    this.playerEquipment = {};
    this.battleLog = [];
    this.pendingArmyPayments = new Set();
    this.nativeDepositRetries = new Set();
    this._lastResourceSaveAt = 0;

    // Default Auction House Listings
    this.auctions = [
      {
        id: "auc-001",
        title: "Highland Lithium & Granite Mineral Rights",
        plotId: "UK-HIG-001",
        seller: "scots_pioneer",
        currentBid: 0,
        highestBidder: null,
        buyoutPrice: 250.00,
        endsAt: new Date(Date.now() + 86400000 * 2).toISOString(),
        bidsCount: 0,
        category: "Mineral Rights"
      },
      {
        id: "auc-002",
        title: "Ancient Cornish Tin & Silver Smelting Relic NFT",
        plotId: "UK-COR-001",
        seller: "bristol_syndicate",
        currentBid: 0,
        highestBidder: null,
        buyoutPrice: 190.00,
        endsAt: new Date(Date.now() + 86400000 * 1.5).toISOString(),
        bidsCount: 0,
        category: "Historic Relic"
      },
      {
        id: "auc-003",
        title: "Radcliffe Architectural Master Blueprint #04",
        plotId: "UK-OXF-001",
        seller: "crown_treasury",
        currentBid: 0,
        highestBidder: null,
        buyoutPrice: 110.00,
        endsAt: new Date(Date.now() + 86400000 * 3).toISOString(),
        bidsCount: 0,
        category: "Building Blueprint"
      }
    ];

    // Default Stock Market Equities
    this.stocks = [
      {
        ticker: "UK-REIT",
        name: "UK Crown Land & Property Trust",
        price: 14.85,
        change24h: +4.2,
        dividendYield: 7.8,
        marketCap: 489000,
        volume: 34100,
        history: [13.2, 13.8, 14.1, 13.9, 14.5, 14.85]
      },
      {
        ticker: "NUM-MINE",
        name: "Numista Sovereign Mining Guild",
        price: 28.40,
        change24h: +8.5,
        dividendYield: 9.4,
        marketCap: 920000,
        volume: 81200,
        history: [24.0, 25.1, 26.3, 25.8, 27.2, 28.40]
      },
      {
        ticker: "TH-CORP",
        name: "Thames & Clyde Shipping Cartel",
        price: 8.65,
        change24h: -1.2,
        dividendYield: 6.2,
        marketCap: 215000,
        volume: 18400,
        history: [9.1, 8.9, 8.8, 8.7, 8.8, 8.65]
      },
      {
        ticker: "BNK-LOMB",
        name: "Lombard & Royal Vaults Depository",
        price: 42.10,
        change24h: +2.9,
        dividendYield: 8.9,
        marketCap: 1450000,
        volume: 95400,
        history: [39.5, 40.2, 40.8, 41.3, 41.5, 42.10]
      }
    ];

    this.userBanks = {};
    this.userStocks = {};

    mintQueue.load();
    mintQueue.setHandlers({
      onConfirmed: job => this._onJobConfirmed(job),
      onReverted: job => this._onJobReverted(job)
    });

    this.loadState();
    this._recoverJobs();

    setInterval(() => this.tickSimulation(), 15000);
    const reconcileTimer = setInterval(() => {
      chainLedger.reconcile().catch(() => {});
    }, CONFIG.CHAIN.RECONCILE_MS);
    if (reconcileTimer.unref) reconcileTimer.unref();
  }

  /* ------------------------------------------------------------------ */
  /* Persistence (claims / levels / accrued income survive restarts)    */
  /* ------------------------------------------------------------------ */

  loadState() {
    try {
      let raw = null;
      if (this.gameDb) {
        const row = this.gameDb.prepare('SELECT payload FROM game_state WHERE id = 1').get();
        if (row?.payload) raw = JSON.parse(row.payload);
      }
      if (!raw && fs.existsSync(this.statePath)) raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (!raw) return;
      // Begin the new game progression cleanly while retaining chain balances
      // and deeds, which are restored by the chain-backed systems.
      if (raw.gameVersion !== 3) {
        console.log('[store] Starting fresh game progression (version 3)');
        return;
      }
      this.seasonStartedAt = raw.seasonStartedAt || raw.savedAt || new Date().toISOString();
      if (Array.isArray(raw.mints)) this.mintLedger = raw.mints;
      if (raw.userBanks && typeof raw.userBanks === 'object') this.userBanks = raw.userBanks;
      if (raw.userStocks && typeof raw.userStocks === 'object') this.userStocks = raw.userStocks;
      if (raw.playerTitles && typeof raw.playerTitles === 'object') this.playerTitles = raw.playerTitles;
      if (raw.playerArmies && typeof raw.playerArmies === 'object') this.playerArmies = raw.playerArmies;
      Object.entries(this.playerArmies).forEach(([owner, formations]) => { if (!Array.isArray(formations)) this.playerArmies[owner] = []; });
      if (raw.playerSoldiers && typeof raw.playerSoldiers === 'object') this.playerSoldiers = raw.playerSoldiers;
      if (raw.playerCoinPurses && typeof raw.playerCoinPurses === 'object') this.playerCoinPurses = raw.playerCoinPurses;
      if (raw.playerEquipment && typeof raw.playerEquipment === 'object') this.playerEquipment = raw.playerEquipment;
      if (Array.isArray(raw.battleLog)) this.battleLog = raw.battleLog;
      if (Array.isArray(raw.auctions)) this.auctions = raw.auctions;

      const byId = new Map(this.plots.map(p => [p.id, p]));
      let restored = 0;
      (raw.plots || []).forEach(saved => {
        const plot = byId.get(saved.id);
        if (!plot) return;
        plot.isClaimed = !!saved.isClaimed;
        plot.owner = saved.owner || null;
        plot.isCastle = !!saved.isCastle;
        plot.castleOwner = saved.castleOwner || null;
        plot.controller = saved.controller || plot.castleOwner || null;
        plot.garrison = Number(saved.garrison) || 0;
        plot.health = Number(saved.health) || (saved.isCastle ? 1000 : 100);
        plot.maxHealth = Number(saved.maxHealth) || plot.health;
        plot.fortificationLevel = Number(saved.fortificationLevel) || 0;
        plot.siege = saved.siege || null;
        plot.marketListing = saved.marketListing || null;
        plot.marketSaleJobId = saved.marketSaleJobId || null;
        if (saved.building) {
          plot.building = saved.building;
          if (plot.building.type === 'town_hall' && plot.building.stats) {
            plot.building.stats.treasuryBalance = 0;
            plot.building.stats.totalTaxesCollected = 0;
          }
        }
        plot.stockpile = saved.stockpile || plot.stockpile;
        plot.resourceDeposits = saved.resourceDeposits || plot.resourceDeposits;
        plot.resourceSeed = saved.resourceSeed || plot.resourceSeed;
        plot.structures = saved.structures || plot.structures;
        plot.lastResourceAt = saved.lastResourceAt || null;
        if (saved.pendingJobId || saved.nftState?.stage === 'pending') { plot.pendingJobId = null; plot.nftState = { ...this._normaliseNftState(plot, saved.nftState), stage: 'onchain', mintedAt: new Date().toISOString() }; }
        plot.nftState = this._normaliseNftState(plot, saved.nftState);
        if (plot.isClaimed) restored++;
      });

      const legacy = this.plots.filter(p => p.nftState?.stage === 'legacy_simulated').length;
      console.log(`[store] Restored ${restored} claimed plots from disk` +
        (legacy ? ` (${legacy} legacy simulated deed(s) marked)` : ''));
      if (this.gameDb && !this.gameDb.prepare('SELECT 1 AS present FROM game_state WHERE id = 1').get()) this.saveState();
    } catch (err) {
      console.warn('[store] Failed to load game state:', err.message);
    }
  }

  /**
   * The previous build "bridged" deeds by embedding fake tx_extra data. Those
   * records were never on chain. Normalise them so nothing pretends to be a
   * confirmed NFT.
   */
  _normaliseNftState(plot, saved) {
    const assetId = deedAssetId(plot.id);
    if (!saved) {
      // A claim from before the asset-mint queue existed has no chain deed.
      // Mark it legacy rather than pretending it is minted (or unminted).
      const legacy = !!plot.isClaimed;
      return {
        stage: legacy ? 'legacy_simulated' : 'unminted',
        assetId,
        tokenId: assetId,
        metadataHash: null,
        mintedAt: null,
        txHash: null,
        blockHeight: null,
        confirmations: 0,
        jobId: null,
        legacy
      };
    }

    let stage = saved.stage || 'unminted';
    if (stage === 'offchain' || stage === 'pending') stage = stage === 'pending' ? 'pending' : 'unminted';
    if (stage === 'unminted' && plot.isClaimed) stage = 'legacy_simulated';

    // Only a mint that went through a tracked queue job is a real chain deed.
    // Pre-Phase-0 records (seeded demo plots, tx_extra "bridges") are legacy.
    const realMint = stage === 'onchain' && !!saved.jobId && !!saved.txHash && !!saved.assetId;
    if (stage === 'onchain' && !realMint) stage = 'legacy_simulated';

    return {
      stage: realMint ? 'onchain' : stage,
      assetId,
      tokenId: assetId,
      metadataHash: saved.metadataHash || null,
      mintedAt: realMint ? (saved.mintedAt || null) : null,
      // Legacy/pre-Phase-0 records never carried a real chain tx.
      txHash: realMint ? (saved.txHash || null) : null,
      blockHeight: realMint ? (saved.blockHeight || null) : null,
      confirmations: realMint ? (saved.confirmations || REQUIRED_CONFIRMATIONS) : 0,
      jobId: realMint ? (saved.jobId || null) : null,
      confirmedAt: realMint ? (saved.confirmedAt || null) : null,
      legacy: !realMint && stage === 'legacy_simulated'
    };
  }

  /**
   * Deterministic building for a plot. Used both when a claim is first
   * submitted and when claimed plots are rebuilt from chain data after a
   * restart, so a recovered deed has the same property as the original claim.
   */
  _claimBuilding(plot, cost = null) {
    const price = Number(cost) || Number(plot.price) || CONFIG.ECONOMY.PLOT_CLAIM_PRICE_NUM;
    const baseIncomePerHour = baseIncomeForPrice(price, plot.rarity, 0.2);
    const rolled = { name: 'Peasant Lodge' };
    return {
      type: 'peasant_lodge',
      category: 'housing',
      name: `${rolled.name} · ${plot.label}`,
      level: 1,
      description: 'A humble homestead. It provides a small steady income and can be expanded into a local settlement.',
      adminOnly: false,
      variableYield: false,
      baseIncomePerHour,
      incomePerHour: incomePerHourFor(baseIncomePerHour, 1),
      stats: {
        accruedIncome: 0,
        totalIncomeCollected: 0,
        claimedAt: new Date().toISOString()
      },
      name: `Peasant Lodge - ${plot.label}`
    };
  }

  _applySettlementMilestone(plot, level) {
    if (plot.building?.type !== 'peasant_lodge' || ![5, 10].includes(Number(level))) return;
    const isCastle = Number(level) === 10;
    const previousMaxHealth = Math.max(1, Number(plot.maxHealth) || 100);
    const healthRatio = Math.max(0, Math.min(1, Number(plot.health ?? previousMaxHealth) / previousMaxHealth));
    const maxHealth = isCastle ? 1000 : 500;
    const owner = String(plot.owner || '').replace(/^@/, '').toLowerCase();

    plot.building.settlementForm = isCastle ? 'castle' : 'motte_and_bailey';
    plot.building.name = `${isCastle ? 'Castle Keep' : 'Motte-and-Bailey'} - ${plot.label}`;
    plot.building.description = isCastle
      ? 'A fortified stone castle, raised from a developed settlement.'
      : 'A timber-and-earth stronghold protecting a developed settlement.';
    plot.maxHealth = maxHealth;
    plot.health = Math.max(1, Math.round(maxHealth * healthRatio));

    if (isCastle) {
      plot.isCastle = true;
      plot.castleOwner = owner;
      plot.controller = owner;
    }
  }

  _tickPlotResources(plot, tickHours) {
    const stockpile = plot.stockpile || (plot.stockpile = { wood: 24, iron: 6, tin: 0, copper: 0, silver: 0, gold: 0 });
    stockpile.wood = +(Number(stockpile.wood || 0) + 5 * tickHours).toFixed(9);
    const settlementLevel = Math.max(1, Number(plot.building?.level) || 1);
    for (const structure of (plot.structures || [])) {
      if (!PLOT_RESOURCES.includes(structure.resource)) continue;
      const output = Number(structure.outputPerHour || 0) * Math.max(1, Number(structure.level) || 1) * settlementLevel * tickHours;
      stockpile[structure.resource] = +(Number(stockpile[structure.resource] || 0) + output).toFixed(9);
    }
  }

  buildPlotStructure(plotId, username, structureType) {
    const plot = this.getPlotById(plotId);
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    if (!plot?.isClaimed || plot.nftState?.stage === 'pending') throw new Error('A confirmed claimed plot is required');
    if (String(plot.owner || '').replace(/^@/, '').toLowerCase() !== clean && String(plot.controller || '').toLowerCase() !== clean) throw new Error('Only the plot owner can build here');
    if (mintQueue.getJobForPlot(plotId)) throw new Error('Wait for the current plot transaction to confirm before building');
    if (plot.building?.type !== 'peasant_lodge') throw new Error('Only a Peasant Lodge plot can be developed in this game phase');
    const definitions = {
      forge: { name: 'Settlement Forge', resource: null, rate: 0, cost: { wood: 12, iron: 2 } },
      resource_mint: { name: 'Resource Mint', resource: null, rate: 0, cost: { wood: 12, iron: 2 } },
      woodcutter: { name: 'Woodcutter Camp', resource: 'wood', rate: 15, cost: { wood: 10 } },
      iron_mine: { name: 'Iron Mine', resource: 'iron', rate: 8, cost: { wood: 12 } },
      tin_mine: { name: 'Tin Mine', resource: 'tin', rate: 7, cost: { wood: 12 } },
      copper_mine: { name: 'Copper Mine', resource: 'copper', rate: 6, cost: { wood: 12 } },
      silver_mine: { name: 'Silver Mine', resource: 'silver', rate: 3.5, cost: { wood: 16, iron: 2 } },
      gold_mine: { name: 'Gold Mine', resource: 'gold', rate: 2, cost: { wood: 20, iron: 4 } }
    };
    const definition = definitions[structureType];
    if (!definition) throw new Error('Choose a valid settlement building');
    if (!plot.structures?.length) plot.structures = [{ type: 'peasant_lodge', name: 'Peasant Lodge', level: 1 }];
    const builtCount = plot.structures.filter(s => s.type !== 'peasant_lodge').length;
    if (builtCount >= Number(plot.building.level || 1)) throw new Error('Upgrade the Peasant Lodge to unlock another building plot');
    if (plot.structures.some(s => s.type === structureType)) throw new Error('This building is already on the plot');
    const stockpile = plot.stockpile || (plot.stockpile = { wood: 24, iron: 6, tin: 0, copper: 0, silver: 0, gold: 0 });
    for (const [resource, amount] of Object.entries(definition.cost)) {
      if (Number(stockpile[resource] || 0) < amount) throw new Error(`Requires ${amount} ${resource}`);
    }
    for (const [resource, amount] of Object.entries(definition.cost)) stockpile[resource] = +(stockpile[resource] - amount).toFixed(9);
    plot.structures.push({ type: structureType, name: definition.name, resource: definition.resource, outputPerHour: definition.rate, level: 1, builtAt: new Date().toISOString() });
    this.scheduleSave();
    return plot;
  }

  getArmy(username) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const soldiers = this.playerSoldiers[clean] || [];
    const units = { levy: 0, archer: 0, cavalry: 0 };
    soldiers.forEach(s => { if (units[s.type] !== undefined) units[s.type]++; });
    return { username: clean, peerage: this.playerTitles[clean] || null, unlocked: !!this.playerTitles[clean], units, soldiers, armies: Object.values(this.playerArmies).flat().filter(a => a.owner === clean), coinBalance: Number(this.playerCoinPurses[clean] || 0), battles: this.battleLog.filter(b => b.attacker === clean || b.defender === clean).slice(0, 20) };
  }

  craftEquipment(plotId, username, recipeKey) {
    const plot = this.getPlotById(plotId), clean = String(username || '').replace(/^@/, '').toLowerCase();
    if (!plot?.isClaimed || String(plot.owner || '').replace(/^@/, '').toLowerCase() !== clean) throw new Error('Only the plot owner can craft here');
    if (!(plot.structures || []).some(s => s.type === 'forge')) throw new Error('Build a Settlement Forge on this plot first');
    const recipes = {
      bronze_sword: { name: 'Bronze Sword', slot: 'weapon', attack: 4, defense: 0, hpBonus: 0, health: 80, cost: { wood: 2, tin: 1, copper: 1 } },
      iron_sword: { name: 'Iron Sword', slot: 'weapon', attack: 7, defense: 0, hpBonus: 0, health: 120, cost: { wood: 2, iron: 2 } },
      bronze_mail: { name: 'Bronze Mail', slot: 'armor', attack: 0, defense: 4, hpBonus: 15, health: 100, cost: { wood: 2, tin: 2, copper: 2 } },
      iron_mail: { name: 'Iron Mail', slot: 'armor', attack: 0, defense: 7, hpBonus: 25, health: 140, cost: { wood: 2, iron: 4 } },
      bronze_helmet: { name: 'Bronze Helmet', slot: 'helmet', attack: 0, defense: 2, hpBonus: 8, health: 60, cost: { wood: 1, tin: 1, copper: 1 } },
      iron_helmet: { name: 'Iron Helmet', slot: 'helmet', attack: 0, defense: 3, hpBonus: 12, health: 90, cost: { wood: 1, iron: 2 } },
      bow: { name: 'War Bow', slot: 'weapon', attack: 3, defense: 0, hpBonus: 0, health: 70, cost: { wood: 3 } }
    };
    const recipe = recipes[recipeKey]; if (!recipe) throw new Error('Unknown equipment recipe');
    const stock = plot.stockpile || {};
    for (const [r, n] of Object.entries(recipe.cost)) if (Number(stock[r] || 0) < n) throw new Error(`Requires ${n} ${r}`);
    Object.entries(recipe.cost).forEach(([r, n]) => stock[r] = +(Number(stock[r] || 0) - n).toFixed(3));
    const inventory = this.playerSoldiers[clean] || (this.playerSoldiers[clean] = []);
    const item = {
      id: randomUUID(),
      key: recipeKey,
      name: recipe.name,
      slot: recipe.slot,
      attack: recipe.attack,
      defense: recipe.defense,
      hpBonus: recipe.hpBonus,
      health: recipe.health,
      maxHealth: recipe.health,
      owner: clean,
      createdAt: new Date().toISOString()
    };
    (this.playerEquipment ||= {})[clean] ||= []; this.playerEquipment[clean].push(item); this.scheduleSave(); return { item, inventory: this.playerEquipment[clean], plot };
  }

  mintPlotMetal({ plotId, username, metal, form, weightGrams, purity }) {
    const plot = this.getPlotById(plotId);
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    if (!plot?.isClaimed || plot.nftState?.stage === 'pending' || String(plot.owner || '').replace(/^@/, '').toLowerCase() !== clean) {
      throw new Error('Only the plot owner can mint its stored metals');
    }
    if (plot.building?.type !== 'peasant_lodge') {
      throw new Error('Metal assets can only be issued from a settlement plot');
    }
    if (!(plot.structures || []).some(structure => structure.type === 'resource_mint')) {
      throw new Error('Build a Resource Mint on this plot first');
    }
    if (!['live', 'simulate'].includes(chainAdapter.mode)) throw new Error(`Chain unavailable: ${chainAdapter.reason}`);
    if (chainAdapter.mode === 'live' && CONFIG.NUMISTA.NETTYPE === 'numista-mainnet') {
      throw new Error('Resource and metal minting is disabled on mainnet until transaction recovery is safe');
    }
    if (mintQueue.getJobForPlot(plotId)) {
      throw new Error('Wait for the current plot transaction to confirm before minting');
    }
    if (!['silver', 'gold'].includes(metal) || !['coin', 'bar'].includes(form)) {
      throw new Error('Choose silver or gold and a coin or bar');
    }

    const weight = Number(weightGrams);
    const stockpile = plot.stockpile || (plot.stockpile = {});
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1000 || Math.abs(weight * 1000 - Math.round(weight * 1000)) > 1e-8) {
      throw new Error('Enter a weight from 0.001 to 1000 grams in increments of 0.001');
    }
    if (weight > Number(stockpile[metal] || 0)) {
      throw new Error(`Not enough ${metal} in this plot's stockpile`);
    }
    const purityValue = Number(purity);
    if (!Number.isFinite(purityValue) || purityValue < 0.5 || purityValue > 0.9999) {
      throw new Error('Purity must be between 0.5 and 0.9999');
    }
    const fineWeight = +(weight * purityValue).toFixed(3);
    const amountUnits = Math.round(fineWeight * CONFIG.CHAIN.UNITS_PER_NUM);
    if (amountUnits < 1) throw new Error('The fine metal weight is below the blockchain asset precision');

    const metadata = {
      app: 'goldnumista',
      schema: 'goldnumista.plot-metal/v1',
      name: `${metal[0].toUpperCase()}${metal.slice(1)} ${form}`,
      originPlotId: plot.id,
      plotName: plot.name,
      issuer: clean,
      metal,
      form,
      purity: purityValue,
      unit: '0.001 fine grams',
      sprite: assetSprite('resource', `${metal}_${form === 'bar' ? 'bar' : 'coin'}`)
    };
    const assetId = sha256Hex(`goldnumista:plot-metal:v2:${plot.id}:${clean}:${metal}:${form}:${purityValue}`);
    saveDeedMetadata(assetId, metadata);
    const savedMetadata = readDeedMetadata(assetId);
    if (!savedMetadata?.verified || savedMetadata.metadataHash !== metadataHash(metadata)) throw new Error('Metal asset metadata does not match');
    const assetMetadataHash = savedMetadata.metadataHash;
    const snapshot = {
      metal,
      weightGrams: weight,
      issuer: clean,
      assetId
    };

    const registrationSteps = this._registrationSteps([clean]);
    stockpile[metal] = +(Number(stockpile[metal]) - weight).toFixed(9);
    try {
      const job = mintQueue.enqueue({
        type: 'plot_metal_mint',
        username: clean,
        plotId: plot.id,
        assetId,
        snapshot,
        meta: { name: `${weight}g ${metadata.name} from ${plot.name}` },
        steps: [
          ...registrationSteps,
          {
            key: 'create',
            label: `Create owner-issued ${metal} ${form} asset`,
            operation: {
              accountIndex: 0,
              kind: 'create_asset',
              assetId,
              assetType: 'fungible',
              maxSupply: CONFIG.CHAIN.MAX_SUPPLY_UNITS,
              metadataHash: assetMetadataHash
            }
          },
          {
            key: 'mint',
            label: `Mint ${fineWeight} fine grams to @${clean}`,
            operation: {
              accountIndex: 0,
              kind: 'mint',
              assetId,
              assetType: 'fungible',
              recipient: clean,
              amountUnits
            },
            compensate: {
              accountIndex: 0,
              kind: 'transfer',
              assetId,
              assetType: 'fungible',
              from: clean,
              to: TREASURY,
              amountUnits
            }
          }
        ]
      });
      this.scheduleSave();
      return {
        pending: true,
        assetId,
        metal,
        form,
        weightGrams: weight,
        fineWeightGrams: fineWeight,
        issuer: clean,
        metadata,
        job: mintQueue.publicJob(job)
      };
    } catch (err) {
      stockpile[metal] = +(Number(stockpile[metal] || 0) + weight).toFixed(9);
      registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
      throw err;
    }
  }

  mintPlotResource({ plotId, username, resource, amount }) {
    const plot = this.getPlotById(plotId);
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    if (!plot?.isClaimed || plot.nftState?.stage === 'pending' || String(plot.owner || '').replace(/^@/, '').toLowerCase() !== clean) {
      throw new Error('Only the owner of a confirmed plot can mint its resources');
    }
    if (plot.building?.type !== 'peasant_lodge' || !(plot.structures || []).some(structure => structure.type === 'resource_mint')) {
      throw new Error('Build a Resource Mint on this settlement first');
    }
    if (!['live', 'simulate'].includes(chainAdapter.mode)) throw new Error(`Chain unavailable: ${chainAdapter.reason}`);
    if (chainAdapter.mode === 'live' && CONFIG.NUMISTA.NETTYPE === 'numista-mainnet') {
      throw new Error('Resource and metal minting is disabled on mainnet until transaction recovery is safe');
    }
    if (mintQueue.getJobForPlot(plotId)) throw new Error('Wait for the current plot transaction to confirm before minting');
    if (!PLOT_RESOURCES.includes(resource)) throw new Error('Choose a valid resource');
    const quantity = Number(amount);
    const units = Math.round(quantity * CONFIG.CHAIN.UNITS_PER_NUM);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000 ||
        !Number.isSafeInteger(units) || Math.abs(quantity * CONFIG.CHAIN.UNITS_PER_NUM - units) > 1e-8) {
      throw new Error('Enter an amount from 0.001 to 1000 in increments of 0.001');
    }
    const stockpile = plot.stockpile || (plot.stockpile = {});
    if (quantity > Number(stockpile[resource] || 0)) throw new Error(`Not enough ${resource} in this plot's stockpile`);

    const assetId = sha256Hex(`goldnumista:plot-resource:v1:${plot.id}:${clean}:${resource}`);
    const metadata = {
      app: 'goldnumista',
      schema: 'goldnumista.plot-resource/v1',
      name: `${resource[0].toUpperCase()}${resource.slice(1)} resource`,
      originPlotId: plot.id,
      issuer: clean,
      resource,
      unit: '0.001 resource units',
      sprite: assetSprite('resource', resource)
    };
    saveDeedMetadata(assetId, metadata);
    const saved = readDeedMetadata(assetId);
    if (!saved?.verified || saved.metadataHash !== metadataHash(metadata)) throw new Error('Resource asset metadata does not match');
    const registrationSteps = this._registrationSteps([clean]);
    stockpile[resource] = +(Number(stockpile[resource]) - quantity).toFixed(9);
    try {
      const job = mintQueue.enqueue({
        type: 'plot_resource_mint',
        username: clean,
        plotId: plot.id,
        assetId,
        snapshot: { resource, amount: quantity },
        meta: { name: `${quantity} ${resource} from ${plot.name}` },
        steps: [
          ...registrationSteps,
          { key: 'create', label: `Create ${resource} resource asset`, operation: {
            accountIndex: 0, kind: 'create_asset', assetId, assetType: 'fungible',
            maxSupply: CONFIG.CHAIN.MAX_SUPPLY_UNITS, metadataHash: saved.metadataHash
          } },
          { key: 'mint', label: `Mint ${quantity} ${resource} to @${clean}`, operation: {
            accountIndex: 0, kind: 'mint', assetId, assetType: 'fungible', recipient: clean, amountUnits: units
          } }
        ]
      });
      this.scheduleSave();
      return { pending: true, assetId, resource, amount: quantity, metadata, job: mintQueue.publicJob(job) };
    } catch (err) {
      stockpile[resource] = +(Number(stockpile[resource] || 0) + quantity).toFixed(9);
      registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
      throw err;
    }
  }

  getEquipment(username) { return (this.playerEquipment?.[String(username || '').replace(/^@/, '').toLowerCase()] || []); }

  equipSoldier(username, soldierId, itemId) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const soldier = (this.playerSoldiers[clean] || []).find(s => s.id === soldierId);
    if (!soldier || soldier.armyId) throw new Error('Choose an unassigned soldier');
    const inventory = this.playerEquipment[clean] || [];
    const index = inventory.findIndex(i => i.id === itemId);
    if (index < 0) throw new Error('Equipment not in your inventory');
    const item = inventory[index];
    const slot = ['weapon', 'armor', 'helmet'].includes(item.slot)
      ? item.slot
      : (item.defense ? 'armor' : 'weapon');
    const previous = soldier[slot];
    if (previous) inventory.push(previous);
    inventory.splice(index, 1);
    soldier[slot] = item;
    refreshSoldierMaxHp(soldier);
    this.scheduleSave();
    return { soldier, equipment: inventory };
  }

  healSoldier(username, soldierId) { const clean = String(username || '').replace(/^@/, '').toLowerCase(), soldier = (this.playerSoldiers[clean] || []).find(s => s.id === soldierId); if (!soldier) throw new Error('Soldier not found'); if (soldier.hp >= soldier.maxHp) throw new Error('This soldier is already at full health'); const army = (Array.isArray(this.playerArmies[clean]) ? this.playerArmies[clean] : []).find(a => a.id === soldier.armyId); if (army && army.status !== 'idle') throw new Error('Soldiers can only recover while their army is idle'); const cost = 0.05, purse = Number(this.playerCoinPurses[clean] || 0); if (purse < cost) throw new Error('Healing costs 0.05 minted coin value'); this.playerCoinPurses[clean] = round(purse - cost, 6); soldier.hp = Math.min(soldier.maxHp, soldier.hp + 25); soldier.unpaidDays = 0; this.scheduleSave(); return { soldier, coinBalance: this.playerCoinPurses[clean] }; }

  createArmy(username, name, soldierIds = []) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase(); if (!this.playerTitles[clean]) throw new Error('Buy a peerage before commanding an army');
    const roster = this.playerSoldiers[clean] || []; const selected = [...new Set(soldierIds)];
    if (!selected.length || selected.some(id => !roster.some(s => s.id === id && !s.armyId))) throw new Error('Select available soldiers for this army');
    const armies = this.playerArmies[clean] || (this.playerArmies[clean] = []); if (!Array.isArray(armies)) throw new Error('Legacy troop roster is being migrated; refresh after restart');
    const army = { id: randomUUID(), owner: clean, name: String(name || 'Household Guard').slice(0, 40), soldierIds: selected, locationPlotId: roster.find(s => selected.includes(s.id))?.homePlotId || this.plots.find(p => p.isCastle)?.id || this.plots[0]?.id || null, targetPlotId: null, route: [], status: 'idle', createdAt: new Date().toISOString() };
    selected.forEach(id => { const soldier = roster.find(s => s.id === id); soldier.armyId = army.id; }); armies.push(army); this.scheduleSave(); return army;
  }

  _armyMarchPlan(username, armyId, targetPlotId, siege = false) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const army = (this.playerArmies[clean] || []).find(a => a.id === armyId);
    if (!army) throw new Error('Army not found');
    if (army.status !== 'idle') throw new Error('This army is already travelling, fighting, or awaiting silver payment');
    const soldiers = (this.playerSoldiers[clean] || []).filter(s => army.soldierIds.includes(s.id));
    if (!soldiers.length) throw new Error('Army has no soldiers');
    const homePlotId = soldiers.find(s => s.homePlotId)?.homePlotId || this.plots.find(p => p.isCastle)?.id || this.plots[0]?.id;
    if (!army.locationPlotId) army.locationPlotId = homePlotId;
    const from = this.getPlotById(army.locationPlotId);
    const target = this.getPlotById(targetPlotId);
    if (!from || !target) throw new Error('Choose valid origin and destination plots');
    if (siege && !target.isClaimed) throw new Error('You can only attack a claimed plot');
    if (siege && String(target.controller || target.castleOwner || target.owner || '').replace(/^@/, '').toLowerCase() === clean) {
      throw new Error('You cannot attack your own plot');
    }

    const byCell = new Map(this.plots.filter(p => Number.isFinite(Number(p.row)) && Number.isFinite(Number(p.col))).map(p => [`${p.row}:${p.col}`, p]));
    const startKey = `${from.row}:${from.col}`, targetKey = `${target.row}:${target.col}`;
    const queue = [startKey], previous = new Map([[startKey, null]]);
    for (let cursor = 0; cursor < queue.length && !previous.has(targetKey); cursor++) {
      const [row, col] = queue[cursor].split(':').map(Number);
      for (const [r, c] of [[row-1,col],[row+1,col],[row,col-1],[row,col+1]]) {
        const key = `${r}:${c}`;
        if (byCell.has(key) && !previous.has(key)) { previous.set(key, queue[cursor]); queue.push(key); }
      }
    }
    const pathKeys = [];
    if (previous.has(targetKey)) { for (let key = targetKey; key && key !== startKey; key = previous.get(key)) pathKeys.unshift(key); }
    const route = pathKeys.length ? pathKeys.map(key => byCell.get(key).id) : [target.id];
    const distance = route.length;
    if (distance < 1) throw new Error('Army is already at that plot');
    const speed = Math.max(1, Math.min(...soldiers.map(s => s.speed || 1)));
    return { clean, army, from, target, soldiers, route, distance, speed };
  }

  async _availablePlayerSilver(username) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const metadataFiles = fs.existsSync(METADATA_DIR)
      ? fs.readdirSync(METADATA_DIR).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      : [];
    const assets = metadataFiles.flatMap(name => {
      const assetId = name.slice(0, -5);
      const saved = readDeedMetadata(assetId);
      const metadata = saved?.metadata;
      const silver = (metadata?.schema === 'goldnumista.plot-metal/v1' && metadata.metal === 'silver') ||
        (metadata?.schema === 'goldnumista.plot-resource/v1' && metadata.resource === 'silver');
      if (!saved?.verified || !silver || !metadata.issuer ||
          String(metadata.issuer).replace(/^@/, '').toLowerCase() === TREASURY) return [];
      return [{ assetId, metadata }];
    });
    const reservedByAsset = new Map();
    for (const job of mintQueue.jobs) {
      if (job.type !== 'army_silver_payroll' || String(job.username || '').toLowerCase() !== clean) continue;
      for (const transfer of job.snapshot?.silverTransfers || []) {
        reservedByAsset.set(transfer.assetId, (reservedByAsset.get(transfer.assetId) || 0) + Number(transfer.amountUnits || 0));
      }
    }
    const balances = await Promise.all(assets.map(async asset => ({
      ...asset,
      balanceUnits: Math.max(0,
        Math.floor(Number(await chainAdapter.getAssetBalance(asset.assetId, clean)) -
          Number(reservedByAsset.get(asset.assetId) || 0)))
    })));
    return balances.filter(asset => asset.balanceUnits > 0);
  }

  async getArmyMarchEstimate(username, armyId, targetPlotId) {
    const plan = this._armyMarchPlan(username, armyId, targetPlotId, true);
    const silverUnits = Math.round(plan.soldiers.length * plan.distance *
      ARMY_SILVER_PER_TILE_PER_SOLDIER * CONFIG.CHAIN.UNITS_PER_NUM);
    const assets = await this._availablePlayerSilver(plan.clean);
    const availableUnits = assets.reduce((sum, asset) => sum + asset.balanceUnits, 0);
    return {
      armyId,
      targetPlotId: plan.target.id,
      distanceTiles: plan.distance,
      soldierCount: plan.soldiers.length,
      silverPerSoldierPerTile: ARMY_SILVER_PER_TILE_PER_SOLDIER,
      silverFineGrams: silverUnits / CONFIG.CHAIN.UNITS_PER_NUM,
      availableSilverFineGrams: availableUnits / CONFIG.CHAIN.UNITS_PER_NUM,
      canAfford: availableUnits >= silverUnits
    };
  }

  _startArmyMarch(plan, siege, payroll = null) {
    const { army, from, target, route, distance, speed } = plan;
    army.originPlotId = from.id; army.startedAt = new Date().toISOString(); army.travelMs = Math.max(15000, distance * 60000 / speed);
    army.targetPlotId = target.id; army.route = route; army.status = siege ? 'marching_to_siege' : 'marching'; army.siegeTarget = !!siege; army.arrivesAt = new Date(Date.now() + army.travelMs).toISOString();
    army.pendingDispatch = null;
    if (payroll) army.lastSilverPayroll = payroll;
    this.scheduleSave(); return army;
  }

  async moveArmy(username, armyId, targetPlotId, siege = false) {
    const plan = this._armyMarchPlan(username, armyId, targetPlotId, siege);
    if (!siege) return { pending: false, army: this._startArmyMarch(plan, false) };
    if (this.pendingArmyPayments.has(plan.clean)) throw new Error('A silver payroll payment is already being prepared for this player');
    this.pendingArmyPayments.add(plan.clean);
    try {
      const silverUnits = Math.round(plan.soldiers.length * plan.distance *
        ARMY_SILVER_PER_TILE_PER_SOLDIER * CONFIG.CHAIN.UNITS_PER_NUM);
      const assets = await this._availablePlayerSilver(plan.clean);
      let remainingUnits = silverUnits;
      const silverTransfers = [];
      for (const asset of assets) {
        const amountUnits = Math.min(asset.balanceUnits, remainingUnits);
        if (amountUnits > 0) {
          silverTransfers.push({ assetId: asset.assetId, amountUnits });
          remainingUnits -= amountUnits;
        }
        if (!remainingUnits) break;
      }
      if (remainingUnits > 0) {
        const availableUnits = silverUnits - remainingUnits;
        throw new Error(`Attack requires ${(silverUnits / CONFIG.CHAIN.UNITS_PER_NUM).toFixed(3)} units of player-minted silver for ${plan.soldiers.length} soldiers across ${plan.distance} tiles; available ${(availableUnits / CONFIG.CHAIN.UNITS_PER_NUM).toFixed(3)}`);
      }

      const registrationSteps = this._registrationSteps([plan.clean, TREASURY]);
      const steps = [
        ...registrationSteps,
        ...silverTransfers.map((transfer, index) => ({
          key: `silver_pay_${index + 1}`,
          label: `Pay ${(transfer.amountUnits / CONFIG.CHAIN.UNITS_PER_NUM).toFixed(3)} units of silver`,
          operation: {
            accountIndex: 0,
            kind: 'transfer',
            assetId: transfer.assetId,
            assetType: 'fungible',
            from: plan.clean,
            to: TREASURY,
            amountUnits: transfer.amountUnits
          },
          compensate: {
            accountIndex: 0,
            kind: 'transfer',
            assetId: transfer.assetId,
            assetType: 'fungible',
            from: TREASURY,
            to: plan.clean,
            amountUnits: transfer.amountUnits
          }
        }))
      ];
      const snapshot = {
        armyId: plan.army.id,
        targetPlotId: plan.target.id,
        route: plan.route,
        distanceTiles: plan.distance,
        soldierIds: plan.soldiers.map(s => s.id),
        silverFineGrams: silverUnits / CONFIG.CHAIN.UNITS_PER_NUM,
        silverTransfers
      };
      plan.army.status = 'payroll_pending';
      plan.army.pendingDispatch = {
        targetPlotId: plan.target.id,
        distanceTiles: plan.distance,
        silverFineGrams: snapshot.silverFineGrams
      };
      try {
        const job = mintQueue.enqueue({
          type: 'army_silver_payroll',
          username: plan.clean,
          plotId: plan.target.id,
          assetId: silverTransfers[0]?.assetId || null,
          snapshot,
          meta: { name: `Army dispatch payroll · ${plan.army.name}` },
          steps
        });
        plan.army.payrollJobId = job.id;
        this.scheduleSave();
        return {
          pending: true,
          army: plan.army,
          silverFineGrams: snapshot.silverFineGrams,
          distanceTiles: plan.distance,
          job: mintQueue.publicJob(job)
        };
      } catch (err) {
        plan.army.status = 'idle';
        plan.army.pendingDispatch = null;
        plan.army.payrollJobId = null;
        registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
        throw err;
      }
    } finally {
      this.pendingArmyPayments.delete(plan.clean);
    }
  }

  resolveSiege(army) {
    const attacker = army.owner, target = this.getPlotById(army.targetPlotId);
    if (!target?.isClaimed || army.pendingBattleId) return null;
    const soldiers = (this.playerSoldiers[attacker] || []).filter(s => army.soldierIds.includes(s.id));
    if (!soldiers.length) { army.status = 'idle'; army.targetPlotId = null; army.siegeTarget = false; army.arrivesAt = null; target.siege = null; this.scheduleSave(); return null; }
    const battleId = randomUUID();
    const randomSeed = sha256Hex(battleId);
    let seed = Number.parseInt(randomSeed.slice(0, 8), 16) || 1;
    const roll = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const attackerPower = soldiers.reduce((sum, s) => sum + Number(s.attack || 0) + gearStat(s.weapon, 'attack'), 0);
    const defender = String(target.controller || target.castleOwner || target.owner || TREASURY).replace(/^@/, '').toLowerCase();
    const defenderArmies = (Array.isArray(this.playerArmies[defender]) ? this.playerArmies[defender] : []).filter(a => a.locationPlotId === target.id && a.status === 'idle');
    const defenderArmyIds = new Set(defenderArmies.map(a => a.id));
    const defendingSoldiers = (this.playerSoldiers[defender] || []).filter(s => defenderArmyIds.has(s.armyId));
    const garrisonBefore = Number(target.garrison || (target.isCastle ? 5 : 0));
    const defense = Math.max(1, garrisonBefore * (target.isCastle ? 2 : 1) + Number(target.fortificationLevel || 0) * 12 + defendingSoldiers.reduce((n, s) => n + Number(s.attack || 0) + Number(s.defense || 0) + gearStat(s.armor, 'defense') + gearStat(s.helmet, 'defense'), 0));
    const damage = Math.max(5, Math.floor(attackerPower * (0.45 + roll() * 0.25)));
    const healthBefore = Number(target.health ?? (target.isCastle ? 1000 : 100));
    const casualtyEvents = [];
    const recordCasualties = (roster, side, chance) => {
      if (!roster.length || roll() >= chance) return;
      const losses = Math.min(roster.length, Math.max(1, Math.floor(roster.length * Math.min(0.5, chance * 0.5))));
      roster.slice().sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id)).slice(0, losses).forEach(s => {
        const armor = Math.min(0.7, (Number(s.defense || 0) + gearStat(s.armor, 'defense') + gearStat(s.helmet, 'defense')) / 30);
        const damageToSoldier = Math.ceil(s.maxHp * (0.25 + roll() * 0.35) * (1 - armor));
        casualtyEvents.push({ side, soldierId: s.id, damage: damageToSoldier, killed: s.hp - damageToSoldier <= 0 });
      });
    };
    const totalPower = attackerPower + defense;
    recordCasualties(soldiers, 'attacker', Math.min(0.85, 0.25 + defense / totalPower * 0.5));
    recordCasualties(defendingSoldiers, 'defender', Math.min(0.85, 0.25 + attackerPower / totalPower * 0.5));
    const attackerSurvivors = soldiers.length - casualtyEvents.filter(event => event.side === 'attacker' && event.killed).length;
    const defenderSurvivors = defendingSoldiers.length - casualtyEvents.filter(event => event.side === 'defender' && event.killed).length;
    const garrisonDamage = target.isCastle ? Math.min(garrisonBefore, Math.max(1, Math.floor(damage / 25))) : 0;
    const captured = healthBefore - damage <= 0 && attackerSurvivors > 0 && garrisonBefore - garrisonDamage <= 0 && defenderSurvivors === 0;
    const at = new Date().toISOString();
    const summarizeSoldier = s => ({
      id: s.id,
      type: s.type,
      hp: s.hp,
      maxHp: s.maxHp,
      attack: s.attack,
      defense: s.defense,
      weapon: s.weapon ? { key: s.weapon.key, attack: s.weapon.attack, health: s.weapon.health, maxHealth: s.weapon.maxHealth } : null,
      armor: s.armor ? { key: s.armor.key, defense: s.armor.defense, hpBonus: s.armor.hpBonus, health: s.armor.health, maxHealth: s.armor.maxHealth } : null,
      helmet: s.helmet ? { key: s.helmet.key, defense: s.helmet.defense, hpBonus: s.helmet.hpBonus, health: s.helmet.health, maxHealth: s.helmet.maxHealth } : null
    });
    const equipmentWear = [...soldiers.map(s => ({ side: 'attacker', soldier: s })), ...defendingSoldiers.map(s => ({ side: 'defender', soldier: s }))]
      .map(({ side, soldier }) => ({
        side,
        soldierId: soldier.id,
        weapon: itemIsUsable(soldier.weapon) ? 1 : 0,
        armor: itemIsUsable(soldier.armor) ? 1 : 0,
        helmet: itemIsUsable(soldier.helmet) ? 1 : 0
      }));
    const report = { app: 'townforge-numista', schema: 'townforge.numista.battle/v1', sprite: assetSprite('item', 'knight'), battleId, randomSeed, at, attacker, defender, armyId: army.id, plotId: target.id, attackerRoster: soldiers.map(summarizeSoldier), defenderRoster: defendingSoldiers.map(summarizeSoldier), defenderState: { controller: target.controller || target.castleOwner || target.owner || TREASURY, garrison: garrisonBefore, fortificationLevel: target.fortificationLevel || 0, plotHealth: healthBefore, maxHealth: target.maxHealth || (target.isCastle ? 1000 : 100) }, attackerPower, defenderPower: defense, plotHealthBefore: healthBefore, plotDamage: damage, garrisonDamage, casualtyEvents, equipmentWear, captured, isCastle: !!target.isCastle, survivors: attackerSurvivors };
    const assetId = sha256Hex(`townforge-numista:battle:v1:${battleId}`);
    const hash = metadataHash(report);
    let registrationSteps = [];
    try {
      saveDeedMetadata(assetId, report);
      registrationSteps = this._registrationSteps([attacker]);
      const job = mintQueue.enqueue({
        type: 'battle_settlement', username: attacker, assetId,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        snapshot: { report }, meta: { name: `Battle report ${target.label || target.id}`, plotId: target.id, battleId },
        steps: [
          ...registrationSteps,
          { key: 'create', label: 'Commit immutable battle report hash', operation: { accountIndex: 0, kind: 'create_asset', assetId, assetType: DEED_ASSET_TYPE, maxSupply: 1, metadataHash: hash } },
          { key: 'mint', label: 'Record battle report on chain', operation: { accountIndex: 0, kind: 'mint', assetId, assetType: DEED_ASSET_TYPE, recipient: attacker, amountUnits: 1 } }
        ]
      });
      army.status = 'awaiting_battle_confirmation'; army.pendingBattleId = battleId; army.arrivesAt = null;
      target.siege = { attacker, armyId: army.id, pendingBattleId: battleId, battleAssetId: assetId, settlementJobId: job.id };
      this.scheduleSave(); return { battleId, assetId, job: mintQueue.publicJob(job), message: 'Battle result awaits on-chain confirmation.' };
    } catch (error) {
      registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
      army.status = 'besieging'; army.arrivesAt = new Date(Date.now() + 60000).toISOString();
      throw error;
    }
  }

  repairPlot(plotId, username) { const plot = this.getPlotById(plotId), clean = String(username || '').replace(/^@/, '').toLowerCase(); if (!plot?.isClaimed || (plot.owner !== clean && plot.controller !== clean)) throw new Error('Only the owner can repair this plot'); const cost = { wood: 10, iron: 2 }; for (const [r,n] of Object.entries(cost)) if (Number(plot.stockpile?.[r] || 0) < n) throw new Error(`Repair requires ${n} ${r}`); Object.entries(cost).forEach(([r,n]) => plot.stockpile[r] -= n); plot.health = Math.min(plot.maxHealth || 100, Number(plot.health || 0) + 250); this.scheduleSave(); return plot; }

  fortifyPlot(plotId, username) { const plot = this.getPlotById(plotId), clean = String(username || '').replace(/^@/, '').toLowerCase(); if (!plot?.isClaimed || (String(plot.owner || '').replace(/^@/, '').toLowerCase() !== clean && plot.controller !== clean)) throw new Error('Only the owner or controller can fortify this plot'); const level = Number(plot.fortificationLevel || 0); if (level >= 5) throw new Error('Fortification is already at the maximum level'); const cost = { wood: 20 * (level + 1), iron: 5 * (level + 1) }; for (const [r,n] of Object.entries(cost)) if (Number(plot.stockpile?.[r] || 0) < n) throw new Error(`Fortification level ${level + 1} requires ${n} ${r}`); Object.entries(cost).forEach(([r,n]) => plot.stockpile[r] = +(Number(plot.stockpile[r]) - n).toFixed(3)); plot.fortificationLevel = level + 1; plot.maxHealth = Number(plot.maxHealth || (plot.isCastle ? 1000 : 100)) + (plot.isCastle ? 150 : 25); plot.health = Math.min(plot.maxHealth, Number(plot.health || 0) + (plot.isCastle ? 150 : 25)); this.scheduleSave(); return plot; }

  getConquerableCastles() {
    return this.plots.filter(plot => plot.isCastle && plot.castleOwner === TREASURY);
  }

  conquerCastle(plotId, username) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const plot = this.getPlotById(plotId);
    if (!plot?.isCastle || plot.castleOwner !== TREASURY) throw new Error('This castle is not available to conquer');
    if (!this.playerTitles[clean]) throw new Error('Buy a peerage before leading an army');
    const army = this.playerArmies[clean] || { levy: 0, archer: 0, cavalry: 0 };
    const strength = (Number(army.levy) || 0) + (Number(army.archer) || 0) * 1.5 + (Number(army.cavalry) || 0) * 3;
    const garrison = Math.max(5, Number(plot.garrison) || 5);
    if (strength < garrison) throw new Error(`Your army strength is ${strength.toFixed(1)}. This castle's garrison requires ${garrison}.`);

    for (const unit of ['levy', 'archer', 'cavalry']) {
      const committed = Number(army[unit]) || 0;
      army[unit] = Math.max(0, committed - Math.ceil(committed * 0.2));
    }
    this.playerArmies[clean] = army;
    plot.castleOwner = clean;
    plot.owner = clean;
    plot.garrison = Math.max(1, Math.floor(garrison * 0.6));
    plot.castleConqueredAt = new Date().toISOString();
    plot.building = { ...plot.building, name: `Castle Keep · ${plot.name}`, type: 'castle_keep', category: 'military', garrison: plot.garrison };
    this.scheduleSave();
    return { plot, army, message: `${plot.name} has been conquered. One fifth of each unit type was lost in the siege.` };
  }

  purchasePeerage(username, titleKey) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const catalog = {
      baron: { title: 'Baron / Baroness', price: 10 },
      viscount: { title: 'Viscount / Viscountess', price: 25 },
      earl: { title: 'Earl / Countess', price: 50 },
      marquess: { title: 'Marquess / Marchioness', price: 100 },
      duke: { title: 'Duke / Duchess', price: 250 },
      elector: { title: 'Sovereign Elector', price: 500 }
    };
    const peerage = catalog[titleKey];
    if (!peerage) throw new Error('Choose a valid peerage');
    const job = this._enqueueNumTransfer({
      type: 'title_purchase', from: clean, to: TREASURY, amount: peerage.price,
      description: `Royal Peerage: ${peerage.title}`,
      snapshot: { username: clean, title: peerage.title }
    });
    return { title: peerage.title, price: peerage.price, pending: true, job: mintQueue.publicJob(job) };
  }

  recruitSoldiers(username, unitType, count) {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    if (!this.playerTitles[clean]) throw new Error('Buy your first peerage to unlock soldier recruitment');
    const catalog = { levy: { name: 'Levy Spearman', price: 1 }, archer: { name: 'Bowman', price: 3 }, cavalry: { name: 'Light Cavalry', price: 8 } };
    if (!Array.isArray(this.playerArmies[clean])) this.playerArmies[clean] = [];
    const unit = catalog[unitType];
    const quantity = Math.floor(Number(count));
    if (!unit || quantity < 1 || quantity > 100) throw new Error('Recruit 1 to 100 valid soldiers at a time');
    const cost = +(unit.price * quantity).toFixed(4);
    const job = this._enqueueNumTransfer({
      type: 'soldier_recruit', from: clean, to: TREASURY, amount: cost,
      description: `Recruit ${quantity} ${unit.name}${quantity === 1 ? '' : 's'}`,
      snapshot: { username: clean, unitType, count: quantity, cost }
    });
    return { pending: true, unitType, count: quantity, cost, job: mintQueue.publicJob(job), army: this.getArmy(clean) };
  }

  /**
   * Rebuild deed ownership from the chain.
   *
   * The queue journal and metadata files are only used as an index of which
   * asset IDs to look at. The chain is authoritative: an asset only becomes a
   * claimed plot when `get_numista_asset` says it exists and the recorded owner
   * actually holds one unit. This makes the runtime stateless across restarts
   * without ever pretending an off-chain record is a minted deed.
   */
  async reconcileChainDeeds({ force = false } = {}) {
    if (chainAdapter.mode !== 'live' && chainAdapter.mode !== 'simulate') return 0;
    if (this._deedReconcilePromise) return this._deedReconcilePromise;
    if (!force && Date.now() - this._deedReconcileAt < 15000) return 0;

    this._deedReconcilePromise = (async () => {
      this._deedReconcileAt = Date.now();
      const candidates = new Map();

      for (const job of [...mintQueue.jobs, ...mintQueue.history]) {
        if (job.type !== 'claim' || !job.plotId || !job.assetId) continue;
        const mint = job.steps?.find(step => step.key === 'mint' && !step.compensation);
        if (!mint || mint.status !== 'confirmed') continue;
        candidates.set(job.plotId, {
          plotId: job.plotId,
          assetId: job.assetId,
          username: String(job.username || '').toLowerCase() || null,
          job,
          mint
        });
      }

      // Metadata is an immutable chain-adjacent index. If the in-memory queue
      // was lost, it still tells us which asset IDs may be deeds.
      try {
        if (fs.existsSync(METADATA_DIR)) {
          for (const name of fs.readdirSync(METADATA_DIR)) {
            if (!name.endsWith('.json')) continue;
            const assetId = name.slice(0, -5);
            const payload = readDeedMetadata(assetId);
            if (payload?.metadata?.schema !== DEED_SCHEMA) continue;
            const plotId = payload?.metadata?.plotId;
            if (!plotId || candidates.has(plotId)) continue;
            candidates.set(plotId, { plotId, assetId, username: null, job: null, mint: null });
          }
        }
      } catch (err) {
        console.warn('[store] Could not scan deed metadata:', err.message);
      }

      let applied = 0;
      for (const candidate of candidates.values()) {
        const plot = this.getPlotById(candidate.plotId);
        if (!plot) continue;

        const asset = await chainAdapter.getAsset(candidate.assetId).catch(() => null);
        if (!asset) continue;

        let owner = candidate.username;
        let balance = owner
          ? Number(await chainAdapter.getAssetBalance(candidate.assetId, owner).catch(() => 0))
          : 0;

        if (balance < 1) {
          owner = null;
          for (const username of userManager.allUsernames()) {
            const units = Number(await chainAdapter.getAssetBalance(candidate.assetId, username).catch(() => 0));
            if (units >= 1) {
              owner = username;
              balance = units;
              break;
            }
          }
        }
        if (!owner || balance < 1) continue;

        const localOwner = String(plot.owner || '').replace(/^@/, '').toLowerCase();
        if (!plot.isCastle && plot.isClaimed && localOwner && localOwner !== owner) {
          // Secondary-market sales update the local owner before the deed
          // transfer is mirrored on-chain. Do not clobber that newer owner.
          continue;
        }

        const building = candidate.job?.snapshot?.building || this._claimBuilding(plot, candidate.job?.snapshot?.cost);
        const metadata = deedMetadata({ ...plot, buildingType: building?.type || null });
        const hash = candidate.job?.snapshot?.metadataHash || readDeedMetadata(candidate.assetId || deedAssetId(plot.id))?.metadataHash || metadataHash(metadata);
        const mintedAt = candidate.mint?.submittedAt || asset.created_at || new Date().toISOString();

        const recoveringPlot = !plot.isClaimed;
        plot.isClaimed = true;
        plot.owner = plot.isCastle ? (plot.castleOwner || TREASURY) : owner;
        plot.building = plot.building || building;
        if (!plot.structures?.length) plot.structures = [{ type: 'peasant_lodge', name: 'Peasant Lodge', level: 1 }];
        if (recoveringPlot && candidate.job?.snapshot?.resourceDeposits) {
          plot.resourceSeed = candidate.job.snapshot.resourceSeed;
          plot.resourceDeposits = { ...candidate.job.snapshot.resourceDeposits };
          if (candidate.job.snapshot.stockpile) plot.stockpile = { ...candidate.job.snapshot.stockpile };
        }
        plot.stockpile ||= { wood: 24, iron: 6, tin: 0, copper: 0, silver: 0, gold: 0 };
        plot.lastResourceAt ||= new Date().toISOString();
        plot.pendingJobId = null;
        plot.nftState = {
          stage: 'onchain',
          assetId: candidate.assetId,
          tokenId: candidate.assetId,
          metadataHash: hash,
          mintedAt,
          txHash: candidate.mint?.txHash || asset.tx_hash || null,
          blockHeight: candidate.mint?.confirmedHeight || asset.block_height || null,
          confirmations: Number(candidate.job?.requiredConfirmations) || REQUIRED_CONFIRMATIONS,
          jobId: candidate.job?.id || null,
          confirmedAt: candidate.mint?.submittedAt || null
        };
        applied += 1;
      }

      if (applied) console.log(`[store] Reconciled ${applied} on-chain deed(s) from chain data`);
      return applied;
    })().finally(() => {
      this._deedReconcilePromise = null;
    });

    return this._deedReconcilePromise;
  }

  saveState() {
    try {
      const payload = {
        gameVersion: 3,
        seasonStartedAt: this.seasonStartedAt || new Date().toISOString(),
        savedAt: new Date().toISOString(),
        mints: this.mintLedger,
        userBanks: this.userBanks,
        userStocks: this.userStocks,
        playerTitles: this.playerTitles,
        playerArmies: this.playerArmies,
        playerSoldiers: this.playerSoldiers,
        playerCoinPurses: this.playerCoinPurses,
        playerEquipment: this.playerEquipment,
        battleLog: this.battleLog,
        auctions: this.auctions,
        plots: this.plots
          .filter(p => p.isClaimed || p.pendingJobId || p.nftState?.stage !== 'unminted')
          .map(p => ({
            id: p.id,
            isClaimed: p.isClaimed,
            owner: p.owner,
            isCastle: !!p.isCastle,
            castleOwner: p.castleOwner || null,
            controller: p.controller || p.castleOwner || null,
            garrison: Number(p.garrison) || 0,
            health: Number(p.health) || (p.isCastle ? 1000 : 100),
            maxHealth: Number(p.maxHealth) || (p.isCastle ? 1000 : 100),
            fortificationLevel: Number(p.fortificationLevel) || 0,
            siege: p.siege || null,
            marketListing: p.marketListing || null,
            marketSaleJobId: p.marketSaleJobId || null,
            pendingJobId: p.pendingJobId || null,
            building: p.building,
            stockpile: p.stockpile,
            resourceDeposits: p.resourceDeposits,
            resourceSeed: p.resourceSeed,
            structures: p.structures,
            lastResourceAt: p.lastResourceAt,
            nftState: p.nftState
          }))
      };
      const serialized = JSON.stringify(payload);
      if (this.gameDb) {
        this.gameDb.exec('BEGIN IMMEDIATE');
        try {
          this.gameDb.prepare('INSERT INTO game_state(id, payload, updated_at) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').run(serialized, payload.savedAt);
          const putBattle = this.gameDb.prepare('INSERT INTO battle_events(asset_id, report_json, tx_hash, block_height, created_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET report_json=excluded.report_json, tx_hash=excluded.tx_hash, block_height=excluded.block_height');
          for (const battle of this.battleLog) if (battle.assetId && battle.txHash) putBattle.run(battle.assetId, JSON.stringify(battle), battle.txHash, Number(battle.blockHeight) || 0, battle.at || payload.savedAt);
          this.gameDb.exec('COMMIT');
        } catch (err) { this.gameDb.exec('ROLLBACK'); throw err; }
      }
      fs.writeFileSync(this.statePath, serialized, 'utf8');
    } catch (err) {
      console.warn('[store] Failed to save game state:', err.message);
    }
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveState();
    }, 500);
  }

  /**
   * Re-apply journal outcomes that were written to disk before a restart.
   */
  _recoverJobs() {
    const all = [...mintQueue.jobs, ...mintQueue.history];
    let recovered = 0;
    for (const job of all) {
      if (!['confirmed', 'reverted', 'failed', 'revert_failed'].includes(job.status)) {
        job.steps
          .filter(step => step.operation?.kind === 'register_username' && step.status !== 'confirmed')
          .forEach(step => this.pendingUsernameRegistrations.add(step.operation.username));

        // A claim still waiting for confirmations must keep the plot reserved
        // across a restart, otherwise the UI shows it as unclaimed and another
        // claim could be submitted for the same deed.
        if (job.type === 'claim' && job.plotId && !job.gameApplied && Date.parse(job.createdAt || 0) >= Date.parse(this.seasonStartedAt || 0)) {
          const plot = this.getPlotById(job.plotId);
          const owner = String(job.username || '').toLowerCase();
          if (plot && owner && !plot.pendingJobId &&
              (!plot.owner || String(plot.owner).replace(/^@/, '').toLowerCase() === owner)) {
            plot.isClaimed = true;
            plot.owner = owner;
            plot.building = plot.building || job.snapshot?.building || this._claimBuilding(plot, job.snapshot?.cost);
            plot.pendingJobId = job.id;
            plot.nftState = {
              stage: 'pending',
              assetId: job.assetId,
              tokenId: job.assetId,
              metadataHash: job.snapshot?.metadataHash || null,
              mintedAt: null,
              txHash: null,
              blockHeight: null,
              confirmations: 0,
              jobId: job.id,
              pendingSince: job.createdAt || new Date().toISOString()
            };
            recovered++;
          }
        }
      }
      if (job.gameApplied && !(job.type === 'battle_settlement' && job.status === 'confirmed' && !this.battleLog.some(b => b.battleId === job.snapshot?.report?.battleId))) continue;
      if (job.status === 'confirmed') {
        this._onJobConfirmed(job);
        recovered++;
      } else if (FAILED_JOB_STATUSES.has(job.status)) {
        this._onJobReverted(job);
        recovered++;
      }
    }
    if (recovered) {
      console.log(`[store] Recovered ${recovered} mint job(s) after restart`);
      this.scheduleSave();
    }
  }

  tickSimulation() {
    Object.values(this.userBanks).forEach(bank => {
      if (bank.depositedNum > 0) {
        const annualRate = bank.apy;
        const secondsPerYear = 365 * 86400;
        const accrued = (bank.depositedNum * annualRate * 15) / secondsPerYear;
        bank.accruedInterest += accrued;
      }
    });

    this.stocks.forEach(stock => {
      const deltaPercent = (Math.random() - 0.48) * 0.02;
      stock.price = Math.max(0.5, +(stock.price * (1 + deltaPercent)).toFixed(2));
      stock.history.push(stock.price);
      if (stock.history.length > 20) stock.history.shift();
      const first = stock.history[0];
      stock.change24h = +(((stock.price - first) / first) * 100).toFixed(1);
    });

    const tickHours = 15 / 3600;
    const accrualCapHours = CONFIG.ECONOMY.INCOME_ACCRUAL_CAP_HOURS || 24;

    this.plots.forEach(plot => {
      if (plot.isClaimed && plot.health == null) { plot.maxHealth = plot.isCastle ? 1000 : 100; plot.health = plot.maxHealth; }
      // Income properties accrue rent every tick until the owner collects.
      if (plot.isClaimed && plot.building?.incomePerHour > 0) {
        const stats = plot.building.stats || (plot.building.stats = {});
        const cap = plot.building.incomePerHour * accrualCapHours;
        const current = Number(stats.accruedIncome) || 0;
        stats.accruedIncome = +Math.min(cap, current + plot.building.incomePerHour * tickHours).toFixed(6);
      }
      if (plot.isClaimed && plot.nftState?.stage !== 'pending') this._tickPlotResources(plot, tickHours);
    });

    let militaryChanged = false;
    Object.entries(this.playerArmies).forEach(([owner, armies]) => {
      if (!Array.isArray(armies)) return;
      armies.forEach(army => {
        if (army.status !== 'idle' && army.arrivesAt && Date.parse(army.arrivesAt) <= Date.now()) {
          army.locationPlotId = army.targetPlotId;
          if (army.siegeTarget) this.resolveSiege(army);
          else { army.targetPlotId = null; army.route = []; army.status = 'idle'; army.arrivesAt = null; army.originPlotId = null; army.startedAt = null; army.travelMs = null; }
          militaryChanged = true;
        }
      });
    });
    if (militaryChanged) this.scheduleSave();

    if (Date.now() - this._lastResourceSaveAt > 60000) {
      this._lastResourceSaveAt = Date.now();
      this.scheduleSave();
    }

    this._flushMiningRewards();
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                            */
  /* ------------------------------------------------------------------ */

  getAllPlots() {
    return this.plots;
  }

  getPlotById(id) {
    return this.plots.find(p => p.id === id);
  }

  getJobForPlot(plotId) {
    return mintQueue.getJobForPlot(plotId);
  }

  /* ------------------------------------------------------------------ */
  /* Deed claims                                                        */
  /* ------------------------------------------------------------------ */

  claimPlot(plotId, username = "danie") {
    const plot = this.getPlotById(plotId);
    if (!plot) throw new Error("Plot not found");
    if (plot.nftState?.stage === 'pending' || plot.pendingJobId) {
      throw new Error(`A deed mint for this plot is already awaiting confirmation`);
    }
    if (plot.isClaimed) throw new Error(`Plot is already claimed by @${plot.owner}`);

    const cleanUsername = String(username || '').trim().toLowerCase();
    const user = userManager.getUser(cleanUsername);
    if (!user) throw new Error('Create or log in to an account before claiming land');

    const cost = Number(plot.price) || CONFIG.ECONOMY.PLOT_CLAIM_PRICE_NUM;
    const balance = chainLedger.getBalance(cleanUsername).available;
    if (balance < cost) {
      throw new Error(`Insufficient Numista Coin balance. Required: ${cost.toLocaleString()} NUM, Available: ${balance.toFixed(2)} NUM`);
    }

    // Deterministic building + immutable metadata.
    const building = this._claimBuilding(plot, cost);
    const resourceSeed = plot.id;
    const resourceDeposits = generateResourceDeposits(resourceSeed, plot.rarity);

    const assetId = deedAssetId(plot.id);
    const metadata = deedMetadata({ ...plot, buildingType: building.type });
    saveDeedMetadata(assetId, metadata);
    // Existing metadata is immutable, so a re-claimed deed keeps its original committed hash.
    const hash = readDeedMetadata(assetId)?.metadataHash || metadataHash(metadata);

    const snapshot = {
      plotId: plot.id,
      cost,
      building,
      resourceSeed,
      resourceDeposits,
      stockpile: { wood: 24, iron: 6, tin: 0, copper: 0, silver: 0, gold: 0 },
      metadataHash: hash,
      isClaimed: false,
      owner: null,
      nftState: { ...plot.nftState }
    };

    const registrationSteps = this._registrationSteps([cleanUsername, TREASURY]);
    chainLedger.lock(cleanUsername, cost);

    let job;
    try {
      job = mintQueue.enqueue({
      type: 'claim',
      username: cleanUsername,
      plotId: plot.id,
      assetId,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot,
      meta: { name: plot.name, rarityName: plot.rarityName },
      steps: [
        ...registrationSteps,
        {
          key: 'payment',
          label: `Pay ${cost.toLocaleString()} NUM deed price`,
          operation: {
          accountIndex: 0,
          kind: 'transfer',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            from: cleanUsername,
            to: TREASURY,
            amountUnits: toUnits(cost)
          },
          compensate: {
            kind: 'transfer',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            from: TREASURY,
            to: cleanUsername,
            amountUnits: toUnits(cost)
          }
        },
        {
          key: 'create',
          label: 'Create deed asset (collectible, cap 1)',
          operation: {
          accountIndex: 0,
          kind: 'create_asset',
            assetId,
            assetType: DEED_ASSET_TYPE,
            maxSupply: 1,
            metadataHash: hash
          },
          compensate: null
        },
        {
          key: 'mint',
          label: 'Mint deed to owner',
          operation: {
          accountIndex: 0,
          kind: 'mint',
            assetId,
            assetType: DEED_ASSET_TYPE,
            recipient: cleanUsername,
            amountUnits: 1
          },
          compensate: {
            kind: 'transfer',
            assetId,
            assetType: DEED_ASSET_TYPE,
            from: cleanUsername,
            to: TREASURY,
            amountUnits: 1
          }
        }
      ]
      });
    } catch (err) {
      chainLedger.unlock(cleanUsername, cost);
      registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
      throw err;
    }

    // Optimistic state: the plot is reserved while the mint confirms.
    plot.isClaimed = true;
    plot.owner = cleanUsername;
    plot.building = building;
    plot.structures = [{ type: 'peasant_lodge', name: 'Peasant Lodge', level: 1, builtAt: new Date().toISOString() }];
    plot.resourceSeed = resourceSeed;
    plot.resourceDeposits = resourceDeposits;
    plot.stockpile = { ...snapshot.stockpile };
    plot.lastResourceAt = new Date().toISOString();
    plot.pendingJobId = job.id;
    plot.nftState = {
      stage: 'pending',
      assetId,
      tokenId: assetId,
      metadataHash: hash,
      mintedAt: null,
      txHash: null,
      blockHeight: null,
      confirmations: 0,
      jobId: job.id,
      pendingSince: new Date().toISOString()
    };

    this.scheduleSave();

    return {
      plot,
      job: mintQueue.publicJob(job),
      pending: true,
      message: `Claim submitted for ${plot.name} (${plot.rarityName}). ` +
        `Deed mints on-chain and confirms after ${REQUIRED_CONFIRMATIONS} blocks.`
    };
  }

  /* ------------------------------------------------------------------ */
  /* Income properties                                                  */
  /* ------------------------------------------------------------------ */

  collectPlotIncome(plotId, username = "danie") {
    const plot = this.getPlotById(plotId);
    if (!plot || !plot.isClaimed) throw new Error("Plot is not claimed yet");
    if (plot.nftState?.stage === 'pending') {
      throw new Error("This deed is still confirming â€” income collection unlocks once it is on-chain");
    }
    if ((plot.owner || '').replace(/^@/, '').toLowerCase() !== (username || '').replace(/^@/, '').toLowerCase()) {
      throw new Error("Only the deed owner can collect this property's income");
    }

    const building = plot.building;
    if (!building || !(building.incomePerHour > 0)) {
      throw new Error("This property does not generate rental income");
    }

    const stats = building.stats || (building.stats = {});
    const accrued = Number(stats.accruedIncome) || 0;
    if (accrued <= 0.0001) throw new Error("No income accrued yet â€” check back shortly");

    let multiplier = 1;
    if (building.variableYield) {
      // Monopoly-style utility payout: two dice, 2-12, normalised around 7.
      multiplier = (this.rollD6() + this.rollD6()) / 7;
    }

    const amount = +Math.max(0, accrued * multiplier).toFixed(4);
    const clean = String(username || '').toLowerCase();

    const snapshot = {
      plotId: plot.id,
      accrued,
      amount,
      multiplier: +multiplier.toFixed(3),
      totalBefore: Number(stats.totalIncomeCollected) || 0
    };

    const job = this._enqueueNumTransfer({
      type: 'income',
      from: TREASURY,
      to: clean,
      amount,
      description: `Pay ${amount.toLocaleString()} NUM rental income`,
      snapshot: { ...snapshot, username: clean, plotId: plot.id },
      meta: { plotId: plot.id, name: plot.name, building: building.name }
    });

    stats.accruedIncome = 0;
    chainLedger.addPending(clean, amount);
    this.scheduleSave();

    return {
      amount,
      multiplier: +multiplier.toFixed(3),
      rolledDice: building.variableYield ? Math.round(multiplier * 7) : null,
      pending: true,
      job: mintQueue.publicJob(job),
      plot,
      walletBalance: chainLedger.getBalance(clean).available,
      message: `Collecting ${amount.toLocaleString()} NUM â€” it settles after ${REQUIRED_CONFIRMATIONS} blocks`
    };
  }

  collectAllIncome(username = "danie") {
    const clean = String(username || '').replace(/^@/, '').toLowerCase();
    const mine = this.plots.filter(p => p.isClaimed && p.nftState?.stage !== 'pending' && (p.owner || '').replace(/^@/, '').toLowerCase() === clean);
    if (!mine.length) throw new Error('No confirmed deeds owned yet');
    let total = 0; const plotAccruals = [];
    mine.forEach(p => {
      const st = p.building?.stats;
      const acc = Number(st?.accruedIncome) || 0;
      if (acc > 0.0001) {
        const mult = p.building?.variableYield ? (this.rollD6() + this.rollD6()) / 7 : 1;
        const payout = +(acc * mult).toFixed(4);
        total += payout;
        plotAccruals.push({ plotId: p.id, accrued: acc, payout, totalBefore: Number(st.totalIncomeCollected) || 0 });
      }
    });
    const amount = +total.toFixed(4);
    if (!(amount > 0.0001)) throw new Error('No income accrued yet across your deeds');
    const collectedIds = plotAccruals.map(item => item.plotId);
    const job = this._enqueueNumTransfer({
      type: 'income',
      from: TREASURY,
      to: clean,
      amount,
      description: 'Collect ' + amount.toLocaleString() + ' NUM across ' + collectedIds.length + ' deeds',
      snapshot: { username: clean, amount, plotIds: collectedIds, plotAccruals },
      meta: { count: collectedIds.length, plotIds: collectedIds }
    });
    for (const saved of plotAccruals) {
      const plot = this.getPlotById(saved.plotId);
      if (plot?.building?.stats) plot.building.stats.accruedIncome = 0;
    }
    chainLedger.addPending(clean, amount);
    this.scheduleSave();
    return { amount, count: collectedIds.length, plotIds: collectedIds, pending: true, job: mintQueue.publicJob(job), walletBalance: chainLedger.getBalance(clean).available, message: 'Collecting ' + amount.toLocaleString() + ' NUM across ' + collectedIds.length + ' deeds in 1 transaction' };
  }

  upgradePlot(plotId, username = "danie") {
    const plot = this.getPlotById(plotId);
    if (!plot || !plot.isClaimed) throw new Error("Plot is not claimed yet");
    if (mintQueue.getJobForPlot(plotId)) throw new Error("A transaction for this plot is already confirming");
    if (plot.nftState?.stage === 'pending') throw new Error("This deed is still confirming");
    if ((plot.owner || '').replace(/^@/, '').toLowerCase() !== (username || '').replace(/^@/, '').toLowerCase()) {
      throw new Error("Only the deed owner can upgrade this property");
    }
    if (plot.building?.type === 'town_hall' || plot.building?.category === 'institution') {
      throw new Error("Institutional landmarks cannot be upgraded");
    }

    const building = plot.building;
    if (!building || !(building.baseIncomePerHour > 0)) {
      throw new Error("This property cannot be upgraded");
    }

    const maxLevel = CONFIG.ECONOMY.UPGRADE_MAX_LEVEL || 5;
    if (building.level >= maxLevel) throw new Error(`Property is already at max level (${maxLevel})`);

    const clean = String(username || '').toLowerCase();
    const cost = upgradeCostFor(plot.price, building.level);
    const balance = chainLedger.getBalance(clean).available;
    if (balance < cost) {
      throw new Error(`Insufficient balance to upgrade. Required: ${cost.toLocaleString()} NUM`);
    }

    const snapshot = { plotId: plot.id, levelBefore: building.level, incomeBefore: building.incomePerHour, cost };

    chainLedger.lock(clean, cost);
    building.level += 1;
    building.incomePerHour = incomePerHourFor(building.baseIncomePerHour, building.level);
    if (plot.structures?.[0]?.type === 'peasant_lodge') plot.structures[0].level = building.level;

    const job = mintQueue.enqueue({
      type: 'upgrade',
      username: clean,
      plotId: plot.id,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot,
      meta: { name: plot.name, level: building.level },
      steps: [
        ...this._registrationSteps([clean]),
        {
          key: 'payment',
          label: `Pay ${cost.toLocaleString()} NUM upgrade`,
          operation: {
          accountIndex: 0,
          kind: 'transfer',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            from: clean,
            to: TREASURY,
            amountUnits: toUnits(cost)
          },
          compensate: {
            kind: 'transfer',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            from: TREASURY,
            to: clean,
            amountUnits: toUnits(cost)
          }
        }
      ]
    });

    this.scheduleSave();

    return {
      plot,
      cost,
      level: building.level,
      incomePerHour: building.incomePerHour,
      pending: true,
      job: mintQueue.publicJob(job),
      walletBalance: chainLedger.getBalance(clean).available
    };
  }

  rollD6() {
    return 1 + Math.floor(Math.random() * 6);
  }

  /* ------------------------------------------------------------------ */
  /* Mints and civic income                                            */
  /* ------------------------------------------------------------------ */

  mintCoin({ metal, weightGrams, purity, mintPlotId, username }) {
    const mint = this.getPlotById(mintPlotId);
    if (!mint || !mint.isClaimed) throw new Error("Mint plot is not owned by anyone yet");
    if (mint.building?.category !== 'mint') throw new Error("Selected plot is not a mint");
    if (mint.building.metal !== metal) {
      throw new Error(`This mint strikes ${mint.building.metal}, not ${metal}`);
    }

    const weight = Number(weightGrams);
    if (!weight || weight <= 0) throw new Error("Enter a valid coin weight in grams");
    if (weight > 1000) throw new Error("Maximum single coin weight is 1000g");

    const purityValue = Math.min(0.9999, Math.max(0.5, Number(purity) || 0.999));
    const feeRate = CONFIG.ECONOMY.MINT_FEE_PER_GRAM?.[metal] ?? 0.1;
    const fee = +(weight * feeRate).toFixed(4);

    const admin = userManager.getUser(username);
    if (!admin) throw new Error('Admin account required');
    const owner = userManager.getUser(mint.owner);
    const payer = String(username || '').toLowerCase();
    const recipient = owner && owner.username !== payer ? owner.username : TREASURY;
    const coin = {
      id: `NUM-${metal.toUpperCase()}-${randomUUID().slice(0, 8)}`,
      metal,
      weightGrams: weight,
      purity: purityValue,
      mintPlotId: mint.id,
      mintLabel: mint.label,
      mintedBy: username,
      fee,
      createdAt: new Date().toISOString()
    };

    const job = this._enqueueNumTransfer({
      type: 'mint_issue',
      from: payer,
      to: recipient,
      amount: fee,
      description: `Minting fee Â· ${weight}g ${metal} at ${mint.label}`,
      snapshot: { coin }
    });
    return { pending: true, coin, job: mintQueue.publicJob(job) };
  }

    async listPlotForSale(plotId, username, priceNum) {
      const plot = this.getPlotById(plotId);
      const seller = String(username || '').replace(/^@/, '').toLowerCase();
      const price = Number(priceNum);
      if (!plot?.isClaimed || plot.nftState?.stage !== 'onchain') throw new Error('Only a confirmed deed can be listed');
      if (String(plot.owner || '').replace(/^@/, '').toLowerCase() !== seller) throw new Error('Only the plot owner can list this plot');
      if (plot.marketSaleJobId) throw new Error('A plot sale is already confirming');
      if (!Number.isFinite(price) || price < 1) throw new Error('Price must be at least 1 NUM');
      if (this.auctions.some(auction => auction.status === 'active' && auction.category === 'Land Plot' && auction.assetRef === plotId)) {
        throw new Error('This plot already has an active auction');
      }
      const deedId = deedAssetId(plotId);
      if (Number(await chainAdapter.getAssetBalance(deedId, seller)) < 1) throw new Error('The deed is not held by your on-chain account');
      plot.marketListing = { priceNum: +price.toFixed(4), seller, listedAt: new Date().toISOString() };
      this.scheduleSave();
      return plot;
    }

    async buyListedPlot(plotId, buyerUsername) {
      const plot = this.getPlotById(plotId);
      const listing = plot?.marketListing;
      if (!plot?.isClaimed || !listing) throw new Error('Plot is not listed for sale');
      const buyer = String(buyerUsername || '').replace(/^@/, '').toLowerCase();
      const seller = String(listing.seller || '').replace(/^@/, '').toLowerCase();
      if (!buyer || buyer === seller || String(plot.owner || '').replace(/^@/, '').toLowerCase() !== seller) {
        throw new Error('Cannot buy this listing');
      }
      if (plot.marketSaleJobId) throw new Error('This plot sale is already confirming');
      const deedId = deedAssetId(plotId);
      if (Number(await chainAdapter.getAssetBalance(deedId, seller)) < 1) throw new Error('The deed is no longer held by the seller on-chain');
      const gross = Number(listing.priceNum);
      const taxAmount = +(gross * CONFIG.ECONOMY.SECONDARY_MARKET_TAX_RATE).toFixed(4);
      const sellerProceeds = +(gross - taxAmount).toFixed(4);
      const job = this._enqueueMarketplaceSale({
        type: 'plot_sale', from: buyer, to: seller, grossAmount: gross,
        sellerAmount: sellerProceeds, taxAmount, category: 'Land Plot',
        assetRef: plotId, plotId
      });
      plot.marketSaleJobId = job.id;
      this.scheduleSave();
      return { plot, gross, taxAmount, sellerProceeds, job: mintQueue.publicJob(job) };
    }

    async createUniversalAuction({ seller, category, assetRef, title, startingBid, buyoutPrice, durationHours }) {
      const clean = String(seller || '').replace(/^@/, '').toLowerCase();
      const cat = String(category || 'Land Plot');
      const ref = String(assetRef || '').trim();
      const supported = new Set(['Land Plot', 'Pre-1920 Coin', 'Peerage Title']);
      if (!clean || !supported.has(cat)) throw new Error('This marketplace currently supports plots, minted coins, and peerage titles');
      if (!ref) throw new Error('Choose an asset to list');
      if (!(await this._ownsMarketplaceAsset(cat, ref, clean))) throw new Error('You do not own this asset');
      if (this.auctions.some(auction => auction.status === 'active' && auction.category === cat && auction.assetRef === ref)) {
        throw new Error('This asset already has an active auction');
      }
      if (cat === 'Land Plot' && this.getPlotById(ref)?.marketListing) throw new Error('This plot already has a direct sale listing');
      const start = Number(startingBid);
      const buyout = Number(buyoutPrice) > 0 ? Number(buyoutPrice) : null;
      const hrs = Number(durationHours);
      if (!Number.isFinite(start) || start < 0.05 || (buyout !== null && buyout < start) || !Number.isFinite(hrs) || hrs < 1 || hrs > 168) {
        throw new Error('Enter a valid starting bid, buyout, and duration (1–168 hours)');
      }
      const auction = {
        id: `auc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title: String(title || `${cat}: ${ref}`).slice(0, 90), category: cat,
        assetRef: ref, plotId: cat === 'Land Plot' ? ref : null,
        seller: clean, currentBid: +start.toFixed(4), highestBidder: null,
        buyoutPrice: buyout === null ? null : +buyout.toFixed(4),
        endsAt: new Date(Date.now() + hrs * 3600000).toISOString(), bidsCount: 0, status: 'active'
      };
      this.auctions.unshift(auction);
      this.scheduleSave();
      return auction;
    }

    async _ownsMarketplaceAsset(category, assetRef, username) {
      if (category === 'Land Plot') {
        const plot = this.getPlotById(assetRef);
        return !!plot?.isClaimed && plot.nftState?.stage === 'onchain' &&
          String(plot.owner || '').replace(/^@/, '').toLowerCase() === username &&
          Number(await chainAdapter.getAssetBalance(deedAssetId(assetRef), username)) >= 1;
      }
      if (category === 'Pre-1920 Coin') {
        return this.mintLedger.some(batch => (batch.coins || [batch]).some(coin =>
          coin.serial === assetRef && String(coin.owner || '').replace(/^@/, '').toLowerCase() === username));
      }
      if (category === 'Peerage Title') return this.playerTitles[username] === assetRef;
      return false;
    }

    _transferAuctionAsset(auction, buyer) {
      const seller = String(auction.seller || '').replace(/^@/, '').toLowerCase();
      const recipient = String(buyer || '').replace(/^@/, '').toLowerCase();
      if (auction.category === 'Land Plot') {
        const plot = this.getPlotById(auction.assetRef);
        if (!plot || String(plot.owner || '').replace(/^@/, '').toLowerCase() !== seller) throw new Error('Auction plot ownership changed before settlement');
        plot.owner = recipient;
        if (plot.isCastle) {
          plot.castleOwner = recipient;
          plot.controller = recipient;
        }
        plot.marketListing = null;
        plot.marketSaleJobId = null;
      } else if (auction.category === 'Pre-1920 Coin') {
        const coin = this.mintLedger.flatMap(batch => batch.coins || [batch]).find(item => item.serial === auction.assetRef);
        if (!coin || String(coin.owner || '').replace(/^@/, '').toLowerCase() !== seller) throw new Error('Auction coin ownership changed before settlement');
        coin.owner = recipient;
      } else if (auction.category === 'Peerage Title') {
        if (this.playerTitles[seller] !== auction.assetRef) throw new Error('Auction title ownership changed before settlement');
        this.playerTitles[recipient] = this.playerTitles[seller];
        delete this.playerTitles[seller];
      } else {
        throw new Error('Unsupported auction asset type');
      }
      auction.status = 'settled';
      auction.settlementJobId = null;
    }

    async buyoutAuction(auctionId, buyerUsername) {
      this.sweepExpiredAuctions();
      const auction = this.auctions.find(item => item.id === auctionId);
      if (!auction || auction.status !== 'active' || Date.now() >= Date.parse(auction.endsAt)) throw new Error('This auction listing has expired');
      if (!auction.buyoutPrice) throw new Error('This listing does not have an instant buyout price');
      if (auction.pendingBidJobId || auction.highestBidder) throw new Error('Buyout is unavailable after a bid has been placed');
      const buyer = String(buyerUsername || '').replace(/^@/, '').toLowerCase();
      const seller = String(auction.seller || '').replace(/^@/, '').toLowerCase();
      if (!buyer || buyer === seller || !(await this._ownsMarketplaceAsset(auction.category, auction.assetRef, seller))) {
        throw new Error('Cannot buy this listing');
      }
      const gross = Number(auction.buyoutPrice);
      const taxAmount = +(gross * CONFIG.ECONOMY.SECONDARY_MARKET_TAX_RATE).toFixed(4);
      const job = this._enqueueMarketplaceSale({
        type: 'auction_buyout', from: buyer, to: seller, grossAmount: gross,
        sellerAmount: +(gross - taxAmount).toFixed(4), taxAmount,
        category: auction.category, assetRef: auction.assetRef,
        plotId: auction.plotId, auctionId: auction.id
      });
      auction.status = 'buyout_pending';
      auction.settlementJobId = job.id;
      this.scheduleSave();
      return { ...auction, job: mintQueue.publicJob(job) };
    }

    sweepExpiredAuctions() {
      const now = Date.now();
      for (const auction of this.auctions) {
        if (auction.status !== 'active' || !auction.endsAt || now < Date.parse(auction.endsAt)) continue;
        if (!auction.highestBidder || !(Number(auction.currentBid) > 0)) {
          auction.status = 'expired';
          continue;
        }
        const seller = String(auction.seller || '').replace(/^@/, '').toLowerCase();
        const buyer = String(auction.highestBidder || '').replace(/^@/, '').toLowerCase();
        const gross = Number(auction.currentBid);
        const taxAmount = +(gross * CONFIG.ECONOMY.SECONDARY_MARKET_TAX_RATE).toFixed(4);
        const sellerAmount = +(gross - taxAmount).toFixed(4);
        const extraSteps = auction.category === 'Land Plot' ? [{
          key: 'asset_transfer', label: `Transfer deed ${auction.assetRef} to @${buyer}`,
          operation: { accountIndex: 0, kind: 'transfer', assetId: deedAssetId(auction.assetRef), assetType: DEED_ASSET_TYPE, from: seller, to: buyer, amountUnits: 1 },
          compensate: { accountIndex: 0, kind: 'transfer', assetId: deedAssetId(auction.assetRef), assetType: DEED_ASSET_TYPE, from: buyer, to: seller, amountUnits: 1 }
        }] : [];
        try {
          const job = this._enqueueNumTransfer({
            type: 'auction_settlement', from: TREASURY, to: seller, amount: sellerAmount,
            description: `Settle auction ${auction.id} to @${seller}`,
            snapshot: { previousBidder: buyer, auctionId: auction.id, category: auction.category, assetRef: auction.assetRef, grossAmount: gross, taxAmount },
            extraSteps
          });
          auction.status = 'settlement_pending';
          auction.settlementJobId = job.id;
          auction.settlementError = null;
        } catch (err) {
          auction.settlementError = err.message;
          console.error(`[auction] Could not queue settlement for ${auction.id}:`, err.message);
        }
      }
      this.scheduleSave();
      return this.auctions;
    }

 mintPreDecimalAssortment({ amountNum, mintPlotId, username }) { const payer = String(username || "").toLowerCase(); if (!payer) throw new Error("Sign in required"); const amount = Number(amountNum); if (!amount || amount < 0.05 || amount > 10000) throw new Error("Enter 0.05 to 10,000 NUM (1 NUM = 1 Pre-Decimal Pound = 20s)"); const mint = mintPlotId ? this.getPlotById(mintPlotId) : null; const COINS = [{ key: "gold_guinea", name: "Gold Guinea (21s)", farthings: 1008, weightG: 7.988, metal: "gold", purity: 0.9167, w: 8 }, { key: "gold_sovereign", name: "Gold Sovereign (20s)", farthings: 960, weightG: 7.988, metal: "gold", purity: 0.9167, w: 24 }, { key: "gold_half_sovereign", name: "Gold Half Sovereign (10s)", farthings: 480, weightG: 3.994, metal: "gold", purity: 0.9167, w: 18 }, { key: "silver_crown", name: "Silver Crown (5s)", farthings: 240, weightG: 28.28, metal: "silver", purity: 0.925, w: 12 }, { key: "silver_half_crown", name: "Silver Half Crown (2s 6d)", farthings: 120, weightG: 14.14, metal: "silver", purity: 0.925, w: 14 }, { key: "silver_florin", name: "Silver Florin (2s)", farthings: 96, weightG: 11.31, metal: "silver", purity: 0.925, w: 12 }, { key: "silver_shilling", name: "Silver Shilling (1s)", farthings: 48, weightG: 5.66, metal: "silver", purity: 0.925, w: 12 }, { key: "silver_sixpence", name: "Silver Sixpence (6d)", farthings: 24, weightG: 2.83, metal: "silver", purity: 0.925, w: 10 }, { key: "silver_threepence", name: "Silver Threepence (3d)", farthings: 12, weightG: 1.41, metal: "silver", purity: 0.925, w: 8 }, { key: "bronze_penny", name: "Bronze Penny (1d)", farthings: 4, weightG: 9.45, metal: "bronze", purity: 0.95, w: 4 }, { key: "bronze_halfpenny", name: "Bronze Halfpenny (1/2d)", farthings: 2, weightG: 5.67, metal: "bronze", purity: 0.95, w: 2 }, { key: "bronze_farthing", name: "Bronze Farthing (1/4d)", farthings: 1, weightG: 2.83, metal: "bronze", purity: 0.95, w: 1 }]; let rem = Math.round(amount * 960); const counts = new Map(); while (rem > 0) { const ok = COINS.filter(c => c.farthings <= rem); const tw = ok.reduce((s, c) => s + c.w, 0); let r = Math.random() * tw, acc = 0, pick = ok.at(0); for (const c of ok) { acc += c.w; if (r <= acc) { pick = c; break; } } rem -= pick.farthings; counts.set(pick.key, (counts.get(pick.key) || 0) + 1); } const assortment = COINS.filter(c => counts.has(c.key)).map(c => { const count = counts.get(c.key); return { key: c.key, name: c.name, count, metal: c.metal, purity: c.purity, weightGrams: +(c.weightG * count).toFixed(3), valueNum: +((c.farthings * count) / 960).toFixed(6) }; }); const ERAS = [{ rarity: "Common", badge: "common", mult: 1, w: 60, picks: [{ year: 1918, ruler: "George V" }, { year: 1915, ruler: "George V" }, { year: 1911, ruler: "George V (Coronation)" }, { year: 1907, ruler: "Edward VII" }, { year: 1899, ruler: "Victoria (Veiled Head)" }] }, { rarity: "Uncommon", badge: "uncommon", mult: 1.5, w: 24, picks: [{ year: 1887, ruler: "Victoria (Golden Jubilee)" }, { year: 1872, ruler: "Victoria (Young Head)" }, { year: 1853, ruler: "Victoria (Young Head)" }] }, { rarity: "Rare", badge: "rare", mult: 3, w: 11, picks: [{ year: 1831, ruler: "William IV" }, { year: 1826, ruler: "George IV" }, { year: 1821, ruler: "George IV (Laureate)" }] }, { rarity: "Ultra Rare", badge: "ultra_rare", mult: 7, w: 4, picks: [{ year: 1817, ruler: "George III (Bull Head)" }, { year: 1797, ruler: "George III (Soho Mint)" }, { year: 1787, ruler: "George III (Spade)" }] }, { rarity: "Mythic", badge: "mythic", mult: 20, w: 1, picks: [{ year: 1703, ruler: "Queen Anne (VIGO)" }, { year: 1694, ruler: "William & Mary" }, { year: 1663, ruler: "Charles II (First Milled)" }] }]; const mintedCoins = []; const batchId = "PRE-1920-" + randomUUID(); let seq = this.mintLedger.length * 100 + 1; for (const item of assortment) { for (let k = 0; k < item.count; k++) { const pk = deriveDeterministicCoinEra(payer + ":" + Date.now(), seq); const era = pk; mintedCoins.push({ serial: "COIN-" + pk.year + "-" + batchId.slice(-8) + "-" + String(seq++).padStart(6, "0"), name: item.name, year: pk.year, ruler: pk.ruler, rarity: era.rarity, badge: era.badge, collectorMult: era.mult, metal: item.metal, purity: item.purity, weightGrams: +(item.weightGrams / item.count).toFixed(3), faceValueNum: +(item.valueNum / item.count).toFixed(6), owner: payer }); } } const batch = { id: batchId, era: "Pre-1920 British Pre-Decimal (1 NUM = 20s)", amountNum: +((Math.round(amount * 960)) / 960).toFixed(6), mintPlotId: mint?.id || "ROYAL_MINT_LONDON", mintLabel: mint?.label || "Royal Mint (Pre-1920 Standard)", mintedBy: payer, assortment, coins: mintedCoins, createdAt: new Date().toISOString() }; const mintOwner = mint && mint.isClaimed && mint.owner && String(mint.owner).toLowerCase() !== payer ? String(mint.owner).toLowerCase() : null; const ownerCut = mintOwner ? +(batch.amountNum * 0.10).toFixed(4) : 0; const vaultCut = +(batch.amountNum - ownerCut).toFixed(4); if (ownerCut > 0) this._enqueueNumTransfer({ type: "mint_commission", from: payer, to: mintOwner, amount: ownerCut, description: "10% Royal Mint Commission - " + batch.id }); const job = this._enqueueNumTransfer({ type: "predecimal_mint", from: payer, to: TREASURY, amount: vaultCut, description: "Pre-1920 Mint - " + batch.amountNum + " NUM", snapshot: { coin: batch } }); return { pending: true, batch, assortment, coins: mintedCoins, job: mintQueue.publicJob(job) }; }
  getMintLedger(limit = 100) {
    return this.mintLedger.slice(0, limit);
  }

  claimTownHallTaxes(plotId, username = "danie") {
    const plot = this.getPlotById(plotId);
    if (!plot || !plot.building || plot.building.type !== 'town_hall') {
      throw new Error("Plot does not feature a Town Hall");
    }

    const stats = plot.building.stats;
    const treasury = Number(stats.treasuryBalance) || 0;
    if (treasury <= 0) throw new Error("Town Hall treasury is currently empty");

    const clean = String(username || '').toLowerCase();
    const job = this._enqueueNumTransfer({
      type: 'town_hall',
      from: TREASURY,
      to: clean,
      amount: treasury,
      description: `Pay ${treasury.toLocaleString()} NUM municipal tax dividend`,
      snapshot: { plotId: plot.id, username: clean, treasuryBefore: treasury },
      meta: { plotId: plot.id, name: plot.name }
    });

    stats.treasuryBalance = 0;
    stats.subsidiesDistributed = (stats.subsidiesDistributed || 0) + treasury;
    chainLedger.addPending(clean, treasury);
    this.scheduleSave();

    return {
      claimedAmount: treasury,
      remainingTreasury: 0,
      pending: true,
      job: mintQueue.publicJob(job),
      newBalance: chainLedger.getBalance(clean).available
    };
  }

  /* ------------------------------------------------------------------ */
  /* Bank / stocks / auctions (NUM movements settle on-chain)           */
  /* ------------------------------------------------------------------ */

  _userBank(username) {
    const clean = String(username || '').toLowerCase();
    if (!this.userBanks[clean]) {
      this.userBanks[clean] = {
        depositedNum: 0,
        apy: CONFIG.ECONOMY.BANK_BASE_APY,
        accruedInterest: 0,
        lastInterestCalc: Date.now()
      };
    }
    return this.userBanks[clean];
  }

  getBankInfo(username) {
    const clean = String(username || '').toLowerCase();
    const bank = this._userBank(clean);
    const pendingWithdraw = this._activeJobs('bank_withdraw', job => job.snapshot?.username === clean)
      .reduce((sum, job) => sum + Number(job.snapshot?.amount || 0), 0);
    const pendingDeposit = this._activeJobs('bank_deposit', job => job.snapshot?.from === clean)
      .reduce((sum, job) => sum + Number(job.snapshot?.amount || 0), 0);
    return {
      ...bank,
      pendingDeposit,
      pendingWithdraw,
      availableToWithdraw: Math.max(0, bank.depositedNum - pendingWithdraw)
    };
  }

  _enqueueNumTransfer({ type, from, to, amount, description, snapshot = {}, meta = {}, extraSteps = [], idempotencyKey = null }) {
    if (idempotencyKey) {
      const existing = [...mintQueue.jobs, ...mintQueue.history].find(job => job.idempotencyKey === idempotencyKey);
      if (existing) return existing;
    }
    const value = +Number(amount || 0).toFixed(4);
    if (!from || !to || from === to) throw new Error('Invalid on-chain transfer parties');
    if (!(value > 0)) throw new Error('Invalid transfer amount');
    if (chainLedger.getBalance(from).available < value) throw new Error('Insufficient blockchain balance');

    const registrationSteps = this._registrationSteps([from, to, snapshot.previousBidder]);
    chainLedger.lock(from, value);
    try {
      const job = mintQueue.enqueue({
        type,
        username: from,
        assetId: NUM_ASSET_ID,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        snapshot: { ...snapshot, amount: value, from, to },
        meta: { name: description, ...meta },
        idempotencyKey,
        steps: [...registrationSteps, {
          key: 'transfer',
          label: description,
          operation: {
          accountIndex: 0,
          kind: 'transfer',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            from,
            to,
            amountUnits: toUnits(value)
          },
          compensate: {
            kind: 'transfer',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            from: to,
            to: from,
            amountUnits: toUnits(value)
          }
        }, ...extraSteps]
      });
      return job;
    } catch (err) {
      chainLedger.unlock(from, value);
      registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
      throw err;
    }
  }

  _enqueueMarketplaceSale({
    type,
    from,
    to,
    grossAmount,
    sellerAmount,
    taxAmount,
    category,
    assetRef,
    plotId = null,
    auctionId = null
  }) {
    const gross = +Number(grossAmount).toFixed(4);
    const sellerNet = +Number(sellerAmount).toFixed(4);
    const tax = +Number(taxAmount).toFixed(4);
    if (!from || !to || from === to || !(gross > 0) || sellerNet < 0 || tax < 0 ||
        Math.abs(gross - sellerNet - tax) > 0.0001) {
      throw new Error('Invalid marketplace transaction amounts');
    }
    if (chainLedger.getBalance(from).available < gross) {
      throw new Error('Insufficient blockchain balance');
    }

    const registrationSteps = this._registrationSteps([from, to, TREASURY]);
    const steps = [...registrationSteps];
    const transferStep = (key, label, assetId, assetType, sender, recipient, amountUnits) => ({
      key,
      label,
      operation: { accountIndex: 0, kind: 'transfer', assetId, assetType, from: sender, to: recipient, amountUnits },
      compensate: { accountIndex: 0, kind: 'transfer', assetId, assetType, from: recipient, to: sender, amountUnits }
    });

    if (sellerNet > 0) {
      steps.push(transferStep('seller_payment', `Pay @${to} for ${assetRef}`, NUM_ASSET_ID, CURRENCY_ASSET_TYPE, from, to, toUnits(sellerNet)));
    }
    if (tax > 0) {
      steps.push(transferStep('market_tax', 'Pay marketplace tax', NUM_ASSET_ID, CURRENCY_ASSET_TYPE, from, TREASURY, toUnits(tax)));
    }
    if (category === 'Land Plot') {
      const assetId = deedAssetId(plotId || assetRef);
      steps.push(transferStep('asset_transfer', `Transfer deed ${assetRef} to @${from}`, assetId, DEED_ASSET_TYPE, to, from, 1));
    }

    chainLedger.lock(from, gross);
    try {
      return mintQueue.enqueue({
        type,
        username: from,
        plotId,
        assetId: category === 'Land Plot' ? deedAssetId(plotId || assetRef) : NUM_ASSET_ID,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        snapshot: {
          from,
          to,
          amount: gross,
          sellerAmount: sellerNet,
          taxAmount: tax,
          category,
          assetRef,
          plotId,
          auctionId
        },
        meta: { name: `Marketplace sale: ${assetRef}` },
        steps
      });
    } catch (err) {
      chainLedger.unlock(from, gross);
      registrationSteps.forEach(step => this.pendingUsernameRegistrations.delete(step.operation.username));
      throw err;
    }
  }

  _registrationSteps(usernames) {
    const unique = [...new Set(usernames.filter(Boolean).map(name => String(name).toLowerCase()))];
    const missing = unique.filter(name => !chainLedger.getUsernameRecord(name));
    const alreadyPending = missing.find(name => this.pendingUsernameRegistrations.has(name));
    if (alreadyPending) throw new Error(`On-chain username registration for @${alreadyPending} is already pending`);

    return missing.map(username => {
      this.pendingUsernameRegistrations.add(username);
      return {
        key: `register_${username}`,
        label: `Register @${username} on-chain`,
        operation: {
          accountIndex: 0,
          kind: 'register_username',
          username,
          key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
        },
        compensate: null
      };
    });
  }

  _recordRegistrations(job) {
    job.steps
      .filter(step => step.operation?.kind === 'register_username')
      .forEach(step => {
        this.pendingUsernameRegistrations.delete(step.operation.username);
        if (step.status === 'confirmed') {
          chainLedger.markUsernameRegistered(step.operation.username, {
            key: step.operation.key,
            jobId: job.id
          });
        }
      });
  }

  _activeJobs(type, matches) {
    return [...mintQueue.jobs, ...mintQueue.history].filter(job =>
      job.type === type &&
      !job.gameApplied &&
      !['confirmed', 'reverted', 'failed'].includes(job.status) &&
      matches(job)
    );
  }

  bankDeposit(amount, username) {
    const value = Number(amount);
    if (value <= 0) throw new Error("Invalid deposit amount");
    const clean = String(username || '').toLowerCase();
    const bank = this._userBank(clean);
    const job = this._enqueueNumTransfer({
      type: 'bank_deposit',
      from: clean,
      to: TREASURY,
      amount: value,
      description: `Deposit ${value} NUM to Numista Bank Vault`
    });
    return { ...bank, pending: true, job: mintQueue.publicJob(job) };
  }

  bankWithdraw(amount, username) {
    const value = Number(amount);
    if (value <= 0) throw new Error("Invalid withdraw amount");
    const clean = String(username || '').toLowerCase();
    const bank = this._userBank(clean);
    const pending = this._activeJobs('bank_withdraw', job => job.snapshot?.username === clean)
      .reduce((sum, job) => sum + Number(job.snapshot?.amount || 0), 0);
    if (bank.depositedNum - pending < value) throw new Error("Withdraw exceeds deposited funds");

    const job = this._enqueueNumTransfer({
      type: 'bank_withdraw',
      from: TREASURY,
      to: clean,
      amount: value,
      description: `Withdraw ${value} NUM from Numista Bank Vault`,
      snapshot: { username: clean }
    });
    return { ...bank, pending: true, job: mintQueue.publicJob(job) };
  }

  bankClaimInterest(username) {
    const clean = String(username || '').toLowerCase();
    const bank = this._userBank(clean);
    if (this._activeJobs('bank_interest', job => job.snapshot?.username === clean).length) {
      throw new Error('An interest claim is already pending');
    }
    const accrued = bank.accruedInterest;
    if (accrued <= 0.0001) throw new Error("No interest to claim yet");

    const amount = +accrued.toFixed(4);
    bank.accruedInterest = +(accrued - amount).toFixed(6);
    let job;
    try {
      job = this._enqueueNumTransfer({
        type: 'bank_interest',
        from: TREASURY,
        to: clean,
        amount,
        description: `Pay ${amount.toLocaleString()} NUM bank interest`,
        snapshot: { username: clean, accruedBefore: accrued }
      });
    } catch (err) {
      bank.accruedInterest = accrued;
      throw err;
    }
    chainLedger.addPending(clean, amount);

    return {
      claimed: amount,
      pending: true,
      job: mintQueue.publicJob(job),
      bank
    };
  }

  placeBid(auctionId, bidAmount, username) {
    this.sweepExpiredAuctions();
    const auc = this.auctions.find(a => a.id === auctionId);
    if (!auc || auc.status !== 'active' || Date.now() >= new Date(auc.endsAt).getTime()) throw new Error("This auction listing has expired");
    if (String(auc.seller || '').replace(/^@/, '').toLowerCase() === String(username || '').replace(/^@/, '').toLowerCase()) {
      throw new Error('You cannot bid on your own listing');
    }
    if (bidAmount <= auc.currentBid) {
      throw new Error(`Bid must exceed current highest bid (${auc.currentBid} NUM)`);
    }

    const clean = String(username || '').toLowerCase();
    const previousBid = Number(auc.currentBid) || 0;
    const previousBidder = auc.highestBidder;
    const transferAmount = previousBidder === clean ? bidAmount - previousBid : bidAmount;
    const refundAmount = previousBidder && previousBidder !== clean ? previousBid : 0;
    const refundSteps = refundAmount > 0 ? [{
      key: 'refund_previous_bid',
      label: `Refund ${refundAmount} NUM to @${previousBidder}`,
      operation: {
          accountIndex: 0,
          kind: 'transfer',
        assetId: NUM_ASSET_ID,
        assetType: CURRENCY_ASSET_TYPE,
        from: TREASURY,
        to: previousBidder,
        amountUnits: toUnits(refundAmount)
      },
      compensate: {
        kind: 'transfer',
        assetId: NUM_ASSET_ID,
        assetType: CURRENCY_ASSET_TYPE,
        from: previousBidder,
        to: TREASURY,
        amountUnits: toUnits(refundAmount)
      }
    }] : [];

    if (auc.pendingBidJobId || this._activeJobs('auction_bid', job => job.snapshot?.auctionId === auc.id).length) {
      throw new Error('Another bid is still confirming for this auction');
    }
    if (refundAmount > 0 && chainLedger.getBalance(TREASURY).available < refundAmount) {
      throw new Error('The previous on-chain escrow is not available for refund');
    }
    const job = this._enqueueNumTransfer({
      type: 'auction_bid',
      from: clean,
      to: TREASURY,
      amount: transferAmount,
      description: `Bid on auction #${auc.id}`,
      snapshot: {
        username: clean,
        auctionId: auc.id,
        bidAmount: Number(bidAmount),
        previousBid,
        previousBidder,
        refundAmount
      },
      extraSteps: refundSteps
    });
    if (refundAmount > 0) chainLedger.lock(TREASURY, refundAmount);
    auc.pendingBidJobId = job.id;
    this.scheduleSave();
    return { ...auc, pending: true, job: mintQueue.publicJob(job) };
  }

  tradeStock(ticker, action, shares, username) {
    const stock = this.stocks.find(s => s.ticker === ticker);
    if (!stock) throw new Error("Stock ticker not found");
    if (shares <= 0) throw new Error("Invalid shares count");

    const totalCost = +(stock.price * shares).toFixed(2);
    const brokerFee = +(totalCost * 0.015).toFixed(2);
    const tax = +(totalCost * 0.01).toFixed(2);
    const clean = String(username || '').toLowerCase();
    const portfolio = this.userStocks[clean] || (this.userStocks[clean] = {});

    if (action === 'buy') {
      const needed = totalCost + brokerFee + tax;
      const job = this._enqueueNumTransfer({
        type: 'stock_buy',
        from: clean,
        to: TREASURY,
        amount: needed,
        description: `Buy ${shares} shares of ${ticker}`,
        snapshot: { username: clean, ticker, shares, tax, brokerFee }
      });
      return { stock, ownedShares: portfolio[ticker] || 0, portfolio, pending: true, job: mintQueue.publicJob(job) };
    } else if (action === 'sell') {
      const owned = Number(portfolio[ticker]) || 0;
      const pending = this._activeJobs('stock_sell', job =>
        job.snapshot?.username === clean && job.snapshot?.ticker === ticker
      ).reduce((sum, job) => sum + Number(job.snapshot?.shares || 0), 0);
      if (owned - pending < shares) throw new Error(`You only own ${owned - pending} shares of ${ticker}`);
      const proceeds = +(totalCost - brokerFee - tax).toFixed(2);
      const job = this._enqueueNumTransfer({
        type: 'stock_sell',
        from: TREASURY,
        to: clean,
        amount: proceeds,
        description: `Pay proceeds for ${shares} shares of ${ticker}`,
        snapshot: { username: clean, ticker, shares, tax, brokerFee }
      });
      return { stock, ownedShares: portfolio[ticker] || 0, portfolio, pending: true, job: mintQueue.publicJob(job) };
    } else {
      throw new Error('Invalid stock trade action');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mining rewards (batched into on-chain treasury transfers)          */
  /* ------------------------------------------------------------------ */

  creditMiningReward(username, amount, reference = '') {
    const clean = String(username || '').toLowerCase();
    const value = Number(amount) || 0;
    if (value <= 0) return null;

    const current = this.pendingMining.get(clean) || { amount: 0, shares: 0, lastRef: null };
    current.amount = round(current.amount + value);
    current.shares += 1;
    current.lastRef = reference || current.lastRef;
    this.pendingMining.set(clean, current);

    this._flushMiningRewards();
    return { pendingMining: current.amount };
  }

  _flushMiningRewards() {
    const threshold = CONFIG.ECONOMY.MINING_PAYOUT_THRESHOLD || 1;
    for (const [username, reward] of [...this.pendingMining.entries()]) {
      if (reward.amount < threshold) continue;
      if (mintQueue.jobs.some(j => j.type === 'mining' && j.username === username)) continue;

      const amount = +reward.amount.toFixed(4);
      if (chainLedger.getBalance(TREASURY).available < amount) continue;

      try {
        const job = this._enqueueNumTransfer({
          type: 'mining',
          from: TREASURY,
          to: username,
          amount,
          description: `Pay ${amount} NUM browser mining reward`,
          snapshot: { username, shares: reward.shares }
        });
        chainLedger.addPending(username, amount);
        this.pendingMining.delete(username);
        if (job) this.scheduleSave();
      } catch (err) {
        console.error(`[mining] Could not queue @${username} reward:`, err.message);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Username transfers & external credits                              */
  /* ------------------------------------------------------------------ */

  transferToUser(fromUsername, toUsername, amount) {
    const from = String(fromUsername || '').toLowerCase();
    const to = String(toUsername || '').toLowerCase();
    const value = +Number(amount || 0).toFixed(4);

    if (!from || !to) throw new Error('Sender and recipient are required');
    if (from === to) throw new Error('You cannot transfer to yourself');
    if (!userManager.getUser(to)) throw new Error(`@${to} is not a registered player`);
    if (!(value > 0)) throw new Error('Enter a valid transfer amount');
    if (chainLedger.getBalance(from).available < value) {
      throw new Error('Insufficient balance');
    }

    const job = this._enqueueNumTransfer({
      type: 'transfer',
      from,
      to,
      amount: value,
      description: `Transfer ${value} NUM to @${to}`,
      snapshot: { amount: value, to, from },
      meta: { name: `@${from} â†’ @${to}` }
    });

    return {
      pending: true,
      amount: value,
      to,
      job: mintQueue.publicJob(job),
      walletBalance: chainLedger.getBalance(from).available
    };
  }

  creditExternal() {
    throw new Error('NUM cannot be credited without verified payment settlement');
  }

  /* ------------------------------------------------------------------ */
  /* Job callbacks                                                      */
  /* ------------------------------------------------------------------ */

  _applyBattleSettlement(job) {
    const report = job.snapshot?.report;
    if (!report || this.battleLog.some(b => b.battleId === report.battleId)) return;
    const plot = this.getPlotById(report.plotId);
    const armies = this.playerArmies[report.attacker] || [];
    const army = armies.find(a => a.id === report.armyId);
    if (!plot || !army) throw new Error('Battle target or army no longer exists; chain report confirmed but local settlement needs recovery');
    plot.health = Math.max(0, report.plotHealthBefore - report.plotDamage);
    const rosterByOwner = { [report.attacker]: this.playerSoldiers[report.attacker] || [], [report.defender]: this.playerSoldiers[report.defender] || [] };
    for (const event of report.casualtyEvents || []) {
      const owner = event.side === 'defender' ? report.defender : report.attacker;
      const roster = rosterByOwner[owner] || [];
      const soldier = roster.find(s => s.id === event.soldierId);
      if (!soldier) continue;
      soldier.hp = Math.max(0, soldier.hp - Number(event.damage || 0));
      if (soldier.hp <= 0) {
        roster.splice(roster.indexOf(soldier), 1);
        for (const formation of (Array.isArray(this.playerArmies[owner]) ? this.playerArmies[owner] : [])) formation.soldierIds = formation.soldierIds.filter(id => id !== soldier.id);
      }
    }
    for (const wear of report.equipmentWear || []) {
      const owner = wear.side === 'defender' ? report.defender : report.attacker;
      const soldier = (rosterByOwner[owner] || []).find(s => s.id === wear.soldierId);
      if (!soldier) continue;
      for (const slot of ['weapon', 'armor', 'helmet']) {
        const item = soldier[slot];
        if (!item || item.health === undefined) continue;
        item.health = Math.max(0, Number(item.health) - Number(wear[slot] || 0));
      }
      refreshSoldierMaxHp(soldier);
    }
    if (plot.isCastle) plot.garrison = Math.max(0, Number(report.defenderState?.garrison || 0) - Number(report.garrisonDamage || 0));
    const mint = job.steps.find(step => step.key === 'mint' && !step.compensation);
    const result = { ...report, assetId: job.assetId, txHash: mint?.txHash || null, blockHeight: mint?.confirmedHeight || null, confirmations: job.requiredConfirmations, chainStatus: 'confirmed', casualties: (report.casualtyEvents || []).filter(e => e.killed).length };
    this.battleLog.unshift(result); this.battleLog = this.battleLog.slice(0, 500);
    army.pendingBattleId = null; army.locationPlotId = plot.id; army.originPlotId = null; army.startedAt = null; army.travelMs = null;
    if (report.captured && army.soldierIds.length) {
      plot.controller = report.attacker;
      if (plot.isCastle) { plot.castleOwner = report.attacker; plot.garrison = Math.max(1, Math.floor(army.soldierIds.length / 2)); plot.building = { ...plot.building, name: `Castle Keep - ${plot.name}`, type: 'castle_keep', category: 'military', garrison: plot.garrison }; }
      plot.health = Math.floor((plot.maxHealth || (plot.isCastle ? 1000 : 100)) * 0.35);
      army.targetPlotId = null; army.route = []; army.status = 'idle'; army.arrivesAt = null; army.siegeTarget = false; plot.siege = null;
    } else if (!army.soldierIds.length) {
      army.targetPlotId = null; army.route = []; army.status = 'idle'; army.arrivesAt = null; army.siegeTarget = false; plot.siege = null;
    } else {
      army.status = 'besieging'; army.arrivesAt = new Date(Date.now() + 60000).toISOString();
      plot.siege = { attacker: report.attacker, armyId: army.id, nextBattleAt: army.arrivesAt };
    }
    this.scheduleSave();
  }

  _onJobConfirmed(job) {
    if (job.gameApplied && job.type !== 'battle_settlement') return;
    if (job.type === 'battle_settlement' && this.battleLog.some(b => b.battleId === job.snapshot?.report?.battleId)) return;
    if (this.seasonStartedAt && Date.parse(job.createdAt || 0) < Date.parse(this.seasonStartedAt)) {
      // Retired-season transactions may settle on chain, but their old game
      // effects do not carry into the current world.
      job.gameApplied = true;
      mintQueue._saveSoon();
      return;
    }
    job.gameApplied = true;
    this._recordRegistrations(job);

    const username = job.username;
    const found = key => job.steps.find(s => s.key === key && !s.compensation);

    try {
      if (job.type === 'army_silver_payroll') {
        const snapshot = job.snapshot || {};
        const army = (this.playerArmies[username] || []).find(item => item.id === snapshot.armyId);
        const target = this.getPlotById(snapshot.targetPlotId);
        const soldiers = (this.playerSoldiers[username] || []).filter(s => snapshot.soldierIds?.includes(s.id));
        if (!army || army.status !== 'payroll_pending' || !target || !soldiers.length) {
          if (army) {
            army.status = 'payroll_recovery';
            army.payrollError = 'Silver payment confirmed, but the army or destination could not be restored.';
            this.scheduleSave();
          }
          console.error(`[army] Confirmed silver payroll ${job.id} could not start its march`);
          return;
        }
        const from = this.getPlotById(army.locationPlotId);
        if (!from) {
          army.status = 'payroll_recovery';
          army.payrollError = 'Silver payment confirmed, but the army origin plot is missing.';
          this.scheduleSave();
          return;
        }
        const plan = {
          army,
          from,
          target,
          soldiers,
          route: snapshot.route || [target.id],
          distance: Number(snapshot.distanceTiles) || 1,
          speed: Math.max(1, Math.min(...soldiers.map(s => Number(s.speed) || 1)))
        };
        const transfer = job.steps.find(step => step.key.startsWith('silver_pay_') && !step.compensation);
        this._startArmyMarch(plan, true, {
          jobId: job.id,
          silverFineGrams: Number(snapshot.silverFineGrams) || 0,
          distanceTiles: Number(snapshot.distanceTiles) || 0,
          txHash: transfer?.txHash || null,
          paidAt: new Date().toISOString()
        });
        army.payrollJobId = null;
        army.payrollError = null;
        return;
      }
      if (job.type === 'battle_settlement') {
        this._applyBattleSettlement(job);
        this.scheduleSave();
        return;
      }
      if (job.type === 'plot_metal_mint' || job.type === 'plot_resource_mint') {
        this.scheduleSave();
        return;
      }
      if (job.type === 'currency_mint') {
        const amount = Number(job.snapshot?.amount) || 0;
        const mintStep = found('mint');
        chainLedger.dropPending(username, amount);
        chainLedger.receiveChain(username, amount);
        chainLedger.recordChainMove({
          username,
          amount,
          description: `Native NUM conversion settled (${mintStep?.txHash?.slice(0, 10) || 'chain'}...)`,
          txHash: mintStep?.txHash,
          height: mintStep?.confirmedHeight,
          jobId: job.id,
          assetId: job.assetId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'treasury_block_reward') {
        const amount = Number(job.snapshot?.amount) || 0;
        const mintStep = found('mint');
        chainLedger.dropPending(username, amount);
        chainLedger.receiveChain(username, amount);
        chainLedger.recordChainMove({
          username,
          amount,
          description: `Block reward (#${job.snapshot?.fromHeight}-#${job.snapshot?.toHeight})`,
          txHash: mintStep?.txHash,
          height: mintStep?.confirmedHeight,
          jobId: job.id,
          assetId: job.assetId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'deposit') {
        const amount = Number(job.snapshot?.amount) || 0;
        const mintStep = found('mint');
        chainLedger.dropPending(username, amount);
        chainLedger.receiveChain(username, amount);
        chainLedger.recordChainMove({
          username,
          amount,
          description: `Native NUM deposit settled (${job.snapshot?.depositTxHash?.slice(0, 10) || 'chain'}...)`,
          txHash: mintStep?.txHash || job.snapshot?.depositTxHash,
          height: mintStep?.confirmedHeight,
          jobId: job.id,
          assetId: job.assetId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'plot_sale' || job.type === 'auction_buyout') {
        const snapshot = job.snapshot || {};
        const from = String(snapshot.from || username || '').toLowerCase();
        const to = String(snapshot.to || '').toLowerCase();
        const gross = Number(snapshot.amount) || 0;
        const sellerAmount = Number(snapshot.sellerAmount) || 0;
        const taxAmount = Number(snapshot.taxAmount) || 0;
        chainLedger.settleSpend(from, gross);
        chainLedger.receiveChain(to, sellerAmount);
        if (taxAmount > 0) chainLedger.receiveChain(TREASURY, taxAmount);
        const payment = job.steps.find(step => step.key === 'seller_payment');
        const tax = job.steps.find(step => step.key === 'market_tax');
        chainLedger.recordChainMove({
          username: from, amount: -gross, description: `Marketplace purchase: ${snapshot.assetRef}`,
          txHash: payment?.txHash || tax?.txHash, jobId: job.id, plotId: snapshot.plotId
        });
        if (sellerAmount > 0) chainLedger.recordChainMove({
          username: to, amount: sellerAmount, description: `Marketplace sale: ${snapshot.assetRef}`,
          txHash: payment?.txHash, jobId: job.id, plotId: snapshot.plotId
        });
        if (taxAmount > 0) chainLedger.recordChainMove({
          username: TREASURY, amount: taxAmount, description: `Marketplace tax: ${snapshot.assetRef}`,
          txHash: tax?.txHash, jobId: job.id, plotId: snapshot.plotId
        });

        const auction = snapshot.auctionId
          ? this.auctions.find(item => item.id === snapshot.auctionId)
          : null;
        if (auction) this._transferAuctionAsset(auction, from);
        else {
          const plot = this.getPlotById(snapshot.plotId);
          if (plot && String(plot.owner || '').replace(/^@/, '').toLowerCase() === to) {
            plot.owner = from;
            if (plot.isCastle) {
              plot.castleOwner = from;
              plot.controller = from;
            }
            plot.marketListing = null;
            plot.marketSaleJobId = null;
          }
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'claim') {
        const plot = this.getPlotById(job.plotId);
        if (!plot) return;
        const payment = found('payment');
        const mint = found('mint');
        const amount = job.snapshot?.cost || 0;

        chainLedger.settleSpend(username, amount);
        chainLedger.receiveChain(TREASURY, amount);
        job.steps
          .filter(step => step.operation?.kind === 'register_username' && step.status === 'confirmed')
          .forEach(step => chainLedger.markUsernameRegistered(step.operation.username, {
            key: step.operation.key,
            jobId: job.id
          }));
        if (payment) {
          chainLedger.recordChainMove({
            username,
            amount: -amount,
            description: `Land deed purchase: ${plot.name}`,
            txHash: payment.txHash,
            height: payment.confirmedHeight,
            jobId: job.id,
            plotId: plot.id,
            assetId: job.assetId
          });
          chainLedger.recordChainMove({
            username: TREASURY,
            amount,
            description: `Deed payment received: ${plot.name}`,
            txHash: payment.txHash,
            height: payment.confirmedHeight,
            jobId: job.id,
            plotId: plot.id,
            assetId: NUM_ASSET_ID
          });
        }
        if (mint) {
          chainLedger.recordChainMove({
            username,
            amount: 0,
            description: `Deed minted on-chain: ${plot.name}`,
            txHash: mint.txHash,
            height: mint.confirmedHeight,
            jobId: job.id,
            plotId: plot.id,
            assetId: job.assetId,
            direction: 'deed'
          });
        }

        plot.isClaimed = true;
        plot.owner = plot.isCastle ? (plot.castleOwner || TREASURY) : username;
        plot.building = plot.building || job.snapshot?.building || this._claimBuilding(plot, amount);
        if (job.snapshot?.resourceDeposits) {
          plot.resourceSeed = job.snapshot.resourceSeed;
          plot.resourceDeposits = { ...job.snapshot.resourceDeposits };
          if (job.snapshot.stockpile) plot.stockpile = { ...job.snapshot.stockpile };
        }
        plot.pendingJobId = null;
        plot.nftState = {
          stage: 'onchain',
          assetId: job.assetId,
          tokenId: job.assetId,
          metadataHash: job.snapshot?.metadataHash ||
            plot.nftState?.metadataHash ||
            readDeedMetadata(job.assetId)?.metadataHash ||
            metadataHash(deedMetadata({ ...plot, buildingType: plot.building?.type || null })),
          mintedAt: new Date().toISOString(),
          txHash: mint?.txHash || null,
          blockHeight: mint?.confirmedHeight || null,
          confirmations: job.requiredConfirmations,
          jobId: job.id,
          confirmedAt: new Date().toISOString()
        };

        this.scheduleSave();
        return;
      }

      if (['income', 'town_hall', 'bank_interest', 'mining'].includes(job.type)) {
        const amount = Number(job.snapshot?.amount) || 0;
        const from = job.snapshot?.from || TREASURY;
        const to = job.snapshot?.to || job.snapshot?.username || username;
        chainLedger.settleSpend(from, amount);
        chainLedger.dropPending(to, amount);
        chainLedger.receiveChain(to, amount);
        const transfer = job.steps.find(s => s.key === 'transfer' && !s.compensation);
        chainLedger.recordChainMove({
          username: from,
          amount: -amount,
          description: job.type === 'income'
            ? `Rental income paid: ${job.meta?.name || job.plotId || 'property'}`
            : job.type === 'town_hall'
              ? `Town Hall dividend paid: ${job.meta?.name || 'municipality'}`
              : job.type === 'mining'
                ? 'Browser mining reward paid'
                : 'Bank interest paid',
          txHash: transfer?.txHash,
          height: transfer?.confirmedHeight,
          jobId: job.id,
          plotId: job.plotId,
          assetId: job.assetId
        });
        chainLedger.recordChainMove({
          username: to,
          amount,
          description: job.type === 'income'
            ? `Rental income: ${job.meta?.name || job.plotId || 'property'}`
            : job.type === 'town_hall'
              ? `Town Hall tax dividend: ${job.meta?.name || 'municipality'}`
              : job.type === 'mining'
                ? 'Browser mining reward'
                : 'Bank staking yield',
          txHash: transfer?.txHash,
          height: transfer?.confirmedHeight,
          jobId: job.id,
          plotId: job.plotId,
          assetId: job.assetId
        });

        if (job.type === 'income' && job.plotId) {
          const plot = this.getPlotById(job.plotId);
          if (plot?.building?.stats) {
            plot.building.stats.totalIncomeCollected = +((Number(plot.building.stats.totalIncomeCollected) || 0) + amount).toFixed(4);
            plot.building.stats.lastCollectedAt = new Date().toISOString();
          }
        }
        if (job.type === 'income' && Array.isArray(job.snapshot?.plotAccruals)) {
          const collectedAt = new Date().toISOString();
          for (const saved of job.snapshot.plotAccruals) {
            const plot = this.getPlotById(saved.plotId);
            if (!plot?.building?.stats) continue;
            plot.building.stats.totalIncomeCollected = +((Number(plot.building.stats.totalIncomeCollected) || 0) + Number(saved.payout || 0)).toFixed(4);
            plot.building.stats.lastCollectedAt = collectedAt;
          }
        }
        if (job.type === 'town_hall' && job.plotId) {
          const plot = this.getPlotById(job.plotId);
          if (plot?.building?.stats) {
            plot.building.stats.treasuryBalance = 0;
            plot.building.stats.subsidiesDistributed =
              (plot.building.stats.subsidiesDistributed || 0) + amount;
          }
        }

        this.scheduleSave();
        return;
      }

      if (job.type === 'upgrade') {
        const plot = this.getPlotById(job.plotId);
        const amount = Number(job.snapshot?.cost) || 0;
        chainLedger.settleSpend(username, amount);
        chainLedger.receiveChain(TREASURY, amount);
        const payment = job.steps.find(s => s.key === 'payment');
        chainLedger.recordChainMove({
          username,
          amount: -amount,
          description: `Upgrade to L${job.meta?.level || '?'}: ${plot?.name || job.plotId}`,
          txHash: payment?.txHash,
          height: payment?.confirmedHeight,
          jobId: job.id,
          plotId: job.plotId
        });
        if (plot) this._applySettlementMilestone(plot, job.meta?.level);
        this.scheduleSave();
        return;
      }

      if (job.type === 'transfer') {
        const amount = Number(job.snapshot?.amount) || 0;
        const to = job.snapshot?.to;
        chainLedger.settleSpend(username, amount);
        if (to) chainLedger.receiveChain(to, amount);
        const step = job.steps.find(s => s.key === 'transfer');
        chainLedger.recordChainMove({
          username,
          amount: -amount,
          description: `Sent to @${to}`,
          txHash: step?.txHash,
          height: step?.confirmedHeight,
          jobId: job.id
        });
        chainLedger.recordChainMove({
          username: to,
          amount,
          description: `Received from @${username}`,
          txHash: step?.txHash,
          height: step?.confirmedHeight,
          jobId: job.id
        });
        this.scheduleSave();
        return;
      }

      if (['bank_deposit', 'bank_withdraw', 'auction_bid', 'auction_settlement', 'stock_buy', 'stock_sell', 'mint_issue', 'predecimal_mint', 'soldier_recruit', 'title_purchase', 'onramp_purchase'].includes(job.type)) {
        const amount = Number(job.snapshot?.amount) || 0;
        const from = job.snapshot?.from;
        const to = job.snapshot?.to;
        chainLedger.settleSpend(from, amount);
        chainLedger.receiveChain(to, amount);
        const transfer = job.steps.find(s => s.key === 'transfer' && !s.compensation);
        chainLedger.recordChainMove({
          username: from,
          amount: -amount,
          description: job.meta?.name || `Sent to @${to}`,
          txHash: transfer?.txHash,
          height: transfer?.confirmedHeight,
          jobId: job.id
        });
        chainLedger.recordChainMove({
          username: to,
          amount,
          description: `Received from @${from}`,
          txHash: transfer?.txHash,
          height: transfer?.confirmedHeight,
          jobId: job.id
        });

        if (job.type === 'bank_deposit' || job.type === 'bank_withdraw') {
          const bank = this._userBank(job.snapshot?.username || from);
          bank.depositedNum = Math.max(0, +(bank.depositedNum + (job.type === 'bank_deposit' ? amount : -amount)).toFixed(4));
        } else if (job.type === 'auction_bid') {
          const auc = this.auctions.find(item => item.id === job.snapshot?.auctionId);
          const refundAmount = Number(job.snapshot?.refundAmount) || 0;
          const previousBidder = job.snapshot?.previousBidder;
          if (refundAmount > 0) {
            chainLedger.settleSpend(TREASURY, refundAmount);
            chainLedger.receiveChain(previousBidder, refundAmount);
            const refund = job.steps.find(s => s.key === 'refund_previous_bid');
            chainLedger.recordChainMove({
              username: TREASURY,
              amount: -refundAmount,
              description: `Refund previous bid on auction #${auc?.id || job.snapshot?.auctionId}`,
              txHash: refund?.txHash,
              height: refund?.confirmedHeight,
              jobId: job.id
            });
            chainLedger.recordChainMove({
              username: previousBidder,
              amount: refundAmount,
              description: `Outbid refund for auction #${auc?.id || job.snapshot?.auctionId}`,
              txHash: refund?.txHash,
              height: refund?.confirmedHeight,
              jobId: job.id
            });
          }
          if (auc) {
            auc.currentBid = Number(job.snapshot?.bidAmount) || 0;
            auc.highestBidder = job.snapshot?.username;
            auc.bidsCount += 1;
            auc.pendingBidJobId = null;
            auc.escrowOnChain = true;
          }
        } else if (job.type === 'auction_settlement') {
          const auc = this.auctions.find(item => item.id === job.snapshot?.auctionId);
          if (auc) this._transferAuctionAsset(auc, job.snapshot?.previousBidder);
        } else if (job.type === 'stock_buy' || job.type === 'stock_sell') {
          const portfolio = this.userStocks[job.snapshot?.username] || (this.userStocks[job.snapshot?.username] = {});
          const delta = Number(job.snapshot?.shares) || 0;
          portfolio[job.snapshot?.ticker] = Math.max(0, (Number(portfolio[job.snapshot?.ticker]) || 0) +
            (job.type === 'stock_buy' ? delta : -delta));
        } else if (job.type === 'mint_issue') {
          const coin = job.snapshot?.coin;
          if (coin) {
            this.mintLedger.unshift(coin);
            if (this.mintLedger.length > 500) this.mintLedger.pop();
          }
        } else if (job.type === 'predecimal_mint') {
          const coinBatch = job.snapshot?.coin;
          if (coinBatch && !this.mintLedger.some(batch => batch.id === coinBatch.id)) {
            this.mintLedger.unshift(coinBatch);
            if (this.mintLedger.length > 500) this.mintLedger.pop();
            const coinOwner = String(coinBatch.mintedBy || '').replace(/^@/, '').toLowerCase();
            if (coinOwner) this.playerCoinPurses[coinOwner] = round(Number(this.playerCoinPurses[coinOwner] || 0) + Number(coinBatch.amountNum || 0), 6);
          }
        } else if (job.type === 'soldier_recruit') {
          const recruitUser = String(job.snapshot?.username || from || '').toLowerCase();
          const specs = { levy: { name: 'Levy Spearman', hp: 100, attack: 6, defense: 2, speed: 1 }, archer: { name: 'Bowman', hp: 75, attack: 8, defense: 1, speed: 1 }, cavalry: { name: 'Light Cavalry', hp: 130, attack: 12, defense: 5, speed: 2 } };
          const spec = specs[job.snapshot?.unitType];
          if (spec) {
            const roster = this.playerSoldiers[recruitUser] || (this.playerSoldiers[recruitUser] = []);
            this.playerArmies[recruitUser] ||= [];
            for (let i = 0; i < Number(job.snapshot?.count || 0); i++) {
              roster.push({ id: randomUUID(), name: `${spec.name} ${roster.length + 1}`, type: job.snapshot.unitType, hp: spec.hp, maxHp: spec.hp, baseMaxHp: spec.hp, attack: spec.attack, defense: spec.defense, speed: spec.speed, weapon: null, armor: null, helmet: null, homePlotId: this.plots.find(p => p.isClaimed && String(p.owner || '').replace(/^@/, '').toLowerCase() === recruitUser)?.id || this.plots.find(p => p.isCastle)?.id || null, armyId: null, recruitedAt: new Date().toISOString() });
            }
          }
        } else if (job.type === 'title_purchase') {
          const titleUsername = String(job.snapshot?.username || from || '').replace(/^@/, '').toLowerCase();
          const title = job.snapshot?.title || String(job.meta?.name || '').match(/Royal (?:Peerage|Title):\s*(.+)$/i)?.[1];
          if (titleUsername && title) this.playerTitles[titleUsername] = title;
        }

        this.scheduleSave();
        return;
      }
    } finally {
      // Queue persistence records that this job's game effects are applied.
      mintQueue._saveSoon();
    }
  }

  async _recoverFailedNativeDeposit(job) {
    if (this.nativeDepositRetries.has(job.id)) return;
    this.nativeDepositRetries.add(job.id);
    const username = String(job.username || '').toLowerCase();
    const amount = Number(job.snapshot?.amount) || 0;
    const maxAttempts = 5;
    const attempts = Number(job.snapshot?.recoveryAttempts) || 0;

    try {
      if (!(amount > 0) || !username) throw new Error('Deposit recovery record is incomplete');
      if (!['live', 'simulate'].includes(chainAdapter.mode)) throw new Error(`Chain unavailable: ${chainAdapter.reason}`);
      const currentUnits = Number(await chainAdapter.getAssetBalance(job.assetId, username));
      const baselineUnits = Number(job.snapshot?.balanceBeforeUnits) || 0;
      const credited = Math.min(amount, Math.max(0, currentUnits - baselineUnits) / CONFIG.CHAIN.UNITS_PER_NUM);
      if (credited > 0) {
        chainLedger.settlePending(username, credited);
        chainLedger.recordChainMove({
          username,
          amount: credited,
          description: 'Native NUM deposit recovered after mint job failure',
          txHash: job.steps.find(step => step.key === 'mint')?.txHash || job.snapshot?.nativeTxHash,
          jobId: job.id,
          assetId: job.assetId
        });
      }

      const remaining = +(amount - credited).toFixed(4);
      if (remaining <= 0) {
        job.gameApplied = true;
        mintQueue._saveSoon();
        return;
      }
      if (attempts >= maxAttempts) {
        job.gameApplied = true;
        console.error(`[deposit] Recovery retries exhausted for ${job.id}; ${remaining} NUM remains pending`);
        mintQueue._saveSoon();
        return;
      }

      const steps = job.steps
        .filter(step => !step.compensation && step.operation)
        .map(step => ({
          key: step.key,
          label: step.label,
          operation: step.key === 'mint'
            ? { ...step.operation, amountUnits: toUnits(remaining) }
            : { ...step.operation }
        }));
      if (!steps.some(step => step.key === 'mint')) throw new Error('Deposit recovery job has no mint operation');
      const next = mintQueue.enqueue({
        type: 'deposit',
        username,
        assetId: job.assetId,
        snapshot: {
          ...job.snapshot,
          amount: remaining,
          balanceBeforeUnits: currentUnits,
          recoveryAttempts: attempts + 1
        },
        meta: { name: `Retry native NUM deposit conversion (${attempts + 1}/${maxAttempts})` },
        steps
      });
      job.gameApplied = true;
      mintQueue._saveSoon();
      console.warn(`[deposit] Queued recovery job ${next.id} for failed deposit ${job.id}`);
    } catch (err) {
      job.snapshot ||= {};
      job.snapshot.recoveryAttempts = attempts + 1;
      if (attempts + 1 >= maxAttempts) {
        job.gameApplied = true;
        console.error(`[deposit] Could not recover ${job.id}; its balance remains pending: ${err.message}`);
        mintQueue._saveSoon();
      } else {
        console.error(`[deposit] Recovery attempt ${attempts + 1}/${maxAttempts} failed for ${job.id}: ${err.message}`);
        const timer = setTimeout(() => this._recoverFailedNativeDeposit(job), 5000);
        timer.unref?.();
        mintQueue._saveSoon();
      }
    } finally {
      this.nativeDepositRetries.delete(job.id);
    }
  }

  _onJobReverted(job) {
    if (!job.gameApplied && this.seasonStartedAt && Date.parse(job.createdAt || 0) < Date.parse(this.seasonStartedAt)) {
      job.gameApplied = true;
      mintQueue._saveSoon();
      return;
    }
    if (job.type === 'deposit') {
      this._recoverFailedNativeDeposit(job);
      return;
    }
    if (job.type === 'currency_mint' || job.type === 'treasury_block_reward') {
      chainLedger.dropPending(job.username, Number(job.snapshot?.amount) || 0);
      return;
    }
    if (job.gameApplied) return;
    job.gameApplied = true;
    this._recordRegistrations(job);
    const username = job.username;
    const found = key => job.steps.find(s => s.key === key && !s.compensation);
    const settlementUncertain = job.status === 'revert_failed';

    if (settlementUncertain && job.type === 'army_silver_payroll') {
      const army = (this.playerArmies[username] || []).find(item => item.id === job.snapshot?.armyId);
      if (army) {
        army.status = 'payroll_recovery';
        army.payrollError = 'Silver payment rollback needs reconciliation; this army is blocked from marching.';
        this.scheduleSave();
      }
      console.error(`[army] Silver payroll ${job.id} could not be fully refunded; dispatch blocked`);
      return;
    }

    try {
      if (settlementUncertain) {
        console.error(`[ledger] Job ${job.id} has a failed on-chain compensation; reserved balances remain locked for reconciliation`);
        return;
      }

      if (job.type === 'army_silver_payroll') {
        const army = (this.playerArmies[username] || []).find(item => item.id === job.snapshot?.armyId);
        if (army) {
          army.status = 'idle';
          army.pendingDispatch = null;
          army.payrollJobId = null;
          army.payrollError = job.failure || 'Silver payment failed; no march started.';
          this.scheduleSave();
        }
        return;
      }

      if (job.type === 'battle_settlement') {
        const armies = this.playerArmies[username] || [];
        const army = armies.find(a => a.id === job.snapshot?.report?.armyId);
        if (army) { army.pendingBattleId = null; army.status = 'besieging'; army.arrivesAt = new Date(Date.now() + 60000).toISOString(); }
        const plot = this.getPlotById(job.snapshot?.report?.plotId);
        if (plot) plot.siege = army ? { attacker: username, armyId: army.id, nextBattleAt: army.arrivesAt } : null;
        this.scheduleSave();
        return;
      }

      if (job.type === 'plot_metal_mint') {
        const plot = this.getPlotById(job.plotId);
        const metal = job.snapshot?.metal;
        if (plot && ['silver', 'gold'].includes(metal)) {
          const stockpile = plot.stockpile || (plot.stockpile = {});
          stockpile[metal] = +(Number(stockpile[metal] || 0) + Number(job.snapshot?.weightGrams || 0)).toFixed(9);
        }
        this.scheduleSave();
        return;
      }
      if (job.type === 'plot_resource_mint') {
        const plot = this.getPlotById(job.plotId);
        const resource = job.snapshot?.resource;
        if (plot && PLOT_RESOURCES.includes(resource)) {
          const stockpile = plot.stockpile || (plot.stockpile = {});
          stockpile[resource] = +(Number(stockpile[resource] || 0) + Number(job.snapshot?.amount || 0)).toFixed(9);
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'treasury_block_reward') {
        const amount = Number(job.snapshot?.amount) || 0;
        const mintStep = found('mint');
        chainLedger.dropPending(username, amount);
        chainLedger.receiveChain(username, amount);
        chainLedger.recordChainMove({
          username,
          amount,
          description: `Block reward (#${job.snapshot?.fromHeight}-#${job.snapshot?.toHeight})`,
          txHash: mintStep?.txHash,
          height: mintStep?.confirmedHeight,
          jobId: job.id,
          assetId: job.assetId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'deposit') {
        const amount = Number(job.snapshot?.amount) || 0;
        const mintStep = found('mint');
        chainLedger.dropPending(username, amount);
        chainLedger.receiveChain(username, amount);
        chainLedger.recordChainMove({
          username,
          amount,
          description: `Native NUM deposit settled (${job.snapshot?.depositTxHash?.slice(0, 10) || 'chain'}...)`,
          txHash: mintStep?.txHash || job.snapshot?.depositTxHash,
          height: mintStep?.confirmedHeight,
          jobId: job.id,
          assetId: job.assetId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'claim') {
        const plot = this.getPlotById(job.plotId);
        const amount = Number(job.snapshot?.cost) || 0;
        chainLedger.unlock(username, amount);
        if (plot) {
          plot.isClaimed = false;
          plot.owner = null;
          plot.building = null;
          plot.resourceSeed = plot.id;
          plot.resourceDeposits = generateResourceDeposits(plot.id, plot.rarity);
          plot.stockpile = { wood: 24, iron: 6, tin: 0, copper: 0, silver: 0, gold: 0 };
          plot.structures = [];
          plot.pendingJobId = null;
          plot.nftState = {
            stage: 'failed',
            assetId: deedAssetId(plot.id),
            tokenId: deedAssetId(plot.id),
            metadataHash: null,
            mintedAt: null,
            txHash: null,
            blockHeight: null,
            confirmations: 0,
            failure: job.failure,
            jobId: job.id
          };
        }
        if (amount > 0) {
          chainLedger.recordChainMove({
            username,
            amount,
            description: `Deed claim reverted: ${job.meta?.name || job.plotId}`,
            txHash: null,
            status: 'reverted',
            jobId: job.id,
            plotId: job.plotId
          });
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'income') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.unlock(TREASURY, amount);
        chainLedger.dropPending(job.snapshot?.username || job.snapshot?.to || username, amount);
        if (Array.isArray(job.snapshot?.plotAccruals)) {
          for (const saved of job.snapshot.plotAccruals) {
            const savedPlot = this.getPlotById(saved.plotId);
            const stats = savedPlot?.building?.stats;
            if (!stats) continue;
            // Preserve income earned while the payout was confirming.
            stats.accruedIncome = +(Number(stats.accruedIncome || 0) + Number(saved.accrued || 0)).toFixed(6);
          }
        }
        const plot = this.getPlotById(job.plotId);
        if (!Array.isArray(job.snapshot?.plotAccruals) && plot?.building?.stats && job.snapshot) {
          plot.building.stats.accruedIncome = +(Number(plot.building.stats.accruedIncome || 0) + Number(job.snapshot.accrued || 0)).toFixed(6);
        }
        chainLedger.recordChainMove({
          username,
          amount: 0,
          description: `Income collection reverted: ${job.meta?.name || job.plotId}`,
          status: 'reverted',
          jobId: job.id,
          plotId: job.plotId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'upgrade') {
        const amount = Number(job.snapshot?.cost) || 0;
        chainLedger.unlock(username, amount);
        const plot = this.getPlotById(job.plotId);
        if (plot?.building && job.snapshot) {
          plot.building.level = job.snapshot.levelBefore;
          plot.building.incomePerHour = job.snapshot.incomeBefore;
          if (plot.structures?.[0]) plot.structures[0].level = job.snapshot.levelBefore;
        }
        chainLedger.recordChainMove({
          username,
          amount: 0,
          description: `Upgrade reverted: ${plot?.name || job.plotId}`,
          status: 'reverted',
          jobId: job.id,
          plotId: job.plotId
        });
        this.scheduleSave();
        return;
      }

      if (job.type === 'soldier_recruit') {
        chainLedger.unlock(username, Number(job.snapshot?.cost || job.snapshot?.amount) || 0);
        this.scheduleSave();
        return;
      }

      if (job.type === 'title_purchase') {
        chainLedger.unlock(username, Number(job.snapshot?.amount) || Number(job.snapshot?.price) || 0);
        this.scheduleSave();
        return;
      }

      if (job.type === 'plot_sale' || job.type === 'auction_buyout') {
        const snapshot = job.snapshot || {};
        chainLedger.unlock(snapshot.from || username, Number(snapshot.amount) || 0);
        const auction = snapshot.auctionId
          ? this.auctions.find(item => item.id === snapshot.auctionId)
          : null;
        if (auction) {
          auction.status = 'active';
          auction.settlementJobId = null;
        } else {
          const plot = this.getPlotById(snapshot.plotId);
          if (plot?.marketSaleJobId === job.id) plot.marketSaleJobId = null;
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'auction_settlement') {
        chainLedger.unlock(job.snapshot?.from || TREASURY, Number(job.snapshot?.amount) || 0);
        const auction = this.auctions.find(item => item.id === job.snapshot?.auctionId);
        if (auction) {
          auction.status = 'active';
          auction.settlementJobId = null;
          auction.settlementError = job.failure || 'Settlement failed';
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'town_hall') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.unlock(TREASURY, amount);
        chainLedger.dropPending(job.snapshot?.username || job.snapshot?.to || username, amount);
        const plot = this.getPlotById(job.plotId);
        if (plot?.building?.stats) {
          plot.building.stats.treasuryBalance = +((plot.building.stats.treasuryBalance || 0) + amount).toFixed(2);
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'bank_interest') {
        const amount = Number(job.snapshot?.accruedBefore) || 0;
        chainLedger.unlock(TREASURY, Number(job.snapshot?.amount) || 0);
        chainLedger.dropPending(job.snapshot?.username || job.snapshot?.to || username, Number(job.snapshot?.amount) || 0);
        const bank = this._userBank(job.snapshot?.username || username);
        bank.accruedInterest = +(bank.accruedInterest + amount).toFixed(6);
        return;
      }

      if (job.type === 'mining') {
        const amount = Number(job.snapshot?.amount) || 0;
        const recipient = job.snapshot?.username || job.snapshot?.to || username;
        chainLedger.unlock(TREASURY, amount);
        chainLedger.dropPending(recipient, amount);
        const current = this.pendingMining.get(recipient) || { amount: 0, shares: 0 };
        current.amount = round(current.amount + amount);
        this.pendingMining.set(recipient, current);
        return;
      }

      if (job.type === 'transfer') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.unlock(username, amount);
        chainLedger.recordChainMove({
          username,
          amount: 0,
          description: `Transfer to @${job.snapshot?.to} reverted`,
          status: 'reverted',
          jobId: job.id
        });
        return;
      }

      if (['bank_deposit', 'bank_withdraw', 'stock_buy', 'stock_sell', 'mint_issue', 'predecimal_mint', 'onramp_purchase'].includes(job.type)) {
        chainLedger.unlock(job.snapshot?.from, Number(job.snapshot?.amount) || 0);
        this.scheduleSave();
        return;
      }

      if (job.type === 'auction_bid') {
        chainLedger.unlock(job.snapshot?.from, Number(job.snapshot?.amount) || 0);
        if (Number(job.snapshot?.refundAmount) > 0) chainLedger.unlock(TREASURY, Number(job.snapshot.refundAmount));
        const auc = this.auctions.find(item => item.id === job.snapshot?.auctionId);
        if (auc) auc.pendingBidJobId = null;
        this.scheduleSave();
        return;
        return;
      }
    } finally {
      mintQueue._saveSoon();
    }
  }
}

export const gameStore = new GameStore();
