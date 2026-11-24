import crypto from 'crypto';
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
import { readDeedMetadata, NUM_ASSET_ID, CURRENCY_ASSET_TYPE, CURRENCY_SCHEMA, toUnits, metadataHash } from './data/deedRegistry.js';

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
  return requireSessionUser(req, res);
}

function requireSessionUser(req, res) {
  const token = String(req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  console.log('RAW AUTH:', req.headers.authorization);
  console.log('TOKEN:', token);

  const user = userManager.verifyToken(token);

  console.log('VERIFY RESULT:', user);

  if (!user) {
    res.status(401).json({ error: 'Valid sign-in required' });
    return null;
  }

  const requestedUsername = requestUser(req);
  if (requestedUsername && requestedUsername !== user.username) {
    res.status(403).json({ error: "Cannot access another account's receive address" });
    return null;
  }

  return user.username;
}

/** Admin gate for raw node/wallet proxies and sensitive telemetry. */
function requireAdmin(req, res) {
  const username = requireSessionUser(req, res);
  if (!username) return null;
  if (!userManager.isAdmin(username)) {
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

const receiveAddressJobs = new Map();

async function getOrCreateReceiveAddress(username) {
  const user = userManager.getUser(username);

  if (!user) {
    throw new Error(`User not found: ${username}`);
  }

  if (user.receiveAddress) {
    return user.receiveAddress;
  }

  if (!receiveAddressJobs.has(username)) {
    const job = numistaRpc
      .createAccount(`Goldnumista @${username}`)
      .then(result => {
        return userManager.setReceiveAddress(username, { accountIndex: result.accountIndex, addressIndex: 0, address: result.address });
      })
      .catch(err => {
        console.error('Address creation failed:', err);
        throw err;
      })
      .finally(() => {
        receiveAddressJobs.delete(username);
      });

    receiveAddressJobs.set(username, job);
  }

  return receiveAddressJobs.get(username);
}


// ----------------------------------------------------
// AUTHENTICATION API
// ----------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = userManager.register({
      username,
      password
    });

    chainLedger.ensure(result.username);

    const receiveAddress = await getOrCreateReceiveAddress(
      result.username
    );

    res.json({
      success: true,
      username: result.username,
      role: result.role,
      token: result.token,
      receiveAddress
    });
  } catch (err) {
    console.error('REGISTER ERROR:', err);
    res.status(400).json({
      error: err.message
    });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;

    const result = userManager.login({
      username,
      password
    });

    res.json({
      success: true,
      username: result.username,
      role: result.role,
      token: result.token
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(400).json({
      error: err.message
    });
  }
});

app.get('/api/auth/me', (req, res) => {
  const username = requireSessionUser(req, res);

  if (!username) return;

  const user = userManager.getUser(username);

  if (!user) {
    return res.status(404).json({
      error: 'User not found'
    });
  }

  res.json({
    username: user.username,
    role: userManager.getRole(user.username),
    receiveAddress: user.receiveAddress || null,
    wallet: walletView(user.username)
  });
});

// ----------------------------------------------------
// PLOTS & BUILDINGS API (Goldnumista UK Registry)
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
    const username = requireSessionUser(req, res);
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
    const username = requireSessionUser(req, res);
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
    const username = requireSessionUser(req, res);
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
    const username = requireSessionUser(req, res);
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

// Read-only on-chain asset endpoints. Values always come from the daemon in live mode.
app.get('/api/assets/:assetId', async (req, res) => {
  try {
    const asset = await chainAdapter.getAsset(req.params.assetId);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/api/assets/:assetId/balance/:username', async (req, res) => {
  const username = String(req.params.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username is required' });
  try {
    const units = await chainAdapter.getAssetBalance(req.params.assetId, username);
    res.json({
      assetId: req.params.assetId,
      username,
      balanceUnits: units,
      balance: units / CONFIG.CHAIN.UNITS_PER_NUM
    });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ----------------------------------------------------
// COIN MINTS (admin only)
// ----------------------------------------------------

app.post('/api/mint/issue', (req, res) => {
  try {
    const { metal, weightGrams, purity, mintPlotId } = req.body;
    const username = requireSessionUser(req, res);
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
  const username = requireSessionUser(req, res);
  if (!username) return;
  res.json({
    userBank: gameStore.getBankInfo(username),
    baseApy: CONFIG.ECONOMY.BANK_BASE_APY,
    wallet: walletView(username)
  });
});

app.post('/api/bank/deposit', (req, res) => {
  try {
    const { amount } = req.body;
    const username = requireSessionUser(req, res);
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
    const username = requireSessionUser(req, res);
    if (!username) return;
    const bank = gameStore.bankWithdraw(Number(amount), username);
    res.json({ success: true, bank, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bank/claim-interest', (req, res) => {
  try {
    const username = requireSessionUser(req, res);
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
    const username = requireSessionUser(req, res);
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
  const username = requireSessionUser(req, res);
  if (!username) return;
  res.json({
    stocks: gameStore.stocks,
    portfolio: gameStore.userStocks[username] || {},
    wallet: walletView(username)
  });
});

app.post('/api/stocks/trade', (req, res) => {
  try {
    const { ticker, action, shares } = req.body;
    const username = requireSessionUser(req, res);
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

app.get('/api/mining/job', async (req, res) => {
  const minerId = req.query.minerId || 'browser-miner-01';
  const username = req.session?.user?.username || req.query.username || 'anon';
  const mode = String(req.query?.mode || 'pplns').toLowerCase();const recv = username && username !== 'anon' ? await getOrCreateReceiveAddress(username).catch(() => null) : null;const job = await miningPool.getJob(minerId, username, mode, recv&&recv.address?recv.address:'');
  res.json(job);
});

app.post('/api/mining/submit', async (req, res) => {
  try {
    const { minerId, jobId, nonce, hash } = req.body;
    const username = requireUser(req, res);
    if (!username) return;

    const result = await miningPool.submitShare({ minerId, jobId, nonce, hash, username });
    if (result.accepted) {
      if (result.scheme === 'PPLNS') {
        if (result.payouts && result.payouts.length > 0) {
          for (const payout of result.payouts) {
            gameStore.creditMiningReward(
              payout.username,
              payout.amount,
              `pplns:block:${jobId}`
            );
          }
        }
        result.pendingMining = gameStore.pendingMining.get(username)?.amount || 0;
      } else {
        const mining = gameStore.creditMiningReward(
          username,
          CONFIG.ECONOMY.MINING_SHARE_REWARD,
          `share:${jobId}:${nonce}`
        );
        result.pendingMining = mining?.pendingMining ?? null;
      }
    }
    result.wallet = walletView(username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mining/stats', (req, res) => {
  const username = req.session?.user?.username || req.query.username || null;
  res.json(miningPool.getPoolStats(username));
});

// ----------------------------------------------------
// ON-CHAIN BLOCK EXPLORER API
// ----------------------------------------------------

app.get('/api/explorer/status', async (req, res) => {
  try {
    const [info, lastHeader, txPool, peers] = await Promise.allSettled([
      numistaRpc.getDaemonInfoRaw(),
      numistaRpc.getLastBlockHeader(),
      numistaRpc.getTxPoolStats(),
      numistaRpc.getPeers()
    ]);

    const daemonInfo = info.status === 'fulfilled' ? info.value : {};
    const header = lastHeader.status === 'fulfilled' ? lastHeader.value?.block_header : {};
    const pool = txPool.status === 'fulfilled' ? txPool.value?.pool_stats : {};
    const peerList = peers.status === 'fulfilled' ? (peers.value?.peers || []) : [];

    res.json({
      online: numistaRpc.isDaemonOnline,
      height: daemonInfo.height || header?.height || numistaRpc.syncStatus.height || 0,
      difficulty: daemonInfo.difficulty || header?.difficulty || 0,
      hashrate: Math.round((daemonInfo.difficulty || header?.difficulty || 0) / 120),
      topBlockHash: header?.hash || daemonInfo.top_block_hash || '',
      lastBlockTimestamp: header?.timestamp ? header.timestamp * 1000 : null,
      txPoolCount: pool?.txs_total ?? daemonInfo.tx_pool_size ?? 0,
      peerCount: peerList.length || daemonInfo.incoming_connections_count || 0,
      nettype: daemonInfo.nettype || 'numista-testnet'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/explorer/latest-blocks', async (req, res) => {
  try {
    const count = Math.min(25, Number(req.query.count) || 10);
    const height = numistaRpc.syncStatus.height || (await numistaRpc.getHeight().catch(() => ({})))?.height || 0;
    if (height <= 0) return res.json({ currentHeight: 0, blocks: [] });

    const blocks = [];
    const start = Math.max(1, height);
    const end = Math.max(1, height - count + 1);

    for (let h = start; h >= end; h--) {
      try {
        const headerRes = await numistaRpc.getBlockHeaderByHeight(h);
        if (headerRes?.block_header) {
          const bh = headerRes.block_header;
          blocks.push({
            height: bh.height,
            hash: bh.hash,
            timestamp: bh.timestamp * 1000,
            difficulty: bh.difficulty,
            numTxes: bh.num_txes || 0,
            reward: +(bh.reward / 1e12).toFixed(4),
            minerReward: +(bh.reward / 1e12).toFixed(4),
            size: bh.block_size
          });
        }
      } catch {
        // Skip missing header
      }
    }
    res.json({ currentHeight: height, blocks });
  } catch (err) {
    res.status(500).json({ error: err.message, blocks: [] });
  }
});

app.get('/api/explorer/block/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let blockRes;
    if (/^\d+$/.test(id)) {
      blockRes = await numistaRpc.getBlock({ height: Number(id) });
    } else {
      blockRes = await numistaRpc.getBlock({ hash: id });
    }
    const bh = blockRes?.block_header || {};
    res.json({
      height: bh.height,
      hash: bh.hash,
      prevHash: bh.prev_hash,
      timestamp: bh.timestamp ? bh.timestamp * 1000 : null,
      difficulty: bh.difficulty,
      reward: +(bh.reward / 1e12).toFixed(4),
      minerTxHash: bh.miner_tx_hash,
      txHashes: blockRes?.tx_hashes || [],
      blockSize: bh.block_size,
      depth: (numistaRpc.syncStatus.height || 0) - bh.height
    });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/explorer/tx/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const tx = await numistaRpc.getTransaction(hash);
    if (!tx || !tx.txHash) {
      return res.status(404).json({ error: 'Transaction not found in mempool or blockchain' });
    }
    res.json(tx);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ----------------------------------------------------
// BUY CRYPTO (NUMISTA ONRAMP) API
// ----------------------------------------------------

app.post('/api/onramp/quote', (req, res) => {
  const { currency, fiatAmount, numAmount } = req.body;
  res.json(cryptoOnramp.calculateQuote({ currency, fiatAmount, numAmount }));
});

app.post('/api/onramp/order', (req, res) => {
  res.status(503).json({ error: 'NUM purchases are unavailable until a verified payment provider is configured' });
});

app.post('/api/onramp/complete', (req, res) => {
  res.status(503).json({ error: 'NUM cannot be credited without verified payment settlement' });
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

app.post('/api/wallet-rpc/accounts', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const label = String(req.body?.label || '').trim();
    res.status(201).json(await numistaRpc.createAccount(label));
  } catch (err) {
    res.status(400).json({ error: err.message, online: false });
  }
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
  const username = requireSessionUser(req, res);
  if (!username) return;
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


app.post('/api/wallet/withdraw', async (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const toAddress = String(req.body?.toAddress || '').trim();
    const grossAmount = +Number(req.body?.amount || 0).toFixed(4);
    const fee = +(Number(CONFIG.ECONOMY.TRANSFER_NETWORK_FEE_NUM) || 0.05).toFixed(4);

    if (!toAddress) return res.status(400).json({ error: 'Destination Numista address is required' });
    if (!(grossAmount >= 0.2)) return res.status(400).json({ error: 'Minimum withdrawal is 0.2000 NUM' });

    const bal = chainLedger.getBalance(username);
    if (bal.available < grossAmount) {
      return res.status(400).json({ error: 'Insufficient available NUM balance' });
    }

    const valid = await numistaRpc.validateAddress(toAddress);
    if (!valid?.valid) {
      return res.status(400).json({ error: 'Invalid Numista wallet address' });
    }

    const netNative = +(grossAmount - fee).toFixed(4);
    const vaultBal = await numistaRpc.getWalletBalance(0);
    if (Number(vaultBal.unlockedBalance || 0) < netNative + 0.01) {
      return res.status(400).json({ error: 'Custodial vault native balance is currently maturing; try again in a few blocks' });
    }

    // Lock player's in-game NUM and send native coins on-chain
    chainLedger.lock(username, grossAmount);
    let payout;
    try {
      payout = await numistaRpc.sendTransfer({ toAddress, amountNum: netNative, accountIndex: 0 });
    } catch (err) {
      chainLedger.unlock(username, grossAmount);
      throw err;
    }

    chainLedger.settleSpend(username, grossAmount);
    chainLedger.receiveChain(CONFIG.CHAIN.TREASURY_USERNAME, grossAmount);
    chainLedger.recordChainMove({
      username,
      amount: -grossAmount,
      description: `Withdraw ${netNative} native NUM (${fee} NUM fee) to ${toAddress.slice(0, 10)}...`,
      txHash: payout.txHash,
      assetId: NUM_ASSET_ID
    });
    chainLedger.recordChainMove({
      username: CONFIG.CHAIN.TREASURY_USERNAME,
      amount: grossAmount,
      description: `Withdrawal redemption + ${fee} NUM fee from @${username}`,
      txHash: payout.txHash,
      assetId: NUM_ASSET_ID
    });

    res.json({
      success: true,
      grossAmount,
      fee,
      netNative,
      txHash: payout.txHash,
      wallet: walletView(username)
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wallet/convert-to-game', async (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const amount = +Number(req.body?.amount || 0).toFixed(4);
    const fee = +(Number(CONFIG.ECONOMY.TRANSFER_NETWORK_FEE_NUM) || 0.05).toFixed(4);
    if (!(amount >= 0.1)) return res.status(400).json({ error: 'Minimum conversion is 0.1000 NUM' });

    const recv = await getOrCreateReceiveAddress(username);
    if (!recv || !(recv.accountIndex > 0)) {
      return res.status(400).json({ error: 'Player native account not initialized yet; refresh wallet first' });
    }

    const totalNativeRequired = +(amount + fee).toFixed(4);
    const nativeBal = await numistaRpc.getWalletBalance(recv.accountIndex);
    if (Number(nativeBal.unlockedBalance || 0) < totalNativeRequired + 0.01) {
      return res.status(400).json({
        error: `Insufficient unlocked native NUM in your account (need ${totalNativeRequired} NUM + native gas fee)`
      });
    }

    // Send 1:1 backing + 0.05 NUM pure profit fee from player's native account to townforge (account 0)
    const vaultInfo = await numistaRpc.getWalletAddress(0, 0);
    const nativeTx = await numistaRpc.sendTransfer({
      toAddress: vaultInfo.address,
      amountNum: totalNativeRequired,
      accountIndex: recv.accountIndex
    });

    // Mint in-game NUM asset tokens with gas paid by player's native account
    const steps = [];
    const assetExists = await chainAdapter.getAsset(NUM_ASSET_ID);
    if (!assetExists) {
      steps.push({
        key: 'create_currency',
        label: 'Create fungible NUM currency asset',
        operation: {
          kind: 'create_asset',
          accountIndex: recv.accountIndex,
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          maxSupply: 0,
          metadataHash: metadataHash(CURRENCY_SCHEMA)
        }
      });
    }
    const existingReg = chainLedger.getUsernameRecord(username) || await chainAdapter.getUsernameKey(username);
    if (!existingReg) {
      const reg = chainLedger.ensureUsernameKey(username);
      steps.push({
        key: 'register_user',
        label: `Register @${username} on-chain`,
        operation: {
          kind: 'register_username',
          accountIndex: recv.accountIndex,
          username,
          key: reg.publicKey
        }
      });
    }
    steps.push({
      key: 'mint',
      label: `Convert ${amount} native NUM to in-game NUM (player-paid gas)`,
      operation: {
        kind: 'mint',
        accountIndex: recv.accountIndex,
        assetId: NUM_ASSET_ID,
        assetType: CURRENCY_ASSET_TYPE,
        recipient: username,
        amountUnits: toUnits(amount)
      }
    });

    chainLedger.addPending(username, amount);
    const job = mintQueue.enqueue({
      type: 'deposit',
      username,
      assetId: NUM_ASSET_ID,
      snapshot: { amount, fee, nativeTxHash: nativeTx.txHash, depositTxHashes: [nativeTx.txHash] },
      meta: { name: `Convert ${amount} native NUM ? In-Game NUM` },
      steps
    });

    res.json({
      success: true,
      amount,
      fee,
      nativeTxHash: nativeTx.txHash,
      job: mintQueue.publicJob(job),
      wallet: walletView(username)
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/wallet/receive', async (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;

  try {
    const receiveAddress = await getOrCreateReceiveAddress(username);

    const receiveInfo = await numistaRpc.getSubaddressReceiveInfo(
      receiveAddress.accountIndex,
      receiveAddress.addressIndex
    );

    const minConf = Number(CONFIG.CHAIN.CONFIRMATIONS) || 10;
    const settledDeposits = (receiveInfo.incomingTransfers || []).filter(
      t => t.status === 'confirmed' && Number(t.confirmations) >= minConf && Number(t.amount) > 0
    );
    const hasActiveDeposit = mintQueue.jobs.some(j => j.type === 'deposit' && j.username === username);
    if (false && settledDeposits.length > 0 && chainAdapter.mode === 'live' && !hasActiveDeposit) {
      const existingHistory = chainLedger.listFor(username, 500);
      const activeJobs = [...mintQueue.jobs, ...mintQueue.history];
      const uncredited = settledDeposits.filter(dep =>
        !existingHistory.some(tx => tx.description && tx.description.includes(dep.txHash.slice(0, 10))) &&
        !activeJobs.some(j => j.type === 'deposit' && Array.isArray(j.snapshot?.depositTxHashes) && j.snapshot.depositTxHashes.includes(dep.txHash))
      );

      if (uncredited.length > 0) {
        const totalAmount = +uncredited.reduce((s, d) => s + Number(d.amount), 0).toFixed(6);
        const txHashes = uncredited.map(d => d.txHash);
        const steps = [];
        const assetExists = await chainAdapter.getAsset(NUM_ASSET_ID);
        if (!assetExists) {
          steps.push({
            key: 'create_currency',
            label: 'Create fungible NUM currency asset',
            operation: {
              kind: 'create_asset',
              assetId: NUM_ASSET_ID,
              assetType: CURRENCY_ASSET_TYPE,
              maxSupply: 1000000000000,
              metadataHash: metadataHash({ schema: CURRENCY_SCHEMA, symbol: 'NUM', decimals: CONFIG.CHAIN.DECIMALS })
            }
          });
        }
        if (!chainLedger.getUsernameRecord(username) && !(await chainAdapter.getUsernameKey(username))) {
          steps.push({
            key: `reg_${username}`,
            label: `Register @${username} on-chain`,
            operation: { kind: 'register_username', username, key: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') }
          });
        }
        steps.push({
          key: 'mint',
          label: `Mint ${totalAmount} NUM asset from native deposits`,
          operation: {
            kind: 'mint',
            assetId: NUM_ASSET_ID,
            assetType: CURRENCY_ASSET_TYPE,
            recipient: username,
            amountUnits: toUnits(totalAmount)
          }
        });

        chainLedger.addPending(username, totalAmount);
        mintQueue.enqueue({
          type: 'deposit',
          username,
          assetId: NUM_ASSET_ID,
          snapshot: { amount: totalAmount, depositTxHash: txHashes[0], depositTxHashes: txHashes },
          meta: { name: `Native deposits (${txHashes.length} tx): ${totalAmount} NUM` },
          steps
        });
      }
    }
    res.json({
      ...receiveAddress,
      ...receiveInfo
    });

  } catch (err) {
    console.error('RECEIVE ADDRESS ERROR:', err);

    res.status(503).json({
      error: `Receive address unavailable: ${err.message}`
    });
  }
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
  const treasuryBal = chainLedger.getBalance(CONFIG.CHAIN.TREASURY_USERNAME);
  let crownEstateFund = {
    available: true,
    balance: treasuryBal.available,
    unlockedBalance: treasuryBal.available,
    pendingBalance: treasuryBal.pending,
    source: 'chain_ledger'
  };
  try {
    const watchOnly = await numistaRpc.getCrownEstateFundBalance();
    crownEstateFund = {
      available: true,
      balance: +(Number(watchOnly.balance || 0) + treasuryBal.available).toFixed(6),
      unlockedBalance: +(Number(watchOnly.unlockedBalance || 0) + treasuryBal.available).toFixed(6),
      pendingBalance: +(Number(watchOnly.pendingBalance || 0) + treasuryBal.pending).toFixed(6),
      source: 'combined'
    };
  } catch { /* use @crown_treasury chainLedger balance */ }
  // The simulated chain still has a height and is usable, so surface it even
  // when no daemon is reachable.
  if (!net.height && capabilities.chainHeight) {
    net.height = capabilities.chainHeight;
    net.online = true;
    net.mode = capabilities.mode === 'simulate' ? 'simulated' : net.mode;
  }
  res.json({
    network: net,
    crownEstateFund,
    chain: capabilities,
    config: {
      ticker: CONFIG.NUMISTA.TICKER,
      name: CONFIG.NUMISTA.NAME,
      crownEstateBlockReward: CONFIG.ECONOMY.TREASURY_BLOCK_REWARD_NUM,
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

  // Load the custodial wallet up front so subaddress and asset operations do
  // not each pay the "No wallet file" retry cost.
  numistaRpc.ensureWalletOpen()
    .then(result => console.log(`[wallet-rpc] custodial wallet ready: ${result.filename}`))
    .catch(err => console.warn(`[wallet-rpc] custodial wallet not ready: ${err.message}`));

  console.log(`[chain] mode=${capabilities.mode} ready=${capabilities.ready} :: ${capabilities.reason}`);

  app.listen(CONFIG.PORT, () => {
    console.log(`[Goldnumista] Server active on http://localhost:${CONFIG.PORT}`);
  });
}

boot().catch(err => {
  console.error('[boot] Fatal:', err);
  process.exit(1);
});
