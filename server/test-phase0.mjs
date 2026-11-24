/**
 * Phase 0 chain-integration test.
 *
 * Runs the server against the simulated chain with fast blocks and exercises:
 *   1. unique plot names across all 3,500 parcels
 *   2. claim → 10-confirmation deed mint → metadata hash verification
 *   3. upgrade settlement
 *   4. failure + compensating rollback (state restored, funds refunded)
 *   5. admin-only raw RPC proxies
 *   6. admin-only coin minting
 *
 * Usage: node server/test-phase0.mjs
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3101);
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'townforge-phase0-'));

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!condition) throw new Error(`Test failed: ${name}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(pathname, { method = 'GET', body, user, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { 'x-numista-user': user } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/network/capabilities`);
      if (res.ok) return;
      console.log('HTTP status:', res.status);
    } catch (err) {
      if (i % 20 === 0) console.log('Poll fetch error:', err.message);
    }
    await sleep(200);
  }
  throw new Error('Server did not start in time');
}

async function waitForJob(jobId, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api(`/api/jobs/${jobId}`);
    last = json?.job;
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for job ${jobId}; last=${JSON.stringify(last)}`);
}

async function main() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NUMISTA_CHAIN_MODE: 'simulate',
      NUMISTA_ALLOW_DEV_RPC: '1',
      NUMISTA_SIM_BLOCK_MS: '180',
      NUMISTA_QUEUE_POLL_MS: '120',
      NUMISTA_SIM_FILE: path.join(TEMP, 'simChain.json'),
      NUMISTA_LEDGER_FILE: path.join(TEMP, 'ledgerState.json'),
      NUMISTA_QUEUE_FILE: path.join(TEMP, 'mintQueue.json'),
      NUMISTA_STATE_FILE: path.join(TEMP, 'gameState.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer();

    /* ---- 1. capabilities ---- */
    const caps = await api('/api/network/capabilities');
    check('chain mode is simulate', caps.json?.capabilities?.mode === 'simulate', caps.json?.capabilities?.reason);
    check('10 confirmations required', caps.json?.capabilities?.confirmationsRequired === 10);

    /* ---- 2. unique names ---- */
    const plotsRes = await api('/api/plots');
    const plots = plotsRes.json.plots;
    check('3,500 plots', plots.length === 3500, String(plots.length));
    const names = plots.map(p => String(p.name || '').trim().toLowerCase());
    check('every plot has a name', names.every(Boolean));
    check('all plot names unique', new Set(names).size === names.length,
      `${new Set(names).size} distinct`);

    const auth = await api('/api/auth/login', { method: 'POST', body: { username: 'danie', password: 'password123' } });
    check('admin login works', auth.json?.role === 'admin', auth.json?.role);

    const startBalance = (await api('/api/auth/me', { user: 'danie' })).json.wallet.balance;
    check('admin has simulated genesis balance', startBalance > 50, String(startBalance));

    /* ---- 3. claim → deed mint ---- */
    const target = plots.find(p => !p.isClaimed && !p.isLandmark && p.rarity === 1);
    check('found claimable common plot', !!target, target?.id);

    const claim = await api(`/api/plots/${target.id}/claim`, { method: 'POST', user: 'danie', body: {} });
    check('claim accepted', claim.status === 200 && claim.json?.pending === true, claim.json?.message || claim.text);
    check('claim reports 10-block queue', claim.json?.job?.requiredConfirmations === 10);

    const claimJob = await waitForJob(claim.json.job.id, j => j.status === 'confirmed' || j.status === 'reverted' || j.status === 'failed');
    check('deed job confirmed', claimJob.status === 'confirmed', claimJob.failure || '');
    check('all claim steps confirmed', claimJob.steps.every(s => s.status === 'confirmed'));

    const afterClaim = await api(`/api/plots/${target.id}`);
    check('plot shows on-chain deed', afterClaim.json.plot.nftState?.stage === 'onchain', afterClaim.json.plot.nftState?.stage);
    check('deed has real tx hash', /^[a-f0-9]{64}$/.test(afterClaim.json.plot.nftState?.txHash || ''), afterClaim.json.plot.nftState?.txHash);
    check('deed confirmed at 10 confirmations', afterClaim.json.plot.nftState?.confirmations === 10);

    const meta = await api(`/api/deeds/${afterClaim.json.plot.nftState.assetId}/metadata`);
    check('deed metadata served', meta.status === 200 && meta.json?.verified === true);
    check('deed metadata matches plot', meta.json?.metadata?.plotId === target.id && meta.json?.metadata?.name === target.name);

    const afterBalance = (await api('/api/auth/me', { user: 'danie' })).json.wallet.balance;
    check('claim price debited', Math.abs((startBalance - afterBalance) - target.price) < 0.01,
      `${startBalance} → ${afterBalance} (price ${target.price})`);

    /* ---- 4. upgrade ---- */
    const upgrade = await api(`/api/plots/${target.id}/upgrade`, { method: 'POST', user: 'danie', body: {} });
    check('upgrade accepted', upgrade.status === 200 && upgrade.json?.pending === true, upgrade.json?.error || '');
    const upgradeJob = await waitForJob(upgrade.json.job.id, j => j.status === 'confirmed' || j.status === 'reverted' || j.status === 'failed');
    check('upgrade confirmed', upgradeJob.status === 'confirmed', upgradeJob.failure || '');
    const afterUpgrade = await api(`/api/plots/${target.id}`);
    check('building level increased', afterUpgrade.json.plot.building?.level === 2, afterUpgrade.json.plot.building?.level);

    /* ---- 5. failure + rollback ---- */
    const rollbackTarget = plots.find(p => !p.isClaimed && !p.isLandmark && p.rarity === 1 && p.id !== target.id);
    const balanceBeforeRollback = (await api('/api/auth/me', { user: 'danie' })).json.wallet.balance;
    const claim2 = await api(`/api/plots/${rollbackTarget.id}/claim`, { method: 'POST', user: 'danie', body: {} });
    check('second claim accepted', claim2.status === 200);

    // Wait until the payment step confirms, then fail the next chain operation
    // (asset creation) so the rollback path runs with a real confirmed step.
    await waitForJob(claim2.json.job.id, j => j.steps[0]?.status === 'confirmed');
    await api('/api/dev/sim/fail', { method: 'POST', user: 'danie', body: { count: 1 } });

    const revertedJob = await waitForJob(claim2.json.job.id, j => j.status === 'reverted' || j.status === 'failed' || j.status === 'revert_failed', 90000);
    check('failed claim reverted', revertedJob.status === 'reverted', revertedJob.failure || '');
    check('rollback used compensating transfer', revertedJob.steps.some(s => s.compensation && s.status === 'confirmed'));

    const afterRollbackPlot = await api(`/api/plots/${rollbackTarget.id}`);
    check('plot released after rollback', afterRollbackPlot.json.plot.isClaimed === false && !afterRollbackPlot.json.plot.owner);

    const balanceAfterRollback = (await api('/api/auth/me', { user: 'danie' })).json.wallet.balance;
    check('funds refunded after rollback', Math.abs(balanceAfterRollback - balanceBeforeRollback) < 0.01,
      `${balanceBeforeRollback} → ${balanceAfterRollback}`);

    /* ---- 6. admin gating ---- */
    const merc = await api('/api/auth/login', { method: 'POST', body: { username: 'mercantile', password: 'password123' } });
    check('non-admin login works', merc.json?.role === 'user', merc.json?.role);

    const rawRpc = await api('/api/network/rpc', { method: 'POST', user: 'mercantile', body: { method: 'get_info' } });
    check('non-admin blocked from raw daemon RPC', rawRpc.status === 403, String(rawRpc.status));

    const rawWallet = await api('/api/wallet-rpc/call', { method: 'POST', user: 'mercantile', body: { method: 'get_version' } });
    check('non-admin blocked from raw wallet RPC', rawWallet.status === 403, String(rawWallet.status));

    const deniedMint = await api('/api/mint/issue', {
      method: 'POST', user: 'mercantile',
      body: { metal: 'gold', weightGrams: 5, purity: 0.999, mintPlotId: 'UK-MINT-GOLD-01' }
    });
    check('non-admin cannot strike coins', deniedMint.status === 403, String(deniedMint.status));

    const adminMint = await api('/api/mint/issue', {
      method: 'POST', user: 'danie',
      body: { metal: 'gold', weightGrams: 5, purity: 0.999, mintPlotId: 'UK-MINT-GOLD-01' }
    });
    check('admin can strike gold', adminMint.status === 200 && adminMint.json?.coin?.metal === 'gold', adminMint.json?.error || adminMint.json?.coin?.id);

    /* ---- 7. no fabricated tx hashes in balances ---- */
    const wallet = await api('/api/wallet', { user: 'danie' });
    const transfers = wallet.json?.recentTransfers || [];
    check('wallet transfers have no placeholder hashes',
      transfers.every(t => t.txHash === null || /^[a-f0-9]{64}$/.test(t.txHash)));

    const ledgerSummary = (await api('/api/network/capabilities')).json.ledger;
    check('ledger has no negative/locked residue', ledgerSummary.locked === 0, JSON.stringify(ledgerSummary));

    console.log(`\nAll ${results.length} checks passed.`);
  } finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* windows lock */ }
  }
}

main().catch(err => {
  console.error(`\n${err.stack || err.message}`);
  process.exit(1);
});
