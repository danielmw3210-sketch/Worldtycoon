import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateGridPlots,
  rollBuildingDeterministic,
  rarityByTier,
  baseIncomeForPrice,
  incomePerHourFor,
  upgradeCostFor
} from './plotGrid.js';
import { CONFIG } from '../config.js';
import { mintQueue } from '../numista/mintQueue.js';
import { userManager } from './users.js';
import { chainLedger } from './chainLedger.js';
import {
  NUM_ASSET_ID,
  CURRENCY_ASSET_TYPE,
  DEED_ASSET_TYPE,
  deedAssetId,
  deedMetadata,
  metadataHash,
  saveDeedMetadata,
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

class GameStore {
  constructor() {
    this.plots = generateGridPlots();
    this.globalTaxPool = 18469.80;
    this.mintLedger = [];
    this.statePath = process.env.NUMISTA_STATE_FILE || path.join(__dirname, 'gameState.json');
    this._saveTimer = null;
    this.pendingMining = new Map();

    // Default Auction House Listings
    this.auctions = [
      {
        id: "auc-001",
        title: "Highland Lithium & Granite Mineral Rights",
        plotId: "UK-HIG-001",
        seller: "scots_pioneer",
        currentBid: 120.00,
        highestBidder: "wharf_capital",
        buyoutPrice: 250.00,
        endsAt: new Date(Date.now() + 86400000 * 2).toISOString(),
        bidsCount: 6,
        category: "Mineral Rights"
      },
      {
        id: "auc-002",
        title: "Ancient Cornish Tin & Silver Smelting Relic NFT",
        plotId: "UK-COR-001",
        seller: "bristol_syndicate",
        currentBid: 85.50,
        highestBidder: "ulster_marine",
        buyoutPrice: 190.00,
        endsAt: new Date(Date.now() + 86400000 * 1.5).toISOString(),
        bidsCount: 9,
        category: "Historic Relic"
      },
      {
        id: "auc-003",
        title: "Radcliffe Architectural Master Blueprint #04",
        plotId: "UK-OXF-001",
        seller: "crown_treasury",
        currentBid: 45.00,
        highestBidder: "manchester_guild",
        buyoutPrice: 110.00,
        endsAt: new Date(Date.now() + 86400000 * 3).toISOString(),
        bidsCount: 3,
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

    this.userBank = {
      depositedNum: 50.0,
      apy: CONFIG.ECONOMY.BANK_BASE_APY,
      accruedInterest: 1.482,
      lastInterestCalc: Date.now()
    };

    this.userStocks = {
      "UK-REIT": 10,
      "NUM-MINE": 5
    };

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
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (raw.globalTaxPool != null) this.globalTaxPool = raw.globalTaxPool;
      if (Array.isArray(raw.mints)) this.mintLedger = raw.mints;

      const byId = new Map(this.plots.map(p => [p.id, p]));
      let restored = 0;
      (raw.plots || []).forEach(saved => {
        const plot = byId.get(saved.id);
        if (!plot) return;
        plot.isClaimed = !!saved.isClaimed;
        plot.owner = saved.owner || null;
        if (saved.building) plot.building = saved.building;
        if (saved.pendingJobId) plot.pendingJobId = saved.pendingJobId;
        plot.nftState = this._normaliseNftState(plot, saved.nftState);
        if (plot.isClaimed) restored++;
      });

      const legacy = this.plots.filter(p => p.nftState?.stage === 'legacy_simulated').length;
      console.log(`[store] Restored ${restored} claimed plots from disk` +
        (legacy ? ` (${legacy} legacy simulated deed(s) marked)` : ''));
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

  saveState() {
    try {
      const payload = {
        savedAt: new Date().toISOString(),
        globalTaxPool: this.globalTaxPool,
        mints: this.mintLedger,
        plots: this.plots
          .filter(p => p.isClaimed || p.pendingJobId || p.nftState?.stage !== 'unminted')
          .map(p => ({
            id: p.id,
            isClaimed: p.isClaimed,
            owner: p.owner,
            pendingJobId: p.pendingJobId || null,
            building: p.building,
            nftState: p.nftState
          }))
      };
      fs.writeFileSync(this.statePath, JSON.stringify(payload), 'utf8');
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
      if (job.gameApplied) continue;
      if (job.status === 'confirmed') {
        this._onJobConfirmed(job);
        recovered++;
      } else if (FAILED_JOB_STATUSES.has(job.status)) {
        this._onJobReverted(job);
        recovered++;
      }
    }
    if (recovered) {
      console.log(`[store] Reconciled ${recovered} completed mint job(s) after restart`);
      this.scheduleSave();
    }
  }

  tickSimulation() {
    if (this.userBank.depositedNum > 0) {
      const annualRate = this.userBank.apy;
      const secondsPerYear = 365 * 86400;
      const accrued = (this.userBank.depositedNum * annualRate * 15) / secondsPerYear;
      this.userBank.accruedInterest += accrued;
    }

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
      if (plot.building && plot.building.type === 'town_hall') {
        const regionalTax = +(Math.random() * 0.25).toFixed(3);
        plot.building.stats.treasuryBalance = +(plot.building.stats.treasuryBalance + regionalTax).toFixed(2);
        plot.building.stats.totalTaxesCollected = +(plot.building.stats.totalTaxesCollected + regionalTax).toFixed(2);
        this.globalTaxPool = +(this.globalTaxPool + regionalTax).toFixed(2);
      }

      // Income properties accrue rent every tick until the owner collects.
      if (plot.isClaimed && plot.building?.incomePerHour > 0) {
        const stats = plot.building.stats || (plot.building.stats = {});
        const cap = plot.building.incomePerHour * accrualCapHours;
        const current = Number(stats.accruedIncome) || 0;
        stats.accruedIncome = +Math.min(cap, current + plot.building.incomePerHour * tickHours).toFixed(6);
      }
    });

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
    const rolled = rollBuildingDeterministic(plot.rarity, plot.id);
    const baseIncomePerHour = baseIncomeForPrice(cost, plot.rarity, rolled.incomeFactor);
    const building = {
      type: rolled.key,
      category: rolled.category,
      name: `${rolled.name} · ${plot.label}`,
      level: 1,
      description: rolled.description,
      adminOnly: !!rolled.adminOnly,
      metal: rolled.metal || null,
      variableYield: !!rolled.variableYield,
      baseIncomePerHour,
      incomePerHour: incomePerHourFor(baseIncomePerHour, 1),
      stats: {
        accruedIncome: 0,
        totalIncomeCollected: 0,
        claimedAt: new Date().toISOString()
      }
    };

    const assetId = deedAssetId(plot.id);
    const metadata = deedMetadata({ ...plot, buildingType: rolled.key });
    const hash = metadataHash(metadata);
    saveDeedMetadata(assetId, metadata);

    const snapshot = {
      plotId: plot.id,
      cost,
      building: null,
      isClaimed: false,
      owner: null,
      nftState: { ...plot.nftState }
    };

    chainLedger.lock(cleanUsername, cost);

    const job = mintQueue.enqueue({
      type: 'claim',
      username: cleanUsername,
      plotId: plot.id,
      assetId,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot,
      meta: { name: plot.name, rarityName: plot.rarityName },
      steps: [
        {
          key: 'payment',
          label: `Pay ${cost.toLocaleString()} NUM deed price`,
          operation: {
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
          key: 'register_player',
          label: `Register @${cleanUsername} on-chain`,
          operation: {
            kind: 'register_username',
            username: cleanUsername,
            key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
          },
          compensate: null
        },
        {
          key: 'register_treasury',
          label: `Register @${TREASURY} on-chain`,
          operation: {
            kind: 'register_username',
            username: TREASURY,
            key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
          },
          compensate: null
        },
        {
          key: 'create',
          label: 'Create deed asset (collectible, cap 1)',
          operation: {
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

    // Optimistic state: the plot is reserved while the mint confirms.
    plot.isClaimed = true;
    plot.owner = cleanUsername;
    plot.building = building;
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
      throw new Error("This deed is still confirming — income collection unlocks once it is on-chain");
    }
    if ((plot.owner || '').toLowerCase() !== (username || '').toLowerCase()) {
      throw new Error("Only the deed owner can collect this property's income");
    }

    const building = plot.building;
    if (!building || !(building.incomePerHour > 0)) {
      throw new Error("This property does not generate rental income");
    }

    const stats = building.stats || (building.stats = {});
    const accrued = Number(stats.accruedIncome) || 0;
    if (accrued <= 0.0001) throw new Error("No income accrued yet — check back shortly");

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

    stats.accruedIncome = 0;
    chainLedger.addPending(clean, amount);

    const job = mintQueue.enqueue({
      type: 'income',
      username: clean,
      plotId: plot.id,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot,
      meta: { name: plot.name, building: building.name },
      steps: [
        {
          key: 'mint_income',
          label: `Mint ${amount.toLocaleString()} NUM rental income`,
          operation: {
            kind: 'mint',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            recipient: clean,
            amountUnits: toUnits(amount)
          },
          compensate: null
        }
      ]
    });

    this.scheduleSave();

    return {
      amount,
      multiplier: +multiplier.toFixed(3),
      rolledDice: building.variableYield ? Math.round(multiplier * 7) : null,
      pending: true,
      job: mintQueue.publicJob(job),
      plot,
      walletBalance: chainLedger.getBalance(clean).available,
      message: `Collecting ${amount.toLocaleString()} NUM — it settles after ${REQUIRED_CONFIRMATIONS} blocks`
    };
  }

  upgradePlot(plotId, username = "danie") {
    const plot = this.getPlotById(plotId);
    if (!plot || !plot.isClaimed) throw new Error("Plot is not claimed yet");
    if (plot.nftState?.stage === 'pending') throw new Error("This deed is still confirming");
    if ((plot.owner || '').toLowerCase() !== (username || '').toLowerCase()) {
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

    const job = mintQueue.enqueue({
      type: 'upgrade',
      username: clean,
      plotId: plot.id,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot,
      meta: { name: plot.name, level: building.level },
      steps: [
        {
          key: 'payment',
          label: `Pay ${cost.toLocaleString()} NUM upgrade`,
          operation: {
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
    if (chainLedger.getBalance(username).available < fee) {
      throw new Error(`Insufficient balance to pay the minting fee (${fee} NUM)`);
    }

    chainLedger.localAdjust(username, -fee, `Minting fee · ${weight}g ${metal} at ${mint.label}`);

    const owner = userManager.getUser(mint.owner);
    if (owner && owner.username !== username) {
      chainLedger.localAdjust(owner.username, fee, `Mint seigniorage [${mint.label}]`);
    } else if (!owner) {
      this.globalTaxPool = +(this.globalTaxPool + fee).toFixed(4);
    }

    const coin = {
      id: `NUM-${metal.toUpperCase()}-${String(this.mintLedger.length + 1).padStart(6, '0')}`,
      metal,
      weightGrams: weight,
      purity: purityValue,
      mintPlotId: mint.id,
      mintLabel: mint.label,
      mintedBy: username,
      fee,
      createdAt: new Date().toISOString()
    };

    this.mintLedger.unshift(coin);
    if (this.mintLedger.length > 500) this.mintLedger.pop();
    this.scheduleSave();

    return coin;
  }

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
    stats.treasuryBalance = 0;
    stats.subsidiesDistributed = (stats.subsidiesDistributed || 0) + treasury;
    chainLedger.addPending(clean, treasury);

    const job = mintQueue.enqueue({
      type: 'town_hall',
      username: clean,
      plotId: plot.id,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot: { plotId: plot.id, amount: treasury, treasuryBefore: treasury },
      meta: { name: plot.name },
      steps: [{
        key: 'mint_taxes',
        label: `Mint ${treasury.toLocaleString()} NUM municipal tax dividend`,
        operation: {
          kind: 'mint',
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          recipient: clean,
          amountUnits: toUnits(treasury)
        },
        compensate: null
      }]
    });

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
  /* Bank / stocks / auctions (game-local, no minting)                  */
  /* ------------------------------------------------------------------ */

  bankDeposit(amount, username = "danie") {
    const value = Number(amount);
    if (value <= 0) throw new Error("Invalid deposit amount");
    const clean = String(username || '').toLowerCase();
    if (chainLedger.getBalance(clean).available < value) throw new Error("Insufficient wallet balance");

    chainLedger.localAdjust(clean, -value, "Deposit to Numista Bank Vault");
    this.userBank.depositedNum += value;
    return this.userBank;
  }

  bankWithdraw(amount, username = "danie") {
    const value = Number(amount);
    if (value <= 0) throw new Error("Invalid withdraw amount");
    if (this.userBank.depositedNum < value) throw new Error("Withdraw exceeds deposited funds");

    this.userBank.depositedNum -= value;
    chainLedger.localAdjust(String(username || '').toLowerCase(), value, "Withdraw from Numista Bank Vault");
    return this.userBank;
  }

  bankClaimInterest(username = "danie") {
    const accrued = this.userBank.accruedInterest;
    if (accrued <= 0.0001) throw new Error("No interest to claim yet");

    const clean = String(username || '').toLowerCase();
    const amount = +accrued.toFixed(4);
    this.userBank.accruedInterest = 0;
    chainLedger.addPending(clean, amount);

    const job = mintQueue.enqueue({
      type: 'bank_interest',
      username: clean,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot: { amount, accruedBefore: accrued },
      meta: { name: 'Numista Bank' },
      steps: [{
        key: 'mint_interest',
        label: `Mint ${amount.toLocaleString()} NUM staking yield`,
        operation: {
          kind: 'mint',
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          recipient: clean,
          amountUnits: toUnits(amount)
        },
        compensate: null
      }]
    });

    return {
      claimed: amount,
      pending: true,
      job: mintQueue.publicJob(job),
      bank: this.userBank
    };
  }

  placeBid(auctionId, bidAmount, username = "danie") {
    const auc = this.auctions.find(a => a.id === auctionId);
    if (!auc) throw new Error("Auction listing not found");
    if (bidAmount <= auc.currentBid) {
      throw new Error(`Bid must exceed current highest bid (${auc.currentBid} NUM)`);
    }

    const clean = String(username || '').toLowerCase();
    if (chainLedger.getBalance(clean).available < bidAmount) {
      throw new Error("Insufficient wallet balance to place bid");
    }

    chainLedger.localAdjust(clean, -bidAmount, `Placed bid on auction #${auc.id} (${auc.title})`);

    auc.currentBid = bidAmount;
    auc.highestBidder = clean; // Username only, keeping wallet address private!
    auc.bidsCount += 1;

    const tax = +(bidAmount * 0.035).toFixed(3);
    this.globalTaxPool += tax;

    return auc;
  }

  tradeStock(ticker, action, shares, username = "danie") {
    const stock = this.stocks.find(s => s.ticker === ticker);
    if (!stock) throw new Error("Stock ticker not found");
    if (shares <= 0) throw new Error("Invalid shares count");

    const totalCost = +(stock.price * shares).toFixed(2);
    const brokerFee = +(totalCost * 0.015).toFixed(2);
    const tax = +(totalCost * 0.01).toFixed(2);
    const clean = String(username || '').toLowerCase();

    if (action === 'buy') {
      const needed = totalCost + brokerFee + tax;
      if (chainLedger.getBalance(clean).available < needed) {
        throw new Error(`Insufficient balance. Cost + fees: ${needed.toFixed(2)} NUM`);
      }
      chainLedger.localAdjust(clean, -needed, `Bought ${shares} shares of ${ticker} via Stock Broker`);
      this.userStocks[ticker] = (this.userStocks[ticker] || 0) + shares;
      this.globalTaxPool += tax;
    } else if (action === 'sell') {
      const owned = this.userStocks[ticker] || 0;
      if (owned < shares) throw new Error(`You only own ${owned} shares of ${ticker}`);
      const proceeds = +(totalCost - brokerFee - tax).toFixed(2);
      this.userStocks[ticker] -= shares;
      chainLedger.localAdjust(clean, proceeds, `Sold ${shares} shares of ${ticker} via Stock Broker`);
      this.globalTaxPool += tax;
    }

    return {
      stock,
      ownedShares: this.userStocks[ticker] || 0,
      portfolio: this.userStocks,
      walletBalance: chainLedger.getBalance(clean).available
    };
  }

  /* ------------------------------------------------------------------ */
  /* Mining rewards (batched into on-chain mints)                       */
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
      this.pendingMining.delete(username);
      chainLedger.addPending(username, amount);

      mintQueue.enqueue({
        type: 'mining',
        username,
        assetId: NUM_ASSET_ID,
        requiredConfirmations: REQUIRED_CONFIRMATIONS,
        snapshot: { amount, shares: reward.shares },
        meta: { name: 'Browser mining' },
        steps: [{
          key: 'mint_mining',
          label: `Mint ${amount} NUM mining reward`,
          operation: {
            kind: 'mint',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            recipient: username,
            amountUnits: toUnits(amount)
          },
          compensate: null
        }]
      });
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

    chainLedger.lock(from, value);

    const job = mintQueue.enqueue({
      type: 'transfer',
      username: from,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot: { amount: value, to, from },
      meta: { name: `@${from} → @${to}` },
      steps: [{
        key: 'transfer',
        label: `Transfer ${value} NUM to @${to}`,
        operation: {
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
      }]
    });

    return {
      pending: true,
      amount: value,
      to,
      job: mintQueue.publicJob(job),
      walletBalance: chainLedger.getBalance(from).available
    };
  }

  creditExternal(username, amount, reference = 'External purchase') {
    const clean = String(username || '').toLowerCase();
    const value = +Number(amount || 0).toFixed(4);
    if (!(value > 0)) throw new Error('Invalid credit amount');

    chainLedger.addPending(clean, value);

    const job = mintQueue.enqueue({
      type: 'external',
      username: clean,
      assetId: NUM_ASSET_ID,
      requiredConfirmations: REQUIRED_CONFIRMATIONS,
      snapshot: { amount: value, reference },
      meta: { name: reference },
      steps: [{
        key: 'mint_external',
        label: `Mint ${value} NUM (${reference})`,
        operation: {
          kind: 'mint',
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          recipient: clean,
          amountUnits: toUnits(value)
        },
        compensate: null
      }]
    });

    return { pending: true, amount: value, job: mintQueue.publicJob(job) };
  }

  /* ------------------------------------------------------------------ */
  /* Job callbacks                                                      */
  /* ------------------------------------------------------------------ */

  _onJobConfirmed(job) {
    if (job.gameApplied) return;
    job.gameApplied = true;

    const username = job.username;
    const found = key => job.steps.find(s => s.key === key && !s.compensation);

    try {
      if (job.type === 'claim') {
        const plot = this.getPlotById(job.plotId);
        if (!plot) return;
        const payment = found('payment');
        const mint = found('mint');
        const amount = job.snapshot?.cost || 0;

        chainLedger.settleSpend(username, amount);
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

        plot.pendingJobId = null;
        plot.nftState = {
          stage: 'onchain',
          assetId: job.assetId,
          tokenId: job.assetId,
          metadataHash: plot.nftState?.metadataHash || null,
          mintedAt: new Date().toISOString(),
          txHash: mint?.txHash || null,
          blockHeight: mint?.confirmedHeight || null,
          confirmations: job.requiredConfirmations,
          jobId: job.id,
          confirmedAt: new Date().toISOString()
        };

        if (username === 'crown_treasury') {
          this.globalTaxPool = +(this.globalTaxPool + amount).toFixed(4);
        }

        this.scheduleSave();
        return;
      }

      if (job.type === 'income' || job.type === 'town_hall' || job.type === 'bank_interest' || job.type === 'mining') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.settlePending(username, amount);
        const mint = job.steps.find(s => s.key.startsWith('mint') && !s.compensation) || job.steps[0];
        chainLedger.recordChainMove({
          username,
          amount,
          description: job.type === 'income'
            ? `Rental income: ${job.meta?.name || job.plotId || 'property'}`
            : job.type === 'town_hall'
              ? `Town Hall tax dividend: ${job.meta?.name || 'municipality'}`
              : job.type === 'mining'
                ? 'Browser mining reward'
                : 'Bank staking yield',
          txHash: mint?.txHash,
          height: mint?.confirmedHeight,
          jobId: job.id,
          plotId: job.plotId,
          assetId: job.assetId
        });

        if (job.type === 'income' && job.plotId) {
          const plot = this.getPlotById(job.plotId);
          if (plot?.building?.stats) {
            plot.building.stats.totalIncomeCollected = +((job.snapshot?.totalBefore || 0) + amount).toFixed(4);
            plot.building.stats.lastCollectedAt = new Date().toISOString();
          }
        }

        this.scheduleSave();
        return;
      }

      if (job.type === 'upgrade') {
        const plot = this.getPlotById(job.plotId);
        const amount = Number(job.snapshot?.cost) || 0;
        chainLedger.settleSpend(username, amount);
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

      if (job.type === 'external') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.settlePending(username, amount);
        const step = job.steps[0];
        chainLedger.recordChainMove({
          username,
          amount,
          description: job.snapshot?.reference || 'External NUM purchase',
          txHash: step?.txHash,
          height: step?.confirmedHeight,
          jobId: job.id
        });
        this.scheduleSave();
        return;
      }
    } finally {
      // Queue persistence records that this job's game effects are applied.
      mintQueue._saveSoon();
    }
  }

  _onJobReverted(job) {
    if (job.gameApplied) return;
    job.gameApplied = true;
    const username = job.username;

    try {
      if (job.type === 'claim') {
        const plot = this.getPlotById(job.plotId);
        const amount = Number(job.snapshot?.cost) || 0;
        chainLedger.unlock(username, amount);
        if (plot) {
          plot.isClaimed = false;
          plot.owner = null;
          plot.building = null;
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
        chainLedger.dropPending(username, amount);
        const plot = this.getPlotById(job.plotId);
        if (plot?.building?.stats && job.snapshot) {
          plot.building.stats.accruedIncome = +Number(job.snapshot.accrued || 0).toFixed(6);
          plot.building.stats.totalIncomeCollected = job.snapshot.totalBefore || 0;
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

      if (job.type === 'town_hall') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.dropPending(username, amount);
        const plot = this.getPlotById(job.plotId);
        if (plot?.building?.stats) {
          plot.building.stats.treasuryBalance = +((plot.building.stats.treasuryBalance || 0) + amount).toFixed(2);
        }
        this.scheduleSave();
        return;
      }

      if (job.type === 'bank_interest') {
        const amount = Number(job.snapshot?.accruedBefore) || 0;
        chainLedger.dropPending(username, Number(job.snapshot?.amount) || 0);
        this.userBank.accruedInterest = +(this.userBank.accruedInterest + amount).toFixed(6);
        return;
      }

      if (job.type === 'mining') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.dropPending(username, amount);
        const current = this.pendingMining.get(username) || { amount: 0, shares: 0 };
        current.amount = round(current.amount + amount);
        this.pendingMining.set(username, current);
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

      if (job.type === 'external') {
        const amount = Number(job.snapshot?.amount) || 0;
        chainLedger.dropPending(username, amount);
        return;
      }
    } finally {
      mintQueue._saveSoon();
    }
  }
}

export const gameStore = new GameStore();
