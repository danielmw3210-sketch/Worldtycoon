import { deriveDeterministicCoinEra } from '../numista/chainIndexer.js';
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
import { chainLedger } from './chainLedger.js';
import { userManager } from './users.js';
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
    this.mintLedger = [];
    this.statePath = process.env.NUMISTA_STATE_FILE || path.join(__dirname, 'gameState.json');
    this._saveTimer = null;
    this.pendingMining = new Map();
    this.pendingUsernameRegistrations = new Set();

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
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (Array.isArray(raw.mints)) this.mintLedger = raw.mints;
      if (raw.userBanks && typeof raw.userBanks === 'object') this.userBanks = raw.userBanks;
      if (raw.userStocks && typeof raw.userStocks === 'object') this.userStocks = raw.userStocks;
      if (Array.isArray(raw.auctions)) {
        this.auctions = this.auctions.map(auction => {
          const saved = raw.auctions.find(item => item.id === auction.id);
          return saved?.escrowOnChain ? { ...auction, ...saved } : auction;
        });
      }

      const byId = new Map(this.plots.map(p => [p.id, p]));
      let restored = 0;
      (raw.plots || []).forEach(saved => {
        const plot = byId.get(saved.id);
        if (!plot) return;
        plot.isClaimed = !!saved.isClaimed;
        plot.owner = saved.owner || null;
        if (saved.building) {
          plot.building = saved.building;
          if (plot.building.type === 'town_hall' && plot.building.stats) {
            plot.building.stats.treasuryBalance = 0;
            plot.building.stats.totalTaxesCollected = 0;
          }
        }
        if (saved.pendingJobId || saved.nftState?.stage === 'pending') { plot.isClaimed = false; plot.owner = null; plot.building = null; plot.pendingJobId = null; plot.nftState = { stage: 'unminted' }; }
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
        mints: this.mintLedger,
        userBanks: this.userBanks,
        userStocks: this.userStocks,
        auctions: this.auctions,
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

  scheduleSave() { return;
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
      }
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
      name: `${rolled.name} Â· ${plot.label}`,
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
          accountIndex: userManager.getUser(username)?.receiveAddress?.accountIndex || 0,
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
          accountIndex: userManager.getUser(username)?.receiveAddress?.accountIndex || 0,
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
          accountIndex: userManager.getUser(username)?.receiveAddress?.accountIndex || 0,
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
    if ((plot.owner || '').toLowerCase() !== (username || '').toLowerCase()) {
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

    stats.accruedIncome = 0;
    chainLedger.addPending(clean, amount);

    const job = this._enqueueNumTransfer({
      type: 'income',
      from: TREASURY,
      to: clean,
      amount,
      description: `Pay ${amount.toLocaleString()} NUM rental income`,
      snapshot: { ...snapshot, username: clean, plotId: plot.id },
      meta: { plotId: plot.id, name: plot.name, building: building.name }
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
      message: `Collecting ${amount.toLocaleString()} NUM â€” it settles after ${REQUIRED_CONFIRMATIONS} blocks`
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
        ...this._registrationSteps([clean]),
        {
          key: 'payment',
          label: `Pay ${cost.toLocaleString()} NUM upgrade`,
          operation: {
          accountIndex: userManager.getUser(username)?.receiveAddress?.accountIndex || 0,
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

    listPlotForSale(plotId, username, priceNum) { const plot = this.getPlotById(plotId); if (!plot || !plot.isClaimed) throw new Error("Plot is not claimed"); const seller = String(username || "").toLowerCase(); if (plot.owner.toLowerCase() !== seller) throw new Error("Only the owner can list this plot"); const price = Number(priceNum); if (!price || price < 1) throw new Error("Price must be at least 1 NUM"); plot.marketListing = { priceNum: +price.toFixed(4), seller, listedAt: new Date().toISOString() }; this._save(); return plot; } buyListedPlot(plotId, buyerUsername) { const plot = this.getPlotById(plotId); if (!plot || !plot.marketListing) throw new Error("Plot is not listed for sale"); const buyer = String(buyerUsername || "").toLowerCase(); const seller = String(plot.owner || "").toLowerCase(); if (!buyer || buyer === seller) throw new Error("Cannot buy your own plot"); const gross = Number(plot.marketListing.priceNum); const taxRate = Number(CONFIG.ECONOMY.SECONDARY_MARKET_TAX_RATE || 0.05); const taxAmount = +(gross * taxRate).toFixed(4); const sellerProceeds = +(gross - taxAmount).toFixed(4); const sellerJob = this._enqueueNumTransfer({ type: "plot_sale", from: buyer, to: seller, amount: sellerProceeds, description: "Plot sale (95%) - " + plot.label }); const taxJob = taxAmount > 0 ? this._enqueueNumTransfer({ type: "plot_market_tax", from: buyer, to: TREASURY, amount: taxAmount, description: "5% Secondary Market Vault Tax - " + plot.label }) : null; plot.owner = buyer; plot.marketListing = null; this._save(); return { plot, gross, taxAmount, sellerProceeds, sellerJob: mintQueue.publicJob(sellerJob), taxJob: taxJob ? mintQueue.publicJob(taxJob) : null }; } mintPreDecimalAssortment({ amountNum, mintPlotId, username }) { const payer = String(username || "").toLowerCase(); if (!payer) throw new Error("Sign in required"); const amount = Number(amountNum); if (!amount || amount < 0.05 || amount > 10000) throw new Error("Enter 0.05 to 10,000 NUM (1 NUM = 1 Pre-Decimal Pound = 20s)"); const mint = mintPlotId ? this.getPlotById(mintPlotId) : null; const COINS = [{ key: "gold_guinea", name: "Gold Guinea (21s)", farthings: 1008, weightG: 7.988, metal: "gold", purity: 0.9167, w: 8 }, { key: "gold_sovereign", name: "Gold Sovereign (20s)", farthings: 960, weightG: 7.988, metal: "gold", purity: 0.9167, w: 24 }, { key: "gold_half_sovereign", name: "Gold Half Sovereign (10s)", farthings: 480, weightG: 3.994, metal: "gold", purity: 0.9167, w: 18 }, { key: "silver_crown", name: "Silver Crown (5s)", farthings: 240, weightG: 28.28, metal: "silver", purity: 0.925, w: 12 }, { key: "silver_half_crown", name: "Silver Half Crown (2s 6d)", farthings: 120, weightG: 14.14, metal: "silver", purity: 0.925, w: 14 }, { key: "silver_florin", name: "Silver Florin (2s)", farthings: 96, weightG: 11.31, metal: "silver", purity: 0.925, w: 12 }, { key: "silver_shilling", name: "Silver Shilling (1s)", farthings: 48, weightG: 5.66, metal: "silver", purity: 0.925, w: 12 }, { key: "silver_sixpence", name: "Silver Sixpence (6d)", farthings: 24, weightG: 2.83, metal: "silver", purity: 0.925, w: 10 }, { key: "silver_threepence", name: "Silver Threepence (3d)", farthings: 12, weightG: 1.41, metal: "silver", purity: 0.925, w: 8 }, { key: "bronze_penny", name: "Bronze Penny (1d)", farthings: 4, weightG: 9.45, metal: "bronze", purity: 0.95, w: 4 }, { key: "bronze_halfpenny", name: "Bronze Halfpenny (1/2d)", farthings: 2, weightG: 5.67, metal: "bronze", purity: 0.95, w: 2 }, { key: "bronze_farthing", name: "Bronze Farthing (1/4d)", farthings: 1, weightG: 2.83, metal: "bronze", purity: 0.95, w: 1 }]; let rem = Math.round(amount * 960); const counts = new Map(); while (rem > 0) { const ok = COINS.filter(c => c.farthings <= rem); const tw = ok.reduce((s, c) => s + c.w, 0); let r = Math.random() * tw, acc = 0, pick = ok.at(0); for (const c of ok) { acc += c.w; if (r <= acc) { pick = c; break; } } rem -= pick.farthings; counts.set(pick.key, (counts.get(pick.key) || 0) + 1); } const assortment = COINS.filter(c => counts.has(c.key)).map(c => { const count = counts.get(c.key); return { key: c.key, name: c.name, count, metal: c.metal, purity: c.purity, weightGrams: +(c.weightG * count).toFixed(3), valueNum: +((c.farthings * count) / 960).toFixed(6) }; }); const ERAS = [{ rarity: "Common", badge: "common", mult: 1, w: 60, picks: [{ year: 1918, ruler: "George V" }, { year: 1915, ruler: "George V" }, { year: 1911, ruler: "George V (Coronation)" }, { year: 1907, ruler: "Edward VII" }, { year: 1899, ruler: "Victoria (Veiled Head)" }] }, { rarity: "Uncommon", badge: "uncommon", mult: 1.5, w: 24, picks: [{ year: 1887, ruler: "Victoria (Golden Jubilee)" }, { year: 1872, ruler: "Victoria (Young Head)" }, { year: 1853, ruler: "Victoria (Young Head)" }] }, { rarity: "Rare", badge: "rare", mult: 3, w: 11, picks: [{ year: 1831, ruler: "William IV" }, { year: 1826, ruler: "George IV" }, { year: 1821, ruler: "George IV (Laureate)" }] }, { rarity: "Ultra Rare", badge: "ultra_rare", mult: 7, w: 4, picks: [{ year: 1817, ruler: "George III (Bull Head)" }, { year: 1797, ruler: "George III (Soho Mint)" }, { year: 1787, ruler: "George III (Spade)" }] }, { rarity: "Mythic", badge: "mythic", mult: 20, w: 1, picks: [{ year: 1703, ruler: "Queen Anne (VIGO)" }, { year: 1694, ruler: "William & Mary" }, { year: 1663, ruler: "Charles II (First Milled)" }] }]; const mintedCoins = []; let seq = this.mintLedger.length * 100 + 1; for (const item of assortment) { for (let k = 0; k < item.count; k++) { const pk = deriveDeterministicCoinEra(payer + ":" + Date.now(), seq); const era = pk; mintedCoins.push({ serial: "COIN-" + pk.year + "-" + String(seq++).padStart(6, "0"), name: item.name, year: pk.year, ruler: pk.ruler, rarity: era.rarity, badge: era.badge, collectorMult: era.mult, metal: item.metal, purity: item.purity, weightGrams: +(item.weightGrams / item.count).toFixed(3), faceValueNum: +(item.valueNum / item.count).toFixed(6), owner: payer }); } } const batch = { id: "PRE-1920-" + String(this.mintLedger.length + 1).padStart(6, "0"), era: "Pre-1920 British Pre-Decimal (1 NUM = 20s)", amountNum: +((Math.round(amount * 960)) / 960).toFixed(6), mintPlotId: mint?.id || "ROYAL_MINT_LONDON", mintLabel: mint?.label || "Royal Mint (Pre-1920 Standard)", mintedBy: payer, assortment, coins: mintedCoins, createdAt: new Date().toISOString() }; const mintOwner = mint && mint.isClaimed && mint.owner && String(mint.owner).toLowerCase() !== payer ? String(mint.owner).toLowerCase() : null; const ownerCut = mintOwner ? +(batch.amountNum * 0.10).toFixed(4) : 0; const vaultCut = +(batch.amountNum - ownerCut).toFixed(4); if (ownerCut > 0) this._enqueueNumTransfer({ type: "mint_commission", from: payer, to: mintOwner, amount: ownerCut, description: "10% Royal Mint Commission - " + batch.id }); const job = this._enqueueNumTransfer({ type: "predecimal_mint", from: payer, to: TREASURY, amount: vaultCut, description: "Pre-1920 Mint - " + batch.amountNum + " NUM", snapshot: { coin: batch } }); this.mintLedger.unshift(batch); this.scheduleSave(); return { pending: true, batch, assortment, coins: mintedCoins, job: mintQueue.publicJob(job) }; }
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

  _enqueueNumTransfer({ type, from, to, amount, description, snapshot = {}, meta = {}, extraSteps = [] }) {
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
        steps: [...registrationSteps, {
          key: 'transfer',
          label: description,
          operation: {
          accountIndex: userManager.getUser(from)?.receiveAddress?.accountIndex || 0,
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
          accountIndex: userManager.getUser(username)?.receiveAddress?.accountIndex || 0,
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

      createUniversalAuction({ seller, category, assetRef, title, startingBid, buyoutPrice, durationHours }) { const clean = String(seller || "").toLowerCase(); if (!clean) throw new Error("Sign in required"); const cat = String(category || "Land Plot"); const start = Math.max(0.05, Number(startingBid) || 1); const buyout = Number(buyoutPrice) > 0 ? Math.max(start, Number(buyoutPrice)) : null; const hrs = Math.min(168, Math.max(1, Number(durationHours) || 24)); const id = "auc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6); const auc = { id, title: String(title || `${cat}: ${assetRef}`).slice(0, 90), category: cat, assetRef: String(assetRef || ""), plotId: cat === "Land Plot" ? String(assetRef || "") : null, seller: clean, currentBid: start, highestBidder: null, buyoutPrice: buyout, endsAt: new Date(Date.now() + hrs * 3600000).toISOString(), bidsCount: 0, status: "active" }; this.auctions.unshift(auc); this.scheduleSave(); return auc; } buyoutAuction(auctionId, buyerUsername) { this.sweepExpiredAuctions(); const auc = this.auctions.find(a => a.id === auctionId); if (!auc) throw new Error("Auction listing not found"); if (auc.status === "expired" || auc.status === "settled" || Date.now() >= new Date(auc.endsAt).getTime()) throw new Error("This auction listing has expired"); if (!auc.buyoutPrice) throw new Error("This listing does not have an instant buyout price"); const buyer = String(buyerUsername || "").toLowerCase(); const seller = String(auc.seller || "").toLowerCase(); if (!buyer || buyer === seller) throw new Error("Cannot buy your own listing"); const gross = Number(auc.buyoutPrice); const taxRate = Number(CONFIG.ECONOMY.SECONDARY_MARKET_TAX_RATE || 0.05); const tax = +(gross * taxRate).toFixed(4); const proceeds = +(gross - tax).toFixed(4); this._enqueueNumTransfer({ type: "auction_buyout", from: buyer, to: seller, amount: proceeds, description: `Auction Buyout (95%) · ${auc.title}` }); if (tax > 0) this._enqueueNumTransfer({ type: "auction_market_tax", from: buyer, to: TREASURY, amount: tax, description: `5% Sovereign Vault Auction Tax · ${auc.title}` }); this._transferAuctionAsset(auc, buyer); auc.currentBid = gross; auc.highestBidder = buyer; auc.status = "settled"; this.scheduleSave(); return auc; }
  sweepExpiredAuctions() { let changed = false; const now = Date.now(); for (const auc of this.auctions) { if (auc.status === "settled" || auc.status === "expired") continue; if (auc.endsAt && now >= new Date(auc.endsAt).getTime()) { if (auc.highestBidder && Number(auc.currentBid) > 0) { const gross = Number(auc.currentBid); const taxRate = Number(CONFIG.ECONOMY.SECONDARY_MARKET_TAX_RATE || 0.05); const tax = +(gross * taxRate).toFixed(4); const proceeds = +(gross - tax).toFixed(4); this._enqueueNumTransfer({ type: "auction_payout", from: TREASURY, to: auc.seller, amount: proceeds, description: "Auction settled (95%) - " + auc.title }); if (tax > 0) this._enqueueNumTransfer({ type: "auction_market_tax", from: TREASURY, to: TREASURY, amount: tax, description: "5% Secondary Market Vault Tax - " + auc.title }); this._transferAuctionAsset(auc, auc.highestBidder); auc.status = "settled"; } else { auc.status = "expired"; } changed = true; } } if (changed) this.scheduleSave(); return this.auctions; }
  placeBid(auctionId, bidAmount, username) {
    this.sweepExpiredAuctions();
    const auc = this.auctions.find(a => a.id === auctionId);
    if (!auc) throw new Error("Auction listing not found"); if (auc.status === "expired" || auc.status === "settled" || Date.now() >= new Date(auc.endsAt).getTime()) throw new Error("This auction listing has expired");
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
          accountIndex: userManager.getUser(username)?.receiveAddress?.accountIndex || 0,
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

  _onJobConfirmed(job) {
    if (job.gameApplied) return;
    job.gameApplied = true;
    this._recordRegistrations(job);

    const username = job.username;
    const found = key => job.steps.find(s => s.key === key && !s.compensation);

    try {
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
            plot.building.stats.totalIncomeCollected = +((job.snapshot?.totalBefore || 0) + amount).toFixed(4);
            plot.building.stats.lastCollectedAt = new Date().toISOString();
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

      if (['bank_deposit', 'bank_withdraw', 'auction_bid', 'stock_buy', 'stock_sell', 'mint_issue'].includes(job.type)) {
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
        }

        this.scheduleSave();
        return;
      }
    } finally {
      // Queue persistence records that this job's game effects are applied.
      mintQueue._saveSoon();
    }
  }

  _onJobReverted(job) {
    if (job.type === 'deposit' || job.type === 'currency_mint' || job.type === 'treasury_block_reward') { chainLedger.dropPending(job.username, Number(job.snapshot?.amount) || 0); return; }
    if (job.gameApplied) return;
    job.gameApplied = true;
    this._recordRegistrations(job);
    const username = job.username;
    const found = key => job.steps.find(s => s.key === key && !s.compensation);
    const settlementUncertain = job.status === 'revert_failed';

    try {
      if (settlementUncertain) {
        console.error(`[ledger] Job ${job.id} has a failed on-chain compensation; reserved balances remain locked for reconciliation`);
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

      if (['bank_deposit', 'bank_withdraw', 'stock_buy', 'stock_sell', 'mint_issue'].includes(job.type)) {
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
