import { searchBlockchain } from './numista/chainIndexer.js';
import fs from 'node:fs';
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
import { stratumBridge } from './mining/stratumBridge.js';
import { startBuiltInStratumServer } from './mining/stratumServer.js';
import { cryptoOnramp } from './payment/onramp.js';
import { stripeOnramp } from './payment/stripeOnramp.js';
import { RARITY_TIERS } from './data/plotGrid.js';
import { chainAdapter } from './numista/chainAdapter.js';
import { mintQueue } from './numista/mintQueue.js';
import { chainLedger } from './data/chainLedger.js';
import { readDeedMetadata, NUM_ASSET_ID, CURRENCY_ASSET_TYPE, CURRENCY_SCHEMA, toUnits, metadataHash } from './data/deedRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());

app.post('/api/onramp/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = stripeOnramp.verifyWebhook(req.body, req.headers['stripe-signature']);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const result = await stripeOnramp.handleEvent(event, { gameStore, numistaRpc, mintQueue });
    res.json(result);
  } catch (err) {
    console.error(`[onramp] Webhook ${event.id} failed: ${err.message}`);
    res.status(500).json({ error: 'Payment event could not be processed; Stripe may retry it' });
  }
});

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

  const user = userManager.verifyToken(token);

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

function atomicUnitsToDecimal(value, decimals = 12) {
  const raw = String(value == null ? '0' : value);
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).replace(/[^0-9]/g, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

function assetUnitsToNum(value) {
  const digits = String(value == null ? '0' : value).replace(/[^0-9]/g, '') || '0';
  const unitsPerNum = CONFIG.CHAIN.UNITS_PER_NUM;
  if (!unitsPerNum) return '0';
  const scaled = BigInt(digits);
  const base = BigInt(unitsPerNum);
  const whole = scaled / base;
  const remainder = scaled % base;
  if (remainder === 0n) return String(whole);
  const fraction = (remainder * 1000000n / base).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fraction}`;
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
      .createAccount(`Worldtycoon @${username}`, userManager.getUser(username)?.password || '')
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

function makeIdentityReceipt({ address, username, secretPassword, txHash = null, blockHeight = null }) {
  return {
    address: address || null,
    username: username ? String(username).toLowerCase() : null,
    secretPassword: secretPassword || null,
    txHash: txHash || null,
    blockHeight: blockHeight ?? null
  };
}

function upsertWalletUser({ username, password, role, receiveAddress, identityReceipt }) {
  const clean = String(username || '').trim().toLowerCase();
  let user = userManager.getUser(clean);
  if (!user) {
    userManager.register({ username: clean, password });
    user = userManager.getUser(clean);
  }
  if (!user) throw new Error('Could not create wallet user');
  user.password = password;
  user.role = role;
  user.receiveAddress = {
    address: receiveAddress.address,
    accountIndex: Number(receiveAddress.accountIndex) || 0,
    addressIndex: Number(receiveAddress.addressIndex) || 0
  };
  user.chainIdentity = 'registered';
  user.identityReceipt = identityReceipt;
  userManager.save();
  return user;
}

app.post('/api/auth/wallet-register', async (req, res) => {
  try {
    const capabilities = await chainAdapter.capabilities();
    if (capabilities.mode === 'simulate') {
      const username = `sim_${crypto.randomBytes(8).toString('hex')}`;
      const secretPassword = crypto.randomBytes(32).toString('hex');
      const created = userManager.register({ username, password: secretPassword });
      const user = userManager.getUser(username);
      user.identityReceipt = {
        ...makeIdentityReceipt({ username, secretPassword }),
        simulated: true
      };
      userManager.save();
      chainLedger.ensure(username);
      return res.json({
        success: true,
        simulated: true,
        address: null,
        accountIndex: null,
        username,
        displayHandle: username,
        txHash: null,
        blockHeight: null,
        secretPassword,
        role: created.role,
        token: created.token
      });
    }

    const created = await numistaRpc.registerWalletAddress();
    const role = created.accountIndex === 0 ? 'admin' : 'user';
    const identityReceipt = makeIdentityReceipt({
      address: created.address,
      username: created.username,
      secretPassword: created.secretPassword,
      txHash: created.txHash,
      blockHeight: created.blockHeight
    });
    upsertWalletUser({
      username: created.username,
      password: created.secretPassword,
      role,
      receiveAddress: { address: created.address, accountIndex: created.accountIndex, addressIndex: 0 },
      identityReceipt
    });
    const token = userManager.login({ username: created.username, password: created.secretPassword }).token;
    res.json({
      success: true,
      address: created.address,
      accountIndex: created.accountIndex,
      username: created.username,
      displayHandle: created.displayHandle,
      txHash: created.txHash,
      blockHeight: created.blockHeight,
      secretPassword: created.secretPassword,
      role,
      token
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/wallet-login', async (req, res) => {
  try {
    const id = String(req.body?.identifier || req.body?.username || '').trim();
    const pw = String(req.body?.password || '').trim();

    // A saved receipt is the durable fast path. It also keeps secret login
    // working after the registration transaction falls outside the recent
    // block scan window.
    const stored = userManager.findByAddress(id) || userManager.getUser(id.replace(/^@/, '').trim().toLowerCase());
    const storedSecret = stored?.identityReceipt?.secretPassword;
    if (storedSecret && pw && storedSecret.toLowerCase() === pw.toLowerCase()) {
      const token = userManager.issueToken(stored.username);
      return res.json({
        success: true,
        address: stored.identityReceipt.address || stored.receiveAddress?.address,
        accountIndex: stored.receiveAddress?.accountIndex,
        username: stored.username,
        displayHandle: stored.username,
        txHash: stored.identityReceipt.txHash || null,
        blockHeight: stored.identityReceipt.blockHeight ?? null,
        secretPassword: storedSecret,
        role: stored.role || 'user',
        token
      });
    }

    const verified = await numistaRpc.authenticateByAddressOrName(id, pw);
    const role = verified.accountIndex === 0 ? 'admin' : 'user';
    const identityReceipt = makeIdentityReceipt({
      address: verified.address,
      username: verified.username,
      secretPassword: role === 'admin' ? null : pw,
      txHash: verified.txHash,
      blockHeight: null
    });
    upsertWalletUser({
      username: verified.username,
      password: pw,
      role,
      receiveAddress: { address: verified.address, accountIndex: verified.accountIndex, addressIndex: 0 },
      identityReceipt
    });
    const token = userManager.login({ username: verified.username, password: pw }).token;
    res.json({
      success: true,
      address: verified.address,
      accountIndex: verified.accountIndex,
      username: verified.username,
      displayHandle: verified.displayHandle || verified.username,
      txHash: verified.txHash,
      blockHeight: null,
      secretPassword: identityReceipt.secretPassword,
      role,
      token
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/auth/identity-receipt', (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  const user = userManager.getUser(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const receipt = user.identityReceipt || null;
  const fallbackSecret = String(user.password || '').length === 64 ? user.password : null;
  res.json({
    username: user.username,
    address: receipt?.address || user.receiveAddress?.address || null,
    secretPassword: receipt?.secretPassword || fallbackSecret,
    txHash: receipt?.txHash || null,
    blockHeight: receipt?.blockHeight ?? null
  });
});
app.post("/api/auth/claim-username", async (req, res) => { try { const cur = requireSessionUser(req, res); if (!cur) return; const recv = await getOrCreateReceiveAddress(cur); const u = userManager.getUser(cur); const feeJob = gameStore._enqueueNumTransfer({ type: 'handle_mint', from: cur, to: 'crown_treasury', amount: 1, description: 'Mint Tradeable @Handle (1 NUM)' }); const claimed = await numistaRpc.claimOnChainUsername(recv.accountIndex, req.body?.username, u?.password || ""); chainLedger.enqueueUsernameRegistration(claimed, recv.address); if (!userManager.users.has(claimed)) userManager.register({ username: claimed, password: u?.password || "password123" }); userManager.setReceiveAddress(claimed, recv); const loginRes = userManager.login({ username: claimed, password: u?.password || "password123" }); res.json({ success: true, username: claimed, address: recv.address, token: loginRes.token }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/titles/buy', (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    const purchase = gameStore.purchasePeerage(username, String(req.body?.titleKey || '').toLowerCase());
    res.json({ success: true, ...purchase, wallet: walletView(username) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    let result;
    try {
      result = userManager.login({ username, password });
    } catch (loginErr) {
      const uname = String(username || '').trim().toLowerCase();
      if (!uname || !password || userManager.users.has(uname)) {
        throw loginErr;
      }
      const verified = await numistaRpc.authenticateWalletUser(uname, password);
      if (!verified) {
        throw new Error('Account not found on Numista blockchain. Please register first.');
      }
      userManager.register({ username: uname, password });
      userManager.setReceiveAddress(uname, {
        address: verified.address,
        accountIndex: verified.accountIndex,
        addressIndex: 0
      });
      result = userManager.login({ username: uname, password });
    }

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
    title: gameStore.playerTitles[user.username] || null,
    receiveAddress: user.receiveAddress || null,
    wallet: walletView(user.username)
  });
});

// ----------------------------------------------------
// PLOTS & BUILDINGS API (Worldtycoon UK Registry)
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
  isCastle: !!plot.isCastle,
  garrison: Number(plot.garrison) || 0,
  health: Number(plot.health ?? (plot.isCastle ? 1000 : 100)),
  maxHealth: Number(plot.maxHealth ?? (plot.isCastle ? 1000 : 100)),
  fortificationLevel: Number(plot.fortificationLevel || 0),
  siege: plot.siege || null,
  castleOwner: plot.castleOwner || null,
  controller: plot.controller || plot.castleOwner || null,
  isClaimed: !!plot.isClaimed,
  owner: plot.owner ? (plot.owner.startsWith('@') ? plot.owner : `@${plot.owner}`) : null,
  rarity: plot.rarity,
  rarityKey: plot.rarityKey,
  rarityName: plot.rarityName,
  price: plot.price,
  building: plot.building ? { ...plot.building } : null,
  stockpile: { ...(plot.stockpile || {}) },
  marketListing: plot.marketListing ? { ...plot.marketListing } : null,
  marketSalePending: !!plot.marketSaleJobId,
  resourceDeposits: { ...(plot.resourceDeposits || {}) },
  structures: (plot.structures || []).map(structure => ({ ...structure })),
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

app.get('/api/account', async (req, res) => {
  const username = (req.query.username || req.headers['x-numista-user'] || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  // Deeds are on-chain assets. Rebuild claimed plots from the chain before
  // answering so a restart never hides a deed that was actually minted.
  await gameStore.reconcileChainDeeds().catch(err => {
    console.warn('[account] Deed reconcile failed:', err.message);
  });

  const user = userManager.getUser(username);
  const deeds = gameStore.getAllPlots()
    .filter(p => p.isClaimed && (p.owner || '').replace(/^@/, '').toLowerCase() === username.replace(/^@/, '').toLowerCase())
    .map(toPublicPlot);

  res.json({
    account: user ? {
      username: user.username,
      role: userManager.getRole(user.username),
      title: gameStore.playerTitles[user.username] || null,
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

app.get('/api/account/deeds', async (req, res) => {
  const username = (req.query.username || req.headers['x-numista-user'] || '').toString().trim();
  if (!username) return res.status(400).json({ error: 'username is required' });

  await gameStore.reconcileChainDeeds().catch(() => {});

  const deeds = gameStore.getAllPlots()
    .filter(p => p.isClaimed && (p.owner || '').toLowerCase() === username.toLowerCase())
    .map(toPublicPlot);

  res.json({ username, deeds, deedCount: deeds.length });
});

app.get('/api/plots', async (req, res) => {
  await gameStore.reconcileChainDeeds().catch(() => {});
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

app.get('/api/plots/:id', async (req, res) => {
  await gameStore.reconcileChainDeeds().catch(() => {});
  const plot = gameStore.getPlotById(req.params.id);
  if (!plot) return res.status(404).json({ error: 'Plot not found' });
  const job = gameStore.getJobForPlot(plot.id);
  const viewer = userManager.verifyToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const canViewJob = job && viewer &&
    (String(job.username || '').toLowerCase() === viewer.username || userManager.isAdmin(viewer.username));
  res.json({
    plot: toPublicPlot(plot),
    job: canViewJob ? mintQueue.publicJob(job) : null
  });
});

// Claim plot: registers the deed to a USERNAME and mints it on-chain.
app.post('/api/plots/:id/unfreeze', (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  if (userManager.getRole(username) !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can reset plots' });
  }
  const plot = gameStore.getPlotById(req.params.id);
  if (!plot) return res.status(404).json({ error: 'Plot not found' });
  const prevOwner = plot.owner;
  plot.isClaimed = false;
  plot.owner = null;
  plot.controller = null;
  plot.castleOwner = plot.isCastle ? (plot.castleOwner || 'crown_treasury') : null;
  plot.health = plot.maxHealth || (plot.isCastle ? 1000 : 100);
  plot.siege = null;
  plot.fortificationLevel = 0;
  plot.building = null;
  plot.pendingJobId = null;
  plot.nftState = { stage: 'unminted' };
  if (prevOwner) {
    const balance = chainLedger.getBalance(prevOwner);
    if (balance.locked > 0) chainLedger.unlock(prevOwner, balance.locked);
  }
  gameStore.save();
  res.json({ ok: true, plot: toPublicPlot(plot) });
});

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

app.post('/api/plots/:id/build', (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    const plot = gameStore.buildPlotStructure(req.params.id, username, req.body?.structureType);
    res.json({ success: true, plot: toPublicPlot(plot) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/army', (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  res.json({ army: gameStore.getArmy(username) });
});

app.post('/api/army/recruit', (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    res.json({ success: true, ...gameStore.recruitSoldiers(username, req.body?.unitType, req.body?.count) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/soldiers', (req, res) => { const username = requireSessionUser(req, res); if (!username) return; res.json({ soldiers: gameStore.playerSoldiers[username] || [], equipment: gameStore.getEquipment(username), army: gameStore.getArmy(username) }); });
app.post('/api/soldiers/:id/equip', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; res.json({ success: true, ...gameStore.equipSoldier(username, req.params.id, req.body?.itemId) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/soldiers/:id/heal', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; res.json({ success: true, ...gameStore.healSoldier(username, req.params.id) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/plots/:id/craft', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; const out = gameStore.craftEquipment(req.params.id, username, req.body?.recipe); res.json({ success: true, ...out, plot: toPublicPlot(out.plot) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/plots/:id/metal-mint', (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    const result = gameStore.mintPlotMetal({
      plotId: req.params.id,
      username,
      metal: req.body?.metal,
      form: req.body?.form,
      weightGrams: req.body?.weightGrams,
      purity: req.body?.purity
    });
    res.json({ success: true, ...result, plot: toPublicPlot(gameStore.getPlotById(req.params.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/army/create', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; res.json({ success: true, army: gameStore.createArmy(username, req.body?.name, req.body?.soldierIds) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/army/:id/march-estimate', async (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    const estimate = await gameStore.getArmyMarchEstimate(username, req.params.id, req.query.targetPlotId);
    res.json({ estimate });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/army/:id/move', async (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    const result = await gameStore.moveArmy(username, req.params.id, req.body?.targetPlotId, !!req.body?.siege);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post('/api/plots/:id/repair', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; const plot = gameStore.repairPlot(req.params.id, username); res.json({ success: true, plot: toPublicPlot(plot) }); } catch (err) { res.status(400).json({ error: err.message }); } });
app.post('/api/plots/:id/fortify', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; const plot = gameStore.fortifyPlot(req.params.id, username); res.json({ success: true, plot: toPublicPlot(plot) }); } catch (err) { res.status(400).json({ error: err.message }); } });

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
app.post('/api/plots/collect-all-income', (req, res) => { try { const username = requireSessionUser(req, res); if (!username) return; res.json(gameStore.collectAllIncome(username)); } catch (err) { res.status(400).json({ error: err.message }); } });

app.get('/api/castles', (req, res) => {
  res.json({ castles: gameStore.getConquerableCastles().map(toPublicPlot) });
});

app.post('/api/castles/:id/conquer', async (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    if (!req.body?.armyId) return res.status(400).json({ error: 'Choose an army to march on this castle' });
    const result = await gameStore.moveArmy(username, req.body.armyId, req.params.id, true);
    res.json({ success: true, ...result, message: 'Silver payroll is submitted; the army marches after confirmation.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

function canReadJob(job, username) {
  return String(job?.username || '').toLowerCase() === username || userManager.isAdmin(username);
}

app.get('/api/jobs', (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  res.json({
    jobs: mintQueue.getJobsFor(username).map(j => mintQueue.publicJob(j)).filter(Boolean),
    summary: mintQueue.summary()
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  const job = mintQueue.getJob(req.params.id);
  if (!job || !canReadJob(job, username)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json({ job: mintQueue.publicJob(job) });
});

app.get('/api/plots/:id/job', (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  const job = gameStore.getJobForPlot(req.params.id);
  if (job && !canReadJob(job, username)) {
    return res.status(404).json({ error: 'Job not found' });
  }
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

app.get('/api/assets/:assetId/metadata', (req, res) => {
  const payload = readDeedMetadata(req.params.assetId);
  if (!payload) return res.status(404).json({ error: 'Asset metadata not found' });
  res.json(payload);
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

app.get('/api/battles', (req, res) => {
  res.json({ battles: gameStore.battleLog.slice(0, Math.min(100, Math.max(1, Number(req.query.limit) || 25))) });
});

app.get('/api/battles/:assetId', async (req, res) => {
  try {
    const assetId = String(req.params.assetId || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(assetId)) return res.status(400).json({ error: 'Invalid battle asset ID' });
    const saved = readDeedMetadata(assetId);
    if (!saved || saved.metadata?.schema !== 'townforge.numista.battle/v1') return res.status(404).json({ error: 'Battle report not found' });
    const asset = await chainAdapter.getAsset(assetId).catch(() => null);
    const held = await chainAdapter.getAssetBalance(assetId, saved.metadata.attacker).catch(() => 0);
    res.json({ assetId, report: saved.metadata, metadataHash: saved.metadataHash, txHash: gameStore.battleLog.find(b => b.assetId === assetId)?.txHash || null, verified: !!(saved.verified && asset && asset.metadataHash === saved.metadataHash && Number(held) >= 1), onChainAsset: asset ? { assetId: asset.assetId, assetType: asset.assetType, metadataHash: asset.metadataHash, createdHeight: asset.createdHeight || null } : null, ownerUnits: Number(held) });
  } catch (err) { res.status(500).json({ error: err.message || 'Could not verify battle report' }); }
});

// ----------------------------------------------------
// COIN MINTS (admin only)
// ----------------------------------------------------

app.post("/api/plots/:id/list", async (req, res) => { try { const u = requireSessionUser(req, res); if (!u) return; const plot = await gameStore.listPlotForSale(req.params.id, u, req.body?.priceNum); res.json({ success: true, plot: toPublicPlot(plot) }); } catch (e) { res.status(400).json({ error: e.message }); } }); app.post("/api/plots/:id/buy", async (req, res) => { try { const u = requireSessionUser(req, res); if (!u) return; const out = await gameStore.buyListedPlot(req.params.id, u); res.json({ success: true, ...out, plot: toPublicPlot(out.plot), wallet: walletView(u) }); } catch (e) { res.status(400).json({ error: e.message }); } }); app.post("/api/mint/predecimal", (req, res) => { try { const u = requireSessionUser(req, res); if (!u) return; const out = gameStore.mintPreDecimalAssortment({ amountNum: req.body?.amountNum, mintPlotId: req.body?.mintPlotId, username: u }); res.json({ success: true, ...out, wallet: walletView(u) }); } catch (e) { res.status(400).json({ error: e.message }); } });
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

app.get("/api/mints/my-coins", (req, res) => { const u = requireSessionUser(req, res); if (!u) return; const allCoins = gameStore.getMintLedger(500).flatMap(b => b.coins || []).filter(c => String(c.owner || "").replace(/^@/, "").toLowerCase() === u.replace(/^@/, "").toLowerCase()); const yieldBonus = typeof gameStore.getPlayerYieldBonus === 'function' ? gameStore.getPlayerYieldBonus(u) : 0; res.json({ coins: allCoins, yieldBonus, gameCoinBalance: Number(gameStore.playerCoinPurses[u] || 0) }); });
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
    auctions: gameStore.sweepExpiredAuctions().map(a => ({
      ...a,
      seller: a.seller.startsWith('@') ? a.seller : `@${a.seller}`,
      highestBidder: a.highestBidder ? (a.highestBidder.startsWith('@') ? a.highestBidder : `@${a.highestBidder}`) : null
    }))
  });
});

app.post("/api/auctions/create", async (req, res) => { try { const u = requireSessionUser(req, res); if (!u) return; const { category, assetRef, title, startingBid, buyoutPrice, durationHours } = req.body || {}; const auc = await gameStore.createUniversalAuction({ seller: u, category, assetRef, title, startingBid, buyoutPrice, durationHours }); res.json({ success: true, auction: auc }); } catch (e) { res.status(400).json({ error: e.message }); } }); app.post("/api/auctions/:id/buyout", async (req, res) => { try { const u = requireSessionUser(req, res); if (!u) return; const auc = await gameStore.buyoutAuction(req.params.id, u); res.json({ success: true, auction: auc, wallet: walletView(u) }); } catch (e) { res.status(400).json({ error: e.message }); } });
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
    // Credit in-game NUM to each miner's ledger balance (native NUM goes to treasury via block template).
    // A native transfer is NOT sent per share — coinbase rewards go to the treasury address embedded
    // in the block template; in-game NUM is then minted proportionally when chainLedger settles.
    if (result.accepted && result.payouts?.length) {
      for (const po of result.payouts) {
        try {
          const minerUsername = String(po.username || '').toLowerCase();
          if (po.amount > 0 && minerUsername && minerUsername !== 'anon') {
            chainLedger.ensure(minerUsername);
            chainLedger.receiveChain(minerUsername, po.amount);
            chainLedger.recordChainMove({
              username: minerUsername,
              amount: po.amount,
              description: result.isBlockHit
                ? 'Mining block reward (PPLNS payout)'
                : 'Mining share reward',
              txHash: result.nativeBlockSubmitted ? (result.blockHash || null) : null,
              status: result.nativeBlockSubmitted ? 'confirmed' : 'local',
              height: result.blockHeight || null
            });
          }
        } catch (err) {
          console.warn('[mining] Failed to credit miner', po.username, err.message);
        }
      }
    }
    result.wallet = walletView(username);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/mining/stratum/status', (req, res) => {
  const username = req.session?.user?.username || req.query.username || '';
  res.json(stratumBridge.getStatus(username));
});

app.post('/api/mining/stratum/connect', async (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const recv = await getOrCreateReceiveAddress(username);
    const status = await stratumBridge.connect({
      username,
      poolEndpoint: req.body?.poolEndpoint,
      loginAddress: req.body?.customAddress || recv.address,
      workerName: req.body?.workerName || username,
      mode: req.body?.mode || 'pplns'
    });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mining/stratum/submit', (req, res) => {
  try {
    const username = requireUser(req, res);
    if (!username) return;
    const status = stratumBridge.submitShare({
      username,
      jobId: req.body?.jobId,
      nonceHex: req.body?.nonceHex,
      resultHex: req.body?.resultHex
    });
    res.json({ accepted: true, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/mining/stratum/disconnect', (req, res) => {
  const username = requireUser(req, res);
  if (!username) return;
  res.json(stratumBridge.disconnect(username));
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
      nettype: daemonInfo.nettype || null
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

app.post('/api/onramp/order', async (req, res) => {
  try {
    const username = requireSessionUser(req, res);
    if (!username) return;
    if (!stripeOnramp.mode) {
      return res.status(503).json({ error: stripeOnramp.getUnavailableReason() });
    }
    if (stripeOnramp.mode === 'live') {
      const capabilities = await chainAdapter.capabilities();
      const daemonNetwork = String(capabilities.node?.nettype || numistaRpc.syncStatus.nettype || '');
      if (capabilities.mode !== 'live' || !capabilities.ready ||
          !/mainnet/i.test(daemonNetwork) || numistaRpc.syncStatus.synchronized === false) {
        return res.status(503).json({ error: 'Live checkout is blocked until a synchronized Numista mainnet daemon is verified' });
      }
    }
    const destination = String(req.body?.destination || '');
    const walletAddress = String(req.body?.walletAddress || '').trim();
    let gameTreasuryAvailable = 0;
    let nativeTreasuryAvailable = 0;
    if (destination === 'game_balance') {
      const units = Number(await chainAdapter.getAssetBalance(NUM_ASSET_ID, CONFIG.CHAIN.TREASURY_USERNAME));
      gameTreasuryAvailable = units / CONFIG.CHAIN.UNITS_PER_NUM;
    }
    if (destination === 'native_wallet') {
      if (CONFIG.NUMISTA.NETTYPE !== 'numista-mainnet' || CONFIG.CHAIN.MODE !== 'live') {
        return res.status(503).json({ error: 'Native wallet delivery is unavailable until mainnet is verified' });
      }
      const validation = await numistaRpc.validateAddress(walletAddress);
      if (!validation?.valid) return res.status(400).json({ error: 'Enter a valid mainnet NUM wallet address' });
      const walletBalance = await numistaRpc.getWalletBalance(0);
      if (walletBalance.source === 'unavailable') {
        return res.status(503).json({ error: 'Mainnet treasury wallet is unavailable' });
      }
      nativeTreasuryAvailable = Number(walletBalance.unlockedBalance) || 0;
    }
    const result = await stripeOnramp.createCheckout({
      username,
      amountGBP: req.body?.amount,
      destination,
      walletAddress: destination === 'native_wallet' ? walletAddress : null,
      gameTreasuryAvailable,
      nativeTreasuryAvailable
    });
    res.json(result);
  } catch (err) {
    const message = err.message || 'Could not create checkout';
    const status = /Stripe|checkout|secret|HTTPS|public base URL|temporarily unavailable/i.test(message) ? 503 : 400;
    res.status(status).json({ error: message });
  }
});

app.post('/api/onramp/complete', (req, res) => {
  res.status(410).json({ error: 'Payment completion is handled only by Stripe’s signed webhook' });
});

app.get('/api/onramp/orders/:sessionId', async (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;
  const order = stripeOnramp.getOrderBySession(req.params.sessionId);
  if (!order || order.username !== username) return res.status(404).json({ error: 'Payment order not found' });
  await stripeOnramp.reconcile({ gameStore, numistaRpc, mintQueue });
  res.json({ order: stripeOnramp.publicOrder(order) });
});

const onrampReconcileTimer = setInterval(() => {
  stripeOnramp.reconcile({ gameStore, numistaRpc, mintQueue })
    .catch(err => console.error(`[onramp] Reconciliation failed: ${err.message}`));
}, 15000);
onrampReconcileTimer.unref?.();

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

app.post('/api/dev/sim/deposit-failure', async (req, res) => {
  if (!DEV_RPC_ENABLED) return res.status(404).json({ error: 'Not found' });
  const username = requireAdmin(req, res);
  if (!username) return;
  try {
    const amount = +Number(req.body?.amount || 1).toFixed(4);
    if (!(amount > 0)) return res.status(400).json({ error: 'Deposit amount must be positive' });
    const balanceBeforeUnits = Number(await chainAdapter.getAssetBalance(NUM_ASSET_ID, username));
    const asset = await chainAdapter.getAsset(NUM_ASSET_ID);
    if (!asset) return res.status(503).json({ error: 'Simulated currency asset is unavailable' });
    await chainAdapter.injectFailure(1);
    chainLedger.addPending(username, amount);
    const job = mintQueue.enqueue({
      type: 'deposit',
      username,
      assetId: NUM_ASSET_ID,
      snapshot: { amount, balanceBeforeUnits, nativeTxHash: 'simulated-native-deposit' },
      meta: { name: 'Simulated native deposit recovery test' },
      steps: [{
        key: 'mint',
        label: `Convert ${amount} native NUM to in-game NUM`,
        operation: {
          kind: 'mint',
          accountIndex: 0,
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          recipient: username,
          amountUnits: toUnits(amount)
        }
      }]
    });
    res.json({ job: mintQueue.publicJob(job) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/dev/sim/deposit', async (req, res) => {
  if (!DEV_RPC_ENABLED) return res.status(404).json({ error: 'Not found' });
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const username = String(req.body?.recipientUsername || admin).trim().toLowerCase();
    const amount = Number(req.body?.amount);
    if (!userManager.getUser(username)) return res.status(404).json({ error: 'Deposit recipient not found' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return res.status(400).json({ error: 'Deposit amount must be between 0 and 1,000,000 NUM' });
    }
    const balanceBeforeUnits = Number(await chainAdapter.getAssetBalance(NUM_ASSET_ID, username));
    if (!await chainAdapter.getAsset(NUM_ASSET_ID)) {
      return res.status(503).json({ error: 'Simulated currency asset is unavailable' });
    }

    const job = mintQueue.enqueue({
      type: 'deposit',
      username,
      assetId: NUM_ASSET_ID,
      snapshot: { amount, balanceBeforeUnits, nativeTxHash: 'simulated-native-deposit' },
      meta: { name: 'Simulated native deposit' },
      steps: [{
        key: 'mint',
        label: `Convert ${amount} native NUM to in-game NUM`,
        operation: {
          kind: 'mint',
          accountIndex: 0,
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          recipient: username,
          amountUnits: toUnits(amount)
        }
      }]
    });
    chainLedger.addPending(username, amount);
    res.json({ job: mintQueue.publicJob(job), simulated: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/dev/sim/tick', (req, res) => {
  if (!DEV_RPC_ENABLED) return res.status(404).json({ error: 'Not found' });
  if (!requireAdmin(req, res)) return;
  const ticks = Number(req.body?.ticks);
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > 1000) {
    return res.status(400).json({ error: 'Ticks must be an integer from 1 to 1000' });
  }
  for (let i = 0; i < ticks; i++) gameStore.tickSimulation();
  res.json({ ticks });
});

app.post('/api/dev/sim/expire-auction/:id', (req, res) => {
  if (!DEV_RPC_ENABLED) return res.status(404).json({ error: 'Not found' });
  if (!requireAdmin(req, res)) return;
  const auction = gameStore.auctions.find(item => item.id === req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  auction.endsAt = new Date(Date.now() - 1000).toISOString();
  gameStore.sweepExpiredAuctions();
  const job = auction.settlementJobId ? mintQueue.getJob(auction.settlementJobId) : null;
  res.json({ auction, job: job ? mintQueue.publicJob(job) : null });
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

const nativeAutoCreditJobs = new Map();

/**
 * Stateless native-deposit credit.
 *
 * Confirmed native deposits are detected from wallet history. The native coin
 * is swept to the vault, then the existing deposit job mints the equivalent
 * in-game NUM. No local "already credited" file is needed: the difference
 * between confirmed incoming and all outgoing native transfers is the
 * uncredited amount, and the sweep itself becomes an outgoing transfer.
 */
async function autoCreditNativeDeposits(username, receiveAddress, receiveInfo) {
  if (chainAdapter.mode !== 'live') return null;
  if (nativeAutoCreditJobs.has(username)) return null;
  if (mintQueue.jobs.some(job => job.username === username && ['deposit', 'currency_mint'].includes(job.type))) return null;

  const minConf = Number(CONFIG.CHAIN.CONFIRMATIONS) || 10;
  const incoming = (receiveInfo.incomingTransfers || []).filter(
    transfer => transfer.status === 'confirmed' &&
      Number(transfer.confirmations) >= minConf &&
      Number(transfer.amount) > 0
  );
  if (!incoming.length) return null;

  const totalIncoming = incoming.reduce((sum, transfer) => sum + Number(transfer.amount || 0), 0);
  const outgoingResult = await numistaRpc._walletRpc('get_transfers', {
    out: true,
    pending: true,
    pool: true,
    account_index: receiveAddress.accountIndex
  }).catch(() => null);
  const outgoing = [
    ...(outgoingResult?.out || []),
    ...(outgoingResult?.pending || []),
    ...(outgoingResult?.pool || [])
  ];
  const totalOutgoing = outgoing.reduce((sum, transfer) => sum + Number(transfer.amount || 0), 0) / 1e12;
  const uncredited = +(totalIncoming - totalOutgoing).toFixed(4);
  if (!(uncredited > 0)) return null;

  const fee = +(Number(CONFIG.ECONOMY.TRANSFER_NETWORK_FEE_NUM) || 0.05).toFixed(4);
  const gasReserve = 0.02;
  const nativeAmount = +(uncredited - gasReserve).toFixed(4);
  const creditAmount = +(nativeAmount - fee).toFixed(4);
  if (creditAmount < 0.1) return null;
  if (Number(receiveInfo.unlockedBalance || 0) < +(nativeAmount + 0.01).toFixed(4)) return null;

  const jobPromise = (async () => {
    const balanceBeforeUnits = Number(await chainAdapter.getAssetBalance(NUM_ASSET_ID, username));
    const vaultInfo = await numistaRpc.getWalletAddress(0, 0);
    const nativeTx = await numistaRpc.sendTransfer({
      toAddress: vaultInfo.address,
      amountNum: nativeAmount,
      accountIndex: receiveAddress.accountIndex
    });

    const steps = [];
    const assetExists = await chainAdapter.getAsset(NUM_ASSET_ID);
    if (!assetExists) {
      steps.push({
        key: 'create_currency',
        label: 'Create fungible NUM currency asset',
        operation: {
          kind: 'create_asset',
          accountIndex: 0,
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          maxSupply: CONFIG.CHAIN.MAX_SUPPLY_UNITS,
          metadataHash: metadataHash(CURRENCY_SCHEMA)
        }
      });
    }
    const existingReg = chainLedger.getUsernameRecord(username) || await chainAdapter.getUsernameKey(username);
    if (!existingReg) {
      steps.push({
        key: 'register_user',
        label: `Register @${username} on-chain`,
        operation: {
          kind: 'register_username',
          accountIndex: 0,
          username,
          key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
        }
      });
    }
    steps.push({
      key: 'mint',
      label: `Auto-convert ${creditAmount} native NUM to in-game NUM`,
      operation: {
        kind: 'mint',
        accountIndex: 0,
        assetId: NUM_ASSET_ID,
        assetType: CURRENCY_ASSET_TYPE,
        recipient: username,
        amountUnits: toUnits(creditAmount)
      }
    });

    chainLedger.addPending(username, creditAmount);
    try {
      return mintQueue.enqueue({
        type: 'deposit',
        username,
        assetId: NUM_ASSET_ID,
        snapshot: {
          amount: creditAmount,
          balanceBeforeUnits,
          fee,
          nativeTxHash: nativeTx.txHash,
          depositTxHash: nativeTx.txHash,
          depositTxHashes: [nativeTx.txHash]
        },
        meta: { name: `Auto-convert ${creditAmount} native NUM to in-game NUM` },
        steps
      });
    } catch (err) {
      chainLedger.dropPending(username, creditAmount);
      throw err;
    }
  })();

  nativeAutoCreditJobs.set(username, jobPromise);
  try {
    return await jobPromise;
  } finally {
    nativeAutoCreditJobs.delete(username);
  }
}

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

    const balanceBeforeUnits = Number(await chainAdapter.getAssetBalance(NUM_ASSET_ID, username));
    // Send 1:1 backing plus the Worldtycoon conversion fee from the player's native account.
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
          accountIndex: 0,
          assetId: NUM_ASSET_ID,
          assetType: CURRENCY_ASSET_TYPE,
          maxSupply: CONFIG.CHAIN.MAX_SUPPLY_UNITS,
          metadataHash: metadataHash(CURRENCY_SCHEMA)
        }
      });
    }
    const existingReg = chainLedger.getUsernameRecord(username) || await chainAdapter.getUsernameKey(username);
    if (!existingReg) {
      
      steps.push({
        key: 'register_user',
        label: `Register @${username} on-chain`,
        operation: {
          kind: 'register_username',
          accountIndex: 0,
          username,
          key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
        }
      });
    }
    steps.push({
      key: 'mint',
      label: `Convert ${amount} native NUM to in-game NUM (player-paid gas)`,
      operation: {
        kind: 'mint',
        accountIndex: 0,
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
      snapshot: { amount, fee, balanceBeforeUnits, nativeTxHash: nativeTx.txHash, depositTxHash: nativeTx.txHash, depositTxHashes: [nativeTx.txHash] },
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

    res.json({
      ...receiveAddress,
      ...receiveInfo
    });

    // Fire-and-forget so the receive endpoint stays responsive. The helper
    // sweeps confirmed native deposits to the vault and queues the matching
    // in-game mint. It is guarded by active jobs and by chain history, so it
    // does not need a local "already credited" file.
    autoCreditNativeDeposits(username, receiveAddress, receiveInfo)
      .catch(err => console.warn('[deposit] Auto-credit failed:', err.message));

  } catch (err) {
    console.error('RECEIVE ADDRESS ERROR:', err);

    res.status(503).json({
      error: `Receive address unavailable: ${err.message}`
    });
  }
});

app.get('/api/wallet/portfolio', async (req, res) => {
  const username = requireSessionUser(req, res);
  if (!username) return;

  const capabilities = await chainAdapter.capabilities();
  const height = Number(capabilities.chainHeight || 0);
  const network = capabilities.mode === 'simulate' ? 'simulated' : CONFIG.NUMISTA.NETTYPE;
  const launchRate = Number.isFinite(CONFIG.ECONOMY.LAUNCH_REFERENCE_GBP_PER_NUM)
    ? Math.max(0, CONFIG.ECONOMY.LAUNCH_REFERENCE_GBP_PER_NUM)
    : 0.25;

  try {
    let assetUnits = '0';
    let assetMetadata = null;

    if (capabilities.mode === 'simulate') {
      const units = await chainAdapter.getAssetBalance(NUM_ASSET_ID, username);
      assetUnits = String(units == null ? 0 : units);
    } else if (capabilities.mode === 'live') {
      if (!CONFIG.CHAIN.CURRENCY_ASSET_ID) {
        return res.status(503).json({
          network,
          height,
          username,
          error: 'NUM asset identity is unavailable: NUMISTA_CURRENCY_ASSET_ID is not configured',
          gameNum: { available: false },
          nativeNum: { available: false },
          nativeSupply: { available: false },
          asOf: new Date().toISOString()
        });
      }
      assetUnits = String(await numistaRpc.getAssetBalance(NUM_ASSET_ID, username));
      assetMetadata = await numistaRpc.getAsset(NUM_ASSET_ID);
    } else {
      return res.status(503).json({
        network,
        height,
        username,
        error: 'Numista chain RPC is unavailable',
        gameNum: { available: false },
        nativeNum: { available: false },
        nativeSupply: { available: false },
        asOf: new Date().toISOString()
      });
    }

    const gameNum = assetUnitsToNum(assetUnits);
    let nativeNum = { available: false, error: 'Native wallet RPC is unavailable in simulated mode' };
    let nativeSupply = { available: false, kind: 'not_applicable', error: 'Native issuance is unavailable in simulated mode' };

    if (capabilities.mode === 'live') {
      const receiveAddress = await getOrCreateReceiveAddress(username);
      const receiveInfo = await numistaRpc.getSubaddressReceiveInfo(
        receiveAddress.accountIndex,
        receiveAddress.addressIndex
      );
      const balanceAtomic = String(receiveInfo.balanceAtomic || '0');
      const unlockedAtomic = String(receiveInfo.unlockedAtomic || '0');
      const pendingAtomic = String(receiveInfo.pendingAtomic || '0');

      nativeNum = {
        available: true,
        balanceAtomic,
        unlockedAtomic,
        pendingAtomic,
        num: atomicUnitsToDecimal(balanceAtomic),
        unlockedNum: atomicUnitsToDecimal(unlockedAtomic),
        pendingNum: atomicUnitsToDecimal(pendingAtomic)
      };

      const [daemonInfo, minerData] = await Promise.all([
        numistaRpc.getDaemonInfoRaw(),
        numistaRpc.getMinerData()
      ]);
      const liveHeight = Number(daemonInfo?.height ?? minerData?.height ?? (height || 0));
      const generatedAtomic = String(
        minerData?.already_generated_coins ??
        minerData?.miner_data?.already_generated_coins ??
        '0'
      );
      nativeSupply = {
        available: true,
        generatedAtomic,
        generatedNum: atomicUnitsToDecimal(generatedAtomic),
        kind: 'cumulative_generated',
        height: liveHeight
      };
      if (liveHeight) return res.json({
        network,
        height: liveHeight,
        username,
        gameNum: {
          available: true,
          assetUnits,
          assetUnitsPerNum: CONFIG.CHAIN.UNITS_PER_NUM,
          num: gameNum,
          assetMetadata: assetMetadata || null
        },
        nativeNum,
        nativeSupply,
        launchReferenceGbpPerNum: launchRate.toFixed(2),
        estimatedReferenceValueGbp: {
          gameNum: (Number(gameNum) * launchRate).toFixed(2),
          nativeNum: (Number(nativeNum.num) * launchRate).toFixed(2)
        },
        asOf: new Date().toISOString()
      });
    }

    return res.json({
      network,
      height,
      username,
      gameNum: {
        available: true,
        assetUnits,
        assetUnitsPerNum: CONFIG.CHAIN.UNITS_PER_NUM,
        num: gameNum
      },
      nativeNum,
      nativeSupply,
      launchReferenceGbpPerNum: launchRate.toFixed(2),
      estimatedReferenceValueGbp: {
        gameNum: (Number(gameNum) * launchRate).toFixed(2),
        nativeNum: null
      },
      asOf: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      network,
      height,
      username,
      error: `Numista RPC unavailable: ${err.message}`,
      gameNum: { available: false, error: 'Game NUM chain balance unavailable' },
      nativeNum: { available: false, error: 'Native NUM wallet balance unavailable' },
      nativeSupply: { available: false, kind: 'cumulative_generated', error: 'Native supply unavailable' },
      asOf: new Date().toISOString()
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

app.get('/api/admin/summary', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const ledger = chainLedger.adminSummary();
  const purchases = stripeOnramp.adminSummary();
  const capabilities = await chainAdapter.capabilities();
  const launchRate = Math.max(0, Number(CONFIG.ECONOMY.LAUNCH_REFERENCE_GBP_PER_NUM) || 0.25);
  let nativeGeneratedNum = null;
  let nativeGeneratedAtomic = null;
  let height = Number(capabilities.chainHeight || 0);

  if (capabilities.mode === 'live') {
    try {
      const [minerData, daemonInfo] = await Promise.all([
        numistaRpc.getMinerData(),
        numistaRpc.getDaemonInfoRaw()
      ]);
      nativeGeneratedAtomic = String(
        minerData?.already_generated_coins ??
        minerData?.miner_data?.already_generated_coins ??
        '0'
      );
      nativeGeneratedNum = Number(atomicUnitsToDecimal(nativeGeneratedAtomic));
      height = Number(daemonInfo?.height ?? minerData?.height ?? (height || 0));
    } catch (err) {
      nativeGeneratedNum = null;
      nativeGeneratedAtomic = null;
    }
  }

  res.json({
    network: capabilities.mode === 'simulate'
      ? 'simulated'
      : CONFIG.NUMISTA.NETTYPE,
    height,
    asOf: new Date().toISOString(),
    launchReferenceGbpPerNum: launchRate.toFixed(2),
    inGameSupply: {
      totalNum: ledger.totalInGame,
      minedNum: ledger.minedInGame,
      launchReferenceGbp: +(ledger.totalInGame * launchRate).toFixed(2),
      accountCount: ledger.accountCount,
      transactionCount: ledger.transactionCount
    },
    nativeSupply: {
      generatedNum: nativeGeneratedNum,
      generatedAtomic: nativeGeneratedAtomic,
      kind: 'cumulative_generated',
      launchReferenceGbp: nativeGeneratedNum == null
        ? null
        : +(nativeGeneratedNum * launchRate).toFixed(2),
      available: nativeGeneratedNum != null
    },
    purchases: {
      paidOrderCount: purchases.paidOrderCount,
      orderCount: purchases.orderCount,
      numPurchased: purchases.numPurchased,
      gbpPaid: +purchases.gbpPaid.toFixed(2)
    }
  });
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
const publicPath = path.resolve(__dirname, '../public');
app.use('/assets', express.static(path.join(publicPath, 'assets'), {
  etag: true,
  maxAge: '1h'
}));
app.use(express.static(distPath));

app.use('/assets', (req, res) => {
  res.status(404).send('Asset not found');
});

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

  // The game store owns the job handlers: it restores plot/deed state and
  // settles the chain ledger. Wrap them so user records are persisted too,
  // instead of replacing them with a second, incomplete handler set.
  mintQueue.setHandlers({
    onConfirmed: job => {
      try {
        gameStore._onJobConfirmed(job);
      } finally {
        userManager.save();
      }
    },
    onReverted: job => {
      try {
        gameStore._onJobReverted(job);
      } finally {
        userManager.save();
      }
    }
  });

  // Rebuild any claimed deeds that were minted before this process started.
  gameStore.reconcileChainDeeds({ force: true }).catch(err => {
    console.warn('[store] Initial deed reconcile failed:', err.message);
  });

  startBuiltInStratumServer();

  // Load the custodial wallet up front so subaddress and asset operations do
  // not each pay the "No wallet file" retry cost.
  numistaRpc.ensureWalletOpen()
    .then(async result => {
      console.log(`[wallet-rpc] custodial wallet ready: ${result.filename}`);
      const accts = await numistaRpc._walletRpc('get_accounts', {}).catch(() => null);
      for (const a of (accts?.subaddress_accounts || []).sort((x,y) => x.account_index - y.account_index)) {
        if (a.account_index > 0 && a.label && a.label.includes('@')) {
          const uname = a.label.slice(a.label.indexOf('@') + 1).trim().toLowerCase();
          if (uname && !userManager.users.has(uname)) {
            // Derive the same genesis secret for existing wallet accounts found on boot
            const genesisHash = crypto.createHmac('sha256', String(CONFIG.CHAIN.ISSUER_PUBLIC_KEY || 'numista'))
              .update('genesis-anchor:' + uname + ':' + a.base_address)
              .digest('hex');
            const derivedSecret = numistaRpc.deriveTxSecret(genesisHash, uname);
            userManager.register({ username: uname, password: derivedSecret });
            const user = userManager.getUser(uname);
            if (user && !user.identityReceipt) {
              user.identityReceipt = {
                address: a.base_address,
                username: uname,
                secretPassword: derivedSecret,
                txHash: null,
                blockHeight: null
              };
              userManager.save();
            }
          }
          if (uname && !userManager.getUser(uname)?.receiveAddress) {
            userManager.setReceiveAddress(uname, { address: a.base_address, accountIndex: a.account_index, addressIndex: 0 });
          }
        }
      }
    })
    .catch(err => console.warn(`[wallet-rpc] custodial wallet not ready: ${err.message}`));

  console.log(`[chain] mode=${capabilities.mode} ready=${capabilities.ready} :: ${capabilities.reason}`);

  app.get('/randomx.js', (req, res) => res.type('application/javascript').sendFile(path.resolve('public/randomx.js')));
  app.get('/randomx.wasm', (req, res) => res.type('application/wasm').sendFile(path.resolve('public/randomx.wasm')));
  let nativeConversionReconcileRunning = false;
  async function reconcilePlayerNativeConversions() {
    if (nativeConversionReconcileRunning) return;
    nativeConversionReconcileRunning = true;
    try {
      const allAccts = await numistaRpc._walletRpc('get_accounts', {}).catch(() => null);
      const subAccts = (allAccts?.subaddress_accounts || []).filter(a => a.account_index > 0);
      if (!subAccts.length) return;
      const fee = +(Number(CONFIG.ECONOMY.TRANSFER_NETWORK_FEE_NUM) || 0.05).toFixed(4);
      const vault = await numistaRpc.getWalletAddress(0, 0).catch(() => null);
      const vaultAddress = vault?.address || null;

      for (const acct of subAccts) {
        const outRes = await numistaRpc._walletRpc('get_transfers', {
          out: true,
          pending: true,
          pool: true,
          account_index: acct.account_index
        }).catch(() => null);
        const txs = [
          ...(outRes?.out || []),
          ...(outRes?.pending || []),
          ...(outRes?.pool || [])
        ].filter(t => !t.locked && Number(t.confirmations || 0) >= 1);

        const atIdx = String(acct.label || '').indexOf('@');
        const hashIdx = String(acct.label || '').lastIndexOf('#');
        const uname = atIdx !== -1 ? acct.label.slice(atIdx + 1, hashIdx !== -1 ? hashIdx : undefined).trim().toLowerCase() : `unknown_${acct.account_index}`;

        let expectedTotal = 0;
        for (const tx of txs) {
          if (vaultAddress && Array.isArray(tx.destinations) && tx.destinations.length &&
            !tx.destinations.some(destination => destination.address === vaultAddress)) continue;
          const net = +((Number(tx.amount || 0) / 1e12) - fee).toFixed(4);
          if (net >= 0.1) expectedTotal = +(expectedTotal + net).toFixed(4);
        }

        const onChainUnits = await chainAdapter.getAssetBalance(NUM_ASSET_ID, uname).catch(() => 0);
        const onChainNum = +(Number(onChainUnits || 0) / Number(CONFIG.CHAIN.UNITS_PER_NUM || 1000)).toFixed(4);
        const delta = +(expectedTotal - onChainNum).toFixed(4);
        const acc = chainLedger.ensure(uname);
        acc.chainSettled = onChainNum;

        if (delta <= 0.0001) {
          if (acc.pending > 0) {
            acc.pending = 0;
            chainLedger.syncWallet(uname);
          }
          continue;
        }

        const activeCredit = mintQueue.jobs.some(job =>
          job.username === uname && ['deposit', 'currency_mint'].includes(job.type)
        );
        const alreadyQueued = activeCredit || mintQueue.history.some(job =>
          job.type === 'currency_mint' &&
          job.username === uname &&
          Number(job.snapshot?.targetTotal || 0) >= expectedTotal
        );
        if (delta < 0.1 || alreadyQueued) continue;

        const steps = [];
        const reg = await chainAdapter.getUsernameKey(uname).catch(() => null);
        if (!reg) {
          steps.push({
            key: 'register_user',
            label: `Register @${uname}`,
            operation: { kind: 'register_username', accountIndex: 0, username: uname, key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY }
          });
        }
        steps.push({
          key: 'mint',
          label: `Mint ${delta} in-game NUM to @${uname}`,
          operation: { kind: 'mint', accountIndex: 0, assetId: NUM_ASSET_ID, assetType: CURRENCY_ASSET_TYPE, recipient: uname, amountUnits: toUnits(delta) }
        });

        chainLedger.addPending(uname, delta);
        try {
          mintQueue.enqueue({ type: 'currency_mint', username: uname, snapshot: { amount: delta, targetTotal: expectedTotal }, steps });
        } catch (err) {
          chainLedger.dropPending(uname, delta);
          throw err;
        }
      }
    } catch (err) {
      console.warn('[reconcile]', err.message);
    } finally {
      nativeConversionReconcileRunning = false;
    }
  }
  setTimeout(reconcilePlayerNativeConversions, 5000);
  const nativeReconcileTimer = setInterval(reconcilePlayerNativeConversions, CONFIG.CHAIN.RECONCILE_MS);
  if (nativeReconcileTimer.unref) nativeReconcileTimer.unref();
app.listen(CONFIG.PORT, () => {
    console.log(`[Worldtycoon] Server active on http://localhost:${CONFIG.PORT}`);
  });
}

boot().catch(err => {
  console.error('[boot] Fatal:', err);
  process.exit(1);
});
