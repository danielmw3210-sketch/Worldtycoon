import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { gameStore } from './data/store.js';
import { numistaRpc } from './numista/rpc.js';
import { userManager } from './data/users.js';
import { miningPool } from './mining/pool.js';
import { cryptoOnramp } from './payment/onramp.js';
import { RARITY_TIERS } from './data/plotGrid.js';
import { chainAdapter } from './numista/chainAdapter.js';
import { mintQueue } from './numista/mintQueue.js';
import { chainLedger } from './data/chainLedger.js';
import { readDeedMetadata, NUM_ASSET_ID } from './data/deedRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json());

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function requestUser(req) {
  return String(
    req.body?.username || req.query?.username || req.headers['x-numista-user'] || ''
  ).trim().toLowerCase();
}

function requireUser(req, res) {
  const username = requestUser(req);
  if (!username) {
    res.status(401).json({ error: 'Sign in required' });
    return null;
  }
  if (!userManager.getUser(username)) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  return username;
}

/** Admin gate for raw node/wallet proxies and sensitive telemetry. */
function requireAdmin(req, res) {
  const username = requestUser(req);
  if (!username || !userManager.isAdmin(username)) {
    res.status(403).json({ error: 'Administrator access required' });
    return null;
  }
  return username;
}

function walletView(username) {
  if (!username) {
    return { balance: 0, unlockedBalance: 0, pendingBalance: 0, lockedBalance: 0 };
  }
  const balance = chainLedger.getBalance(username);
  return {
    balance: balance.available,
    unlockedBalance: balance.available,
    pendingBalance: balance.pending,
    lockedBalance: balance.locked,
    totalBalance: balance.total
  };
}

// ----------------------------------------------------
// AUTHENTICATION API
// ----------------------------------------------------

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body;
    const result = userManager.register({ username, password });
    chainLedger.ensure(result.username);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const result = userManager.login({ username, password });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  const username = requestUser(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const user = userManager.getUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    username: user.username,
    role: userManager.getRole(user.username),
    wallet: walletView(user.username)
  });
});

// ----------------------------------------------------
// PLOTS & BUILDINGS API (Townforge UK Registry)
// ----------------------------------------------------

// Compact public representation: owner is always a username, never a wallet address.
const toPublicPlot = (plot) => ({
  id: plot.id,
  name: plot.name,
  label: plot.label,
  region: plot.region,
  coords: plot.coords,
  bounds: plot.bounds,
  row: plot.row,
  col: plot.col,
  isLandmark: !!plot.isLandmark,
  isClaimed: !!plot.isClaimed,
  owner: plot.owner ? (plot.owner.startsWith('@') ? plot.owner : `@${plot.owner}`) : null,
  rarity: plot.rarity,
  rarityKey: plot.rarityKey,
  rarityName: plot.rarityName,
  price: plot.price,
  building: plot.building ? { ...plot.building } : null,
  pendingJobId: plot.pendingJobId || null,
  assetId: plot.assetId || null,
  nftState: plot.nftState ? {
    stage: plot.nftState.stage,
    assetId: plot.nftState.assetId || plot.assetId || null,
    metadataHash: plot.nftState.metadataHash || null,
    txHash: plot.nftState.txHash || null,
    blockHeight: plot.nftState.blockHeight || null,
    confirmations: plot.nftState.confirmations || 0,
    jobId: plot.nftState.jobId || null
  } : null
});

app.get('/api/account', (req, res) => {
  const username = (req.query.username || req.headers['x-numista-user'] || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  const user = userManager.getUser(username);
  const deeds = gameStore.getAllPlots()
    .filter(p => p.isClaimed && (p.owner || '').toLowerCase() === username.toLowerCase())
    .map(toPublicPlot);

  res.json({
    account: user ? {
      username: user.username,
      role: userManager.getRole(user.username),
      createdAt: user.createdAt,
      wallet: walletView(user.username)
    } : {
      username,
      role: 'user',
      createdAt: null,
      wallet: null
    },
    deeds,
    deedCount: deeds.length,
    onChainDeedCount: deeds.filter(d => d.nftState?.stage === 'onchain').length,
    pendingDeedCount: deeds.filter(d => d.nftState?.stage === 'pending').length
  });
});

app.get('/api/account/deeds', (req, res) => {
  const username = (req.query.username || req.headers['x-numista-user'] || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  const deeds = gameStore.getAllPlots()
    .filter(p => p.isClaimed && (p.owner || '').toLowerCase() === username.toLowerCase())
    .map(toPublicPlot);

  res.json({ username, deeds, deedCount: deeds.length });
});

app.get('/api/plots', (req, res) => {
  const all = gameStore.getAllPlots();
  const rarityCounts = {};
  all.forEach(p => {
    const key = p.rarityKey || 'common';
    rarityCounts[key] = (rarityCounts[key] || 0) + 1;
  });

  res.json({
    plots: all.map(toPublicPlot),
    globalTaxPool: gameStore.globalTaxPool,
    totalPlots: all.length,
    claimedPlots: all.filter(p => p.isClaimed).length,
    pendingPlots: all.filter(p => p.nftState?.stage === 'pending').length,
    rarityCounts,
    rarityTiers: RARITY_TIERS
  });
});

app.get('/api/plots/:id', (req, res) => {
  const plot = gameStore.getPlotById(req.params.id);
  if (!plot) return res.status(404).json({ error: 'Plot not found' });
  const job = gameStore.getJobForPlot(plot.id);
  res.json({
    plot: toPublicPlot(plot),
    job: job ? mintQueue.publicJob(job) : null
  });
});

// Claim plot: registers the deed to a USERNAME and mints it on-chain.
app.post('/api/plots/:id/claim', (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.claimPlot(req.params.id, username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Town Hall: claim collected municipal taxes
app.post('/api/plots/:id/town-hall/claim-taxes', (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.claimTownHallTaxes(req.params.id, username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Income properties: collect accrued rent / utility yield
app.post('/api/plots/:id/collect-income', (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.collectPlotIncome(req.params.id, username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Income properties: upgrade one level (max 5)
app.post('/api/plots/:id/upgrade', (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.upgradePlot(req.params.id, username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// MINT QUEUE / DEED METADATA
// ----------------------------------------------------

app.get('/api/jobs', (req, res) => {
  const username = requestUser(req);
  if (!username) return res.status(401).json({ error: 'Sign in required' });
  res.json({
    jobs: mintQueue.getJobsFor(username).map(j => mintQueue.publicJob(j)).filter(Boolean),
    summary: mintQueue.summary()
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = mintQueue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job: mintQueue.publicJob(job) });
});

app.get('/api/plots/:id/job', (req, res) => {
  const job = gameStore.getJobForPlot(req.params.id);
  res.json({ job: job ? mintQueue.publicJob(job) : null });
});

app.get('/api/deeds/:assetId/metadata', (req, res) => {
  const payload = readDeedMetadata(req.params.assetId);
  if (!payload) return res.status(404).json({ error: 'Deed metadata not found' });
  res.json(payload);
});

// ----------------------------------------------------
// COIN MINTS (admin only)
// ----------------------------------------------------

app.post('/api/mint/issue', (req, res) => {
  try {
    const { metal, weightGrams, purity, mintPlotId } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    if (!userManager.isAdmin(username)) {
      return res.status(403).json({ error: 'Only an administrator can strike coins' });
    }
    const coin = gameStore.mintCoin({
      metal,
      weightGrams,
      purity,
      mintPlotId,
      username
    });
    res.json({ success: true, coin, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mints', (req, res) => {
  res.json({ mints: gameStore.getMintLedger(Number(req.query.limit) || 100) });
});

// ----------------------------------------------------
// BANK API
// ----------------------------------------------------

app.get('/api/bank', (req, res) => {
  const username = req.query.username || 'danie';
  res.json({
    userBank: gameStore.userBank,
    baseApy: CONFIG.ECONOMY.BANK_BASE_APY,
    wallet: walletView(username)
  });
});

app.post('/api/bank/deposit', (req, res) => {
  try {
    const { amount } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    const bank = gameStore.bankDeposit(Number(amount), username);
    res.json({ success: true, bank, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bank/withdraw', (req, res) => {
  try {
    const { amount } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    const bank = gameStore.bankWithdraw(Number(amount), username);
    res.json({ success: true, bank, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bank/claim-interest', (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.bankClaimInterest(username);
    res.json({ success: true, ...result, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// AUCTION HOUSE API
// ----------------------------------------------------

app.get('/api/auctions', (req, res) => {
  res.json({
    auctions: gameStore.auctions.map(a => ({
      ...a,
      seller: a.seller.startsWith('@') ? a.seller : `@${a.seller}`,
      highestBidder: a.highestBidder ? (a.highestBidder.startsWith('@') ? a.highestBidder : `@${a.highestBidder}`) : null
    }))
  });
});

app.post('/api/auctions/:id/bid', (req, res) => {
  try {
    const { amount } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    const auction = gameStore.placeBid(req.params.id, Number(amount), username);
    res.json({ success: true, auction, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// STOCK BROKER API
// ----------------------------------------------------

app.get('/api/stocks', (req, res) => {
  const username = req.query.username || 'danie';
  res.json({
    stocks: gameStore.stocks,
    portfolio: gameStore.userStocks,
    wallet: walletView(username)
  });
});

app.post('/api/stocks/trade', (req, res) => {
  try {
    const { ticker, action, shares } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.tradeStock(ticker, action, Number(shares), username);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// IN-BROWSER MINING POOL API
// ----------------------------------------------------

app.get('/api/mining/job', (req, res) => {
  const minerId = req.query.minerId || 'browser-miner-01';
  const job = miningPool.getJob(minerId);
  res.json(job);
});

app.post('/api/mining/submit', (req, res) => {
  try {
    const { minerId, jobId, nonce, hash } = req.body;
    const username = requireUser(req, res);
    if (!username) return;

    const result = miningPool.submitShare({ minerId, jobId, nonce, hash });
    if (result.accepted) {
      const mining = gameStore.creditMiningReward(
        username,
        CONFIG.ECONOMY.MINING_SHARE_REWARD,
        `share:${jobId}:${nonce}`
      );
      result.pendingMining = mining?.pendingMining ?? null;
    }
    result.wallet = walletView(username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mining/stats', (req, res) => {
  res.json(miningPool.getPoolStats());
});

// ----------------------------------------------------
// BUY CRYPTO (NUMISTA ONRAMP) API
// ----------------------------------------------------

app.post('/api/onramp/quote', (req, res) => {
  const { currency, fiatAmount, numAmount } = req.body;
  res.json(cryptoOnramp.calculateQuote({ currency, fiatAmount, numAmount }));
});

app.post('/api/onramp/order', (req, res) => {
  const { currency, amount, paymentMethod, username } = req.body;
  const order = cryptoOnramp.createOrder({ currency, amount, paymentMethod, username });
  res.json(order);
});

app.post('/api/onramp/complete', (req, res) => {
  try {
    const { orderId } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    const order = cryptoOnramp.completeOrder(orderId);
    const credit = gameStore.creditExternal(
      username,
      order.numAmount,
      `Fiat purchase ${order.orderId}`
    );
    res.json({ order, credit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/onramp/orders', (req, res) => {
  res.json({ orders: cryptoOnramp.getOrders() });
});

// ----------------------------------------------------
// CHAIN CAPABILITIES & JOB TELEMETRY
// ----------------------------------------------------

const DEV_RPC_ENABLED = process.env.NUMISTA_ALLOW_DEV_RPC === '1' && CONFIG.CHAIN.MODE === 'simulate';

// Test-only controls for the simulated chain (disabled unless explicitly enabled).
app.post('/api/dev/sim/fail', async (req, res) => {
  if (!DEV_RPC_ENABLED) return res.status(404).json({ error: 'Not found' });
  if (!requireAdmin(req, res)) return;
  try {
    const count = Number(req.body?.count || 1);
    res.json({ injected: await chainAdapter.injectFailure(count) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/dev/sim/mine', async (req, res) => {
  if (!DEV_RPC_ENABLED) return res.status(404).json({ error: 'Not found' });
  if (!requireAdmin(req, res)) return;
  try {
    const blocks = Number(req.body?.blocks || 1);
    res.json({ height: await chainAdapter.mineSimBlocks(blocks) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/network/capabilities', async (req, res) => {
  try {
    const capabilities = await chainAdapter.capabilities();
    res.json({
      capabilities,
      queue: mintQueue.summary(),
      ledger: chainLedger.summary(),
      currencyAssetId: NUM_ASSET_ID,
      confirmationsRequired: CONFIG.CHAIN.CONFIRMATIONS
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// EXTENDED NUMISTA RPC / NETWORK API (admin only)
// ----------------------------------------------------

app.get('/api/network/details', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(await numistaRpc.getNetworkDetails());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/network/fee-estimate', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(await numistaRpc.getFeeEstimate(Number(req.query.grace_blocks || 10)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/network/hard-fork', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getHardForkInfo()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/version', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getVersion()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/sync-info', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getSyncInfo()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/connections', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getConnections()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/peers', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getPeers()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/txpool', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [pool, stats, backlog] = await Promise.allSettled([
      numistaRpc.getTransactionPool(),
      numistaRpc.getTxPoolStats(),
      numistaRpc.getTxPoolBacklog()
    ]);
    res.json({
      pool: pool.status === 'fulfilled' ? pool.value : null,
      stats: stats.status === 'fulfilled' ? stats.value : null,
      backlog: backlog.status === 'fulfilled' ? backlog.value : null
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/network/mining-status', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getMiningStatus()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/block/:heightOrHash', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const key = req.params.heightOrHash;
    const data = /^\d+$/.test(key)
      ? await numistaRpc.getBlock({ height: Number(key) })
      : await numistaRpc.getBlock({ hash: key });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/network/block-header/:height', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getBlockHeaderByHeight(Number(req.params.height))); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/last-block-header', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getLastBlockHeader()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/network/info-raw', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getDaemonInfoRaw()); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Raw daemon RPC proxy (admin only).
app.post('/api/network/rpc', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { method, params = {}, jsonrpc = true } = req.body || {};
    if (!method || typeof method !== 'string') return res.status(400).json({ error: 'method is required' });
    const blocked = new Set(['stop_daemon', 'set_bans', 'banned', 'flush_txpool', 'start_mining', 'stop_mining', 'add_peer', 'set_bootstrap_daemon']);
    if (blocked.has(method)) return res.status(403).json({ error: 'method not allowed' });
    const result = await numistaRpc.callDaemon(method, params, jsonrpc !== false);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wallet-rpc/accounts', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getWalletAccounts()); }
  catch (err) { res.status(400).json({ error: err.message, online: false }); }
});

app.get('/api/wallet-rpc/address', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getWalletAddress(Number(req.query.account_index || 0))); }
  catch (err) { res.status(400).json({ error: err.message, online: false }); }
});

app.get('/api/wallet-rpc/height', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(await numistaRpc.getWalletHeight()); }
  catch (err) { res.status(400).json({ error: err.message, online: false }); }
});

app.post('/api/wallet-rpc/refresh', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const startHeight = req.body?.start_height;
    res.json(await numistaRpc.refreshWallet(typeof startHeight === 'number' ? startHeight : undefined));
  } catch (err) {
    res.status(400).json({ error: err.message, online: false });
  }
});

app.get('/api/wallet-rpc/validate-address', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address is required' });
    res.json(await numistaRpc.validateAddress(address));
  } catch (err) {
    res.status(400).json({ error: err.message, online: false });
  }
});

// Raw wallet RPC proxy (admin only).
app.post('/api/wallet-rpc/call', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { method, params = {} } = req.body || {};
    if (!method || typeof method !== 'string') return res.status(400).json({ error: 'method is required' });
    const blocked = new Set(['stop_wallet', 'close_wallet', 'change_wallet_password', 'delete_address_book']);
    if (blocked.has(method)) return res.status(403).json({ error: 'method not allowed' });
    res.json({ result: await numistaRpc.callWallet(method, params) });
  } catch (err) {
    res.status(400).json({ error: err.message, online: false });
  }
});

// ----------------------------------------------------
// WALLET API (username-based, chain-mirrored)
// ----------------------------------------------------

app.get('/api/wallet', async (req, res) => {
  const username = String(req.query.username || req.headers['x-numista-user'] || '').toLowerCase();
  if (!username) return res.status(401).json({ error: 'Sign in required' });
  const user = userManager.getUser(username);

  if (user) {
    const balance = chainLedger.getBalance(username);
    return res.json({
      username,
      ...balance,
      balance: balance.available,
      unlockedBalance: balance.available,
      pendingBalance: balance.pending,
      lockedBalance: balance.locked,
      totalBalance: balance.total,
      recentTransfers: chainLedger.listFor(username, 50),
      isLiveDaemonConnected: numistaRpc.isDaemonOnline,
      daemonHeight: numistaRpc.syncStatus.height,
      chainMode: chainAdapter.mode
    });
  }

  res.status(404).json({ error: 'User not found' });
});

// Username-to-username transfer, settled on chain.
app.post('/api/wallet/transfer', (req, res) => {
  try {
    const { toUsername, amount } = req.body;
    const username = requireUser(req, res);
    if (!username) return;
    const result = gameStore.transferToUser(username, toUsername, Number(amount));
    res.json({ success: true, ...result, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Configure remote daemon (admin only)
app.post('/api/network/set-node', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.json(numistaRpc.setDaemonUrl(req.body?.nodeUrl));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/network', async (req, res) => {
  const net = await numistaRpc.getNetworkInfo();
  const capabilities = await chainAdapter.capabilities();
  // The simulated chain still has a height and is usable, so surface it even
  // when no daemon is reachable.
  if (!net.height && capabilities.chainHeight) {
    net.height = capabilities.chainHeight;
    net.online = true;
    net.mode = capabilities.mode === 'simulate' ? 'simulated' : net.mode;
  }
  res.json({
    network: net,
    chain: capabilities,
    config: {
      ticker: CONFIG.NUMISTA.TICKER,
      name: CONFIG.NUMISTA.NAME,
      claimPrice: CONFIG.ECONOMY.PLOT_CLAIM_PRICE_NUM,
      taxRate: CONFIG.ECONOMY.TAX_RATE_TOWN_HALL,
      confirmationsRequired: CONFIG.CHAIN.CONFIRMATIONS
    }
  });
});

// Serve frontend static files from dist
const distPath = path.resolve(__dirname, '../dist');
app.use(express.static(distPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  const capabilities = await chainAdapter.init();
  mintQueue.configure({ adapter: chainAdapter });
  chainLedger.configure({ adapter: chainAdapter });
  await chainLedger.bootstrap();
  mintQueue.start();

  console.log(`[chain] mode=${capabilities.mode} ready=${capabilities.ready} :: ${capabilities.reason}`);

  app.listen(CONFIG.PORT, () => {
    console.log(`[Townforge Numista] Server active on http://localhost:${CONFIG.PORT}`);
  });
}

boot().catch(err => {
  console.error('[boot] Fatal:', err);
  process.exit(1);
});
