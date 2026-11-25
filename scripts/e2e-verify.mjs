import { numistaRpc } from '../server/numista/rpc.js';

const BASE = (process.env.BASE_URL || 'https://onrender.com').replace(/\/$/, '');
const PW = process.env.TEST_PW || 'D4rkness10@@@@';
const VAULT_ADDR = 'SbMqyiLDAv6QtTCX1n1JJnLuZL7j3RxKKcdvdTA1F15HeygxXzf982K2CdYGNc7J9pL9ZX71E8byHLFuhSH6TDBx1pNJ46GYn';
const PLAYER_ADDR = 'UGN5xgg5afC1EwvVHC3pbiDMBQadaihEeQibHKyU6pQVT34YT2tW4cThugPTpFYP6LM3KdCmy1LGTKjtRTv3FMf12e5eQ7uLm';

const results = [];
const log = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error || res.statusText}`);
  return data;
}

async function run() {
  console.log(`\n=== Goldnumista End-to-End Blockchain Test Suite (${BASE}) ===\n`);

  // 0. Ensure Account #0 & Account #1 have valid _makeVerifier labels on local wallet RPC
  try {
    const accts = await numistaRpc._walletRpc('get_accounts', {}); while ((accts.subaddress_accounts || []).length < 2) { await numistaRpc._walletRpc('create_account', { label: 'Unknown #1' }); accts.subaddress_accounts.push({}); } await numistaRpc.setAccountLabel(0, `Sovereign Vault @danie#${numistaRpc._makeVerifier(PW)}`);
    await numistaRpc.setAccountLabel(1, `Unknown #1#${numistaRpc._makeVerifier(PW)}`);
    await numistaRpc.storeWallet();
    log('0. Sync Wallet Verifier Labels', true, 'Account #0 (@danie) & Account #1 synced');
  } catch (e) {
    log('0. Sync Wallet Verifier Labels', false, e.message);
  }

  // 1. Health & Node RPC
  let health;
  try {
    health = await api('/api/health');
    log('1. Node & Daemon Health', Boolean(health?.ok), { height: health?.height, chainMode: health?.chainMode });
  } catch (e) { log('1. Node & Daemon Health', false, e.message); }

  // 2. Login Admin Vault (#0) & Player (#1)
  let admin, player;
  try {
    admin = await api('/api/auth/wallet-login', { method: 'POST', body: { identifier: VAULT_ADDR, password: PW } });
    log('2a. Admin Vault Login (#0)', Boolean(admin?.token), { username: admin.username, role: admin.role });
  } catch (e) { log('2a. Admin Vault Login (#0)', false, e.message); }

  try {
    player = await api('/api/auth/wallet-login', { method: 'POST', body: { identifier: PLAYER_ADDR, password: PW } });
    log('2b. Player Account Login (#1)', Boolean(player?.token), { username: player.username, accountIndex: player.accountIndex });
  } catch (e) { log('2b. Player Account Login (#1)', false, e.message); }

  // 3. Check Player Native & In-Game Wallet
  let pWallet;
  try {
    pWallet = await api(`/api/wallet?username=${encodeURIComponent(player.username)}`, { token: player.token });
    log('3a. Player Wallet State', true, { available: pWallet.balance, pending: pWallet.pendingBalance, nativeUnlocked: pWallet.nativeWallet?.unlockedBalance });
  } catch (e) { log('3a. Player Wallet State', false, e.message); }

  // 3b. Convert 15 Native NUM -> In-Game NUM if balance < 15
  if (player && Number(pWallet?.balance || 0) < 15) {
    try {
      const conv = await api('/api/wallet/convert-to-game', { method: 'POST', token: player.token, body: { amount: 15 } });
      log('3b. Convert 15 Native -> In-Game NUM', true, { txHash: conv.nativeTxHash, jobId: conv.job?.id });
    } catch (e) { log('3b. Convert 15 Native -> In-Game NUM', false, e.message); }
  } else {
    log('3b. Convert Native -> In-Game NUM', true, `Already funded (${pWallet?.balance} NUM)`);
  }

  // 4. Peerage Title Purchase (10 NUM)
  if (player) {
    try {
      const tRes = await api('/api/titles/buy', { method: 'POST', token: player.token, body: { titleKey: 'baron' } });
      log('4. Buy Peerage Title (Baron - 10 NUM)', Boolean(tRes?.success), { title: tRes.title, job: tRes.job?.status });
    } catch (e) { log('4. Buy Peerage Title (Baron - 10 NUM)', false, e.message); }
  }

  // 5. Strike Pre-1920 Coinage (1 NUM) & Fetch My Coins
  let mintedCoinSerial = null;
  if (player) {
    try {
      const plotsRes = await api('/api/plots');
      const mintPlot = (plotsRes.plots || []).find(p => p.category === 'mint' || String(p.id).startsWith('uk-'));
      const strike = await api('/api/mints/strike', { method: 'POST', token: player.token, body: { plotId: mintPlot?.id || 'uk-0001', amountNum: 1 } });
      const myCoins = await api('/api/mints/my-coins', { token: player.token });
      mintedCoinSerial = myCoins.coins?.at(-1)?.serial || null;
      log('5. Strike Pre-1920 Coinage (1 NUM)', Boolean(strike?.success), { batchId: strike.batch?.id, latestSerial: mintedCoinSerial, yieldBonus: myCoins.yieldBonus });
    } catch (e) { log('5. Strike Pre-1920 Coinage (1 NUM)', false, e.message); }
  }

  // 6. Claim UK Plot
  let claimedPlotId = null;
  if (player) {
    try {
      const plotsRes = await api('/api/plots');
      const openPlot = (plotsRes.plots || []).find(p => !p.isClaimed && Number(p.claimCost || 0) <= 5);
      if (openPlot) {
        const claim = await api(`/api/plots/${openPlot.id}/claim`, { method: 'POST', token: player.token });
        claimedPlotId = openPlot.id;
        log('6. Claim UK Plot On-Chain', Boolean(claim?.success), { plotId: openPlot.id, job: claim.job?.status });
      } else {
        log('6. Claim UK Plot On-Chain', false, 'No unclaimed <= 5 NUM plot found');
      }
    } catch (e) { log('6. Claim UK Plot On-Chain', false, e.message); }
  }

  // 7. Universal Auction House: List Coin & Instant Buyout by Admin Vault
  if (player && admin && mintedCoinSerial) {
    try {
      const listed = await api('/api/auctions', {
        method: 'POST',
        token: player.token,
        body: { category: 'Pre-1920 Coin', title: `Historic ${mintedCoinSerial}`, assetRef: mintedCoinSerial, startBid: 1, buyoutPrice: 2, durationHours: 24 }
      });
      const auctionId = listed.auction?.id;
      const bought = await api(`/api/auctions/${auctionId}/buyout`, { method: 'POST', token: admin.token });
      log('7. Universal Auction List & Buyout', Boolean(bought?.success), { auctionId, serial: mintedCoinSerial, newOwner: admin.username });
    } catch (e) { log('7. Universal Auction List & Buyout', false, e.message); }
  } else {
    log('7. Universal Auction List & Buyout', false, 'Skipped (no minted coin serial available)');
  }

  // 8. Stateless Blockchain Explorer Search
  try {
    const h = health?.height || 1;
    const blk = await api(`/api/explorer/search?q=${h}`);
    log('8. Stateless Blockchain Explorer', blk?.result?.kind === 'block', { height: blk?.result?.height, hash: blk?.result?.hash?.slice(0, 16) + '...' });
  } catch (e) { log('8. Stateless Blockchain Explorer', false, e.message); }

  // 9. Admin Sovereign Vault Solvency & Profit Audit
  if (admin) {
    try {
      const audit = await api('/api/admin/vault-audit', { token: admin.token });
      log('9. Sovereign Vault Solvency Audit', Boolean(audit?.solvent), { solvent: audit.solvent, reserveRatioPct: audit.reserveRatioPct, nativeVault: audit.nativeVault, playerCirculating: audit.playerCirculating, netProfitNum: audit.netProfitNum });
    } catch (e) { log('9. Sovereign Vault Solvency Audit', false, e.message); }
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`\n=== Summary: ${passed}/${results.length} Checks Passed ===\n`);
}

run().catch(err => { console.error('E2E Fatal:', err); process.exit(1); });