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

import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { StripeOnramp } from './payment/stripeOnramp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3101);
const BASE = `http://127.0.0.1:${PORT}`;
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'worldtycoon-phase0-'));
const sessionTokens = new Map();

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
      ...(user && sessionTokens.has(user.toLowerCase()) ? { Authorization: `Bearer ${sessionTokens.get(user.toLowerCase())}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (['/api/auth/login', '/api/auth/register', '/api/auth/wallet-register'].includes(pathname) &&
      json?.username && json?.token) {
    sessionTokens.set(json.username.toLowerCase(), json.token);
  }
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

async function waitForJob(jobId, predicate, timeoutMs = 60000, user = 'danie') {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api(`/api/jobs/${jobId}`, { user });
    last = json?.job;
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for job ${jobId}; last=${JSON.stringify(last)}`);
}

async function main() {
  fs.copyFileSync(path.join(ROOT, 'server/data/users.json'), path.join(TEMP, 'users.json'));
  const mainnetProbeScript = `
    import assert from 'node:assert/strict';
    const { CONFIG } = await import('./server/config.js');
    const { chainAdapter, CURRENCY_METADATA_HASH } = await import('./server/numista/chainAdapter.js');
    const { NUM_ASSET_ID } = await import('./server/data/deedRegistry.js');
    const original = {
      daemon: CONFIG.NUMISTA.DAEMON_RPC_URL,
      wallet: CONFIG.NUMISTA.WALLET_RPC_URL,
      issuer: CONFIG.CHAIN.ISSUER_PUBLIC_KEY,
      issuerWallet: CONFIG.CHAIN.ISSUER_WALLET_FILE,
      treasury: CONFIG.CHAIN.TREASURY_ADDRESS,
      treasuryUser: CONFIG.CHAIN.TREASURY_USERNAME,
      assetId: CONFIG.CHAIN.CURRENCY_ASSET_ID
    };
    CONFIG.NUMISTA.DAEMON_RPC_URL = '';
    const missingConfig = await chainAdapter.probeLive();
    assert.equal(missingConfig.ready, false);
    assert.match(missingConfig.reason, /NUMISTA_DAEMON_RPC is required/);
    Object.assign(CONFIG.NUMISTA, { DAEMON_RPC_URL: original.daemon, WALLET_RPC_URL: original.wallet });
    Object.assign(CONFIG.CHAIN, {
      ISSUER_PUBLIC_KEY: original.issuer,
      ISSUER_WALLET_FILE: original.issuerWallet,
      TREASURY_ADDRESS: original.treasury,
      TREASURY_USERNAME: original.treasuryUser,
      CURRENCY_ASSET_ID: original.assetId
    });
    let daemonNetwork = 'mainnet';
    let assetMatches = true;
    chainAdapter._daemonRaw = async () => ({ height: 100, synchronized: true, nettype: daemonNetwork });
    chainAdapter._daemonJsonRpc = async (method, params) => {
      if (method === 'get_version') return { version: 'mock' };
      if (method === 'get_numista_asset' && params.asset_id === NUM_ASSET_ID) {
        return assetMatches
          ? { found: true, asset_type: 'fungible', metadata_hash: CURRENCY_METADATA_HASH }
          : { found: true, asset_type: 'fungible', metadata_hash: 'wrong' };
      }
      if (method === 'get_numista_asset') return { found: false };
      throw new Error('Unexpected mocked daemon method');
    };
    chainAdapter._walletJsonRpc = async () => ({ version: 'mock' });
    assert.equal((await chainAdapter.probeLive()).ready, true);
    assetMatches = false;
    const wrongAsset = await chainAdapter.probeLive();
    assert.equal(wrongAsset.ready, false);
    assert.match(wrongAsset.reason, /does not match the NUM asset metadata/);
    assetMatches = true;
    daemonNetwork = 'numista-testnet';
    const wrongNetwork = await chainAdapter.probeLive();
    assert.equal(wrongNetwork.ready, false);
    assert.match(wrongNetwork.reason, /expected numista-mainnet/);
    console.log('Mainnet fail-closed and identity checks passed');
  `;
  const mainnetProbe = spawnSync(process.execPath, ['--input-type=module', '-e', mainnetProbeScript], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NUMISTA_NETWORK: 'mainnet',
      NUMISTA_CHAIN_MODE: 'live',
      NUMISTA_DAEMON_RPC: 'http://127.0.0.1:1',
      NUMISTA_WALLET_RPC: 'http://127.0.0.1:1',
      NUMISTA_ISSUER_PUBLIC_KEY: 'a'.repeat(64),
      NUMISTA_ISSUER_WALLET: '/tmp/mainnet-issuer-wallet',
      NUMISTA_TREASURY_ADDRESS: 'mainnet-treasury-address',
      NUMISTA_TREASURY_USER: 'mainnet_treasury',
      NUMISTA_CURRENCY_ASSET_ID: 'b'.repeat(64)
    }
  });
  check('mainnet readiness verifies configuration, network, and NUM asset identity',
    mainnetProbe.status === 0,
    mainnetProbe.status === 0 ? mainnetProbe.stdout.trim() : mainnetProbe.stderr.trim());

  const stripeTestEnv = {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PUBLIC_BASE_URL: process.env.STRIPE_PUBLIC_BASE_URL,
    NUMISTA_ONRAMP_TEST_ENABLED: process.env.NUMISTA_ONRAMP_TEST_ENABLED
  };
  const originalFetch = globalThis.fetch;
  try {
    process.env.STRIPE_SECRET_KEY = 'sk_test_phase0_only';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_phase0_only';
    process.env.STRIPE_PUBLIC_BASE_URL = 'http://localhost:5173';
    process.env.NUMISTA_ONRAMP_TEST_ENABLED = '1';
    let stripeRequest;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/payment_intents/')) {
        return {
          ok: true,
          json: async () => ({ id: 'pi_test_phase0', metadata: { order_id: checkout.orderId } })
        };
      }
      stripeRequest = options;
      return { ok: true, json: async () => ({ id: 'cs_test_phase0', url: 'https://checkout.stripe.test/session' }) };
    };
    const checkoutManager = new StripeOnramp({ file: path.join(TEMP, 'stripeCheckoutUnit.json') });
    const checkout = await checkoutManager.createCheckout({
      username: 'danie', amountGBP: 10, destination: 'game_balance', gameTreasuryAvailable: 400
    });
    check('test Stripe checkout uses server-calculated GBP amount',
      checkout.numAmount === 400 &&
      new URLSearchParams(stripeRequest.body).get('line_items[0][price_data][unit_amount]') === '1000' &&
      stripeRequest.headers['Idempotency-Key'] === `worldtycoon-checkout-${checkout.orderId}`);
    await checkoutManager.handleEvent({
      id: 'evt_phase0_refund_before_completed',
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_test_phase0' } }
    }, {});
    check('out-of-order refund webhook is linked by PaymentIntent metadata',
      checkoutManager.getOrder(checkout.orderId).status === 'manual_review');
    let insufficientInventoryRejected = false;
    try {
      await checkoutManager.createCheckout({
        username: 'mercantile', amountGBP: 1, destination: 'game_balance', gameTreasuryAvailable: 400
      });
    } catch (err) {
      insufficientInventoryRejected = err.message.includes('unreserved NUM inventory');
    }
    check('pending checkout reserves its treasury inventory', insufficientInventoryRejected);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(stripeTestEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const child = spawn(process.execPath, ['--import', './server/test-stripe-mock.mjs', 'server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NUMISTA_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      NUMISTA_SIM_DANIE: '3000',
      NUMISTA_SIM_TREASURY: '5000',
      NUMISTA_CHAIN_MODE: 'simulate',
      NUMISTA_ALLOW_DEV_RPC: '1',
      NUMISTA_NETWORK: 'testnet',
      NUMISTA_ONRAMP_TEST_ENABLED: '1',
      NUMISTA_ONRAMP_LIVE_ENABLED: '0',
      NUMISTA_TEST_STRIPE_MOCK: '1',
      NUMISTA_ONRAMP_ORDERS_FILE: path.join(TEMP, 'stripeOrders.json'),
      STRIPE_SECRET_KEY: 'sk_test_simulated_e2e',
      STRIPE_WEBHOOK_SECRET: 'whsec_phase0_test_only',
      STRIPE_PUBLIC_BASE_URL: 'http://localhost:5173',
      NUMISTA_SIM_BLOCK_MS: '180',
      NUMISTA_QUEUE_POLL_MS: '120',
      NUMISTA_SIM_FILE: path.join(TEMP, 'simChain.json'),
      NUMISTA_LEDGER_FILE: path.join(TEMP, 'ledgerState.json'),
      NUMISTA_QUEUE_FILE: path.join(TEMP, 'mintQueue.json'),
      NUMISTA_STATE_FILE: path.join(TEMP, 'gameState.json'),
      NUMISTA_DATABASE_FILE: path.join(TEMP, 'gameState.sqlite'),
      NUMISTA_USERS_FILE: path.join(TEMP, 'users.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    await waitForServer();

    const missingAsset = await api('/assets/missing-sprite-test.png');
    check('missing assets return 404 instead of the frontend HTML', missingAsset.status === 404);

    /* ---- 1. capabilities ---- */
    const caps = await api('/api/network/capabilities');
    check('chain mode is simulate', caps.json?.capabilities?.mode === 'simulate', caps.json?.capabilities?.reason);
    check('10 confirmations required', caps.json?.capabilities?.confirmationsRequired === 10);
    const gbpQuote = await api('/api/onramp/quote', {
      method: 'POST', body: { currency: 'GBP', fiatAmount: 1 }
    });
    check('GBP quote uses £0.025 per NUM',
      gbpQuote.json?.rate === 0.025 && gbpQuote.json?.numAmount === 40);
    const webhookBody = {
      id: 'evt_phase0_expired',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_phase0_missing', metadata: { order_id: 'missing' } } }
    };
    const webhookRaw = JSON.stringify(webhookBody);
    const webhookTimestamp = Math.floor(Date.now() / 1000);
    const webhookSignature = crypto.createHmac('sha256', 'whsec_phase0_test_only')
      .update(`${webhookTimestamp}.${webhookRaw}`)
      .digest('hex');
    check('unsigned Stripe webhook is rejected',
      (await api('/api/onramp/webhook', {
        method: 'POST', body: webhookBody, headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=00` }
      })).status === 400);
    check('signed Stripe webhook is accepted',
      (await api('/api/onramp/webhook', {
        method: 'POST', body: webhookBody,
        headers: { 'Stripe-Signature': `t=${webhookTimestamp},v1=${webhookSignature}` }
      })).status === 200);

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
    const adminSummary = await api('/api/admin/summary', { user: 'danie' });
    check('admin summary reports supply, purchases, and GBP reference',
      adminSummary.status === 200 &&
      Number.isFinite(Number(adminSummary.json?.inGameSupply?.totalNum)) &&
      Number.isFinite(Number(adminSummary.json?.purchases?.gbpPaid)) &&
      adminSummary.json?.launchReferenceGbpPerNum === '0.25',
      adminSummary.text || adminSummary.json?.error || '');
    const merc = await api('/api/auth/login', { method: 'POST', body: { username: 'mercantile', password: 'password123' } });
    check('non-admin login works', merc.json?.role === 'user', merc.json?.role);
    check('simulated chain blocks native-wallet checkout',
      (await api('/api/onramp/order', {
        method: 'POST', user: 'danie',
        body: { amount: 10, destination: 'native_wallet', walletAddress: 'not-a-live-wallet' }
      })).status === 503);

    const startBalance = (await api('/api/auth/me', { user: 'danie' })).json.wallet.balance;
    check('admin has simulated genesis balance', startBalance > 50, String(startBalance));

    const signup = await api('/api/auth/wallet-register', { method: 'POST', body: {} });
    const journeyUser = signup.json?.username;
    check('simulation signup creates a local account without a fake wallet',
      signup.status === 200 && signup.json?.simulated === true && !signup.json?.address &&
      signup.json?.role === 'user' && !!signup.json?.token,
      signup.json?.error || '');
    const signedIn = await api('/api/auth/wallet-login', {
      method: 'POST', body: { identifier: journeyUser, password: signup.json?.secretPassword }
    });
    check('new simulation account can sign in with its saved secret',
      signedIn.status === 200 && signedIn.json?.username === journeyUser);

    const portfolio = await api('/api/wallet/portfolio', { user: journeyUser });
    check('wallet portfolio separates game NUM and native NUM with launch reference',
      portfolio.status === 200 &&
      portfolio.json?.network === 'simulated' &&
      portfolio.json?.gameNum?.available === true &&
      portfolio.json?.nativeNum?.available === false &&
      portfolio.json?.launchReferenceGbpPerNum === '0.25',
      portfolio.json?.error || '');

    const simulatedDeposit = await api('/api/dev/sim/deposit', {
      method: 'POST', user: 'danie', body: { recipientUsername: journeyUser, amount: 3000 }
    });
    check('admin queues a simulated deposit for the new player',
      simulatedDeposit.status === 200 && simulatedDeposit.json?.simulated === true,
      simulatedDeposit.json?.error || '');
    const simulatedDepositJob = await waitForJob(
      simulatedDeposit.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      journeyUser
    );
    check('new player deposit confirms in the simulated chain',
      simulatedDepositJob.status === 'confirmed', simulatedDepositJob.failure || '');
    const balanceAfterDeposit = (await api('/api/wallet', { user: journeyUser })).json?.available;
    check('simulated deposit credits the new account',
      Math.abs(balanceAfterDeposit - 3000) < 0.001, String(balanceAfterDeposit));

    const checkout = await api('/api/onramp/order', {
      method: 'POST',
      user: journeyUser,
      body: { amount: 1, destination: 'game_balance' }
    });
    check('Stripe test checkout opens for the signed-in new player',
      checkout.status === 200 && checkout.json?.numAmount === 40 &&
      checkout.json?.checkoutUrl?.startsWith('https://checkout.stripe.test/'),
      checkout.json?.error || '');
    const checkoutSessionId = `cs_test_${checkout.json.orderId}`;
    const paidSessionEvent = {
      id: `evt_e2e_paid_${checkout.json.orderId}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: checkoutSessionId,
          client_reference_id: checkout.json.orderId,
          metadata: { order_id: checkout.json.orderId },
          amount_total: 100,
          currency: 'gbp',
          payment_status: 'paid',
          payment_intent: `pi_e2e_${checkout.json.orderId}`
        }
      }
    };
    const paidSessionRaw = JSON.stringify(paidSessionEvent);
    const paidSessionTimestamp = Math.floor(Date.now() / 1000);
    const paidSessionSignature = crypto.createHmac('sha256', 'whsec_phase0_test_only')
      .update(`${paidSessionTimestamp}.${paidSessionRaw}`)
      .digest('hex');
    const paidWebhook = await api('/api/onramp/webhook', {
      method: 'POST',
      body: paidSessionEvent,
      headers: { 'Stripe-Signature': `t=${paidSessionTimestamp},v1=${paidSessionSignature}` }
    });
    check('signed Stripe test payment is accepted', paidWebhook.status === 200, paidWebhook.text);
    let purchasedOrder = null;
    for (let i = 0; i < 100; i++) {
      purchasedOrder = (await api(`/api/onramp/orders/${checkoutSessionId}`, { user: journeyUser })).json?.order;
      if (purchasedOrder?.status === 'fulfilled' || purchasedOrder?.status === 'manual_review') break;
      await sleep(200);
    }
    check('paid Stripe test order fulfills through the simulated chain',
      purchasedOrder?.status === 'fulfilled', purchasedOrder?.failure || purchasedOrder?.status || 'missing');
    const balanceAfterPurchase = (await api('/api/wallet', { user: journeyUser })).json?.available;
    check('NUM purchase credits the quoted amount exactly once',
      Math.abs(balanceAfterPurchase - balanceAfterDeposit - 40) < 0.001,
      `${balanceAfterDeposit} → ${balanceAfterPurchase}`);

    /* ---- 3. claim → deed mint ---- */
    const target = plots.find(p =>
      !p.isClaimed && !p.isLandmark && p.rarity === 1 &&
      Number(p.resourceDeposits?.silver) > 0
    );
    check('found claimable common plot', !!target, target?.id);

    const claim = await api(`/api/plots/${target.id}/claim`, { method: 'POST', user: 'danie', body: {} });
    check('claim accepted', claim.status === 200 && claim.json?.pending === true, claim.json?.message || claim.text);
    check('claim reports 10-block queue', claim.json?.job?.requiredConfirmations === 10);
    check('job status requires authentication',
      (await api(`/api/jobs/${claim.json.job.id}`)).status === 401);
    check('plot job status requires authentication',
      (await api(`/api/plots/${target.id}/job`)).status === 401);
    check('another player cannot read job status',
      (await api(`/api/jobs/${claim.json.job.id}`, { user: 'mercantile' })).status === 404);
    check('another player cannot read plot job status',
      (await api(`/api/plots/${target.id}/job`, { user: 'mercantile' })).status === 404);
    check('another player cannot read job from public plot details',
      (await api(`/api/plots/${target.id}`, { user: 'mercantile' })).json?.job === null);
    check('job owner can read job status',
      (await api(`/api/jobs/${claim.json.job.id}`, { user: 'danie' })).status === 200);
    check('public plot details do not expose job details',
      (await api(`/api/plots/${target.id}`)).json?.job === null);
    check('job owner can read job from plot details',
      (await api(`/api/plots/${target.id}`, { user: 'danie' })).json?.job?.id === claim.json.job.id);

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

    for (let level = 3; level <= 10; level++) {
      const nextUpgrade = await api(`/api/plots/${target.id}/upgrade`, { method: 'POST', user: 'danie', body: {} });
      check(`level ${level} upgrade accepted`, nextUpgrade.status === 200 && nextUpgrade.json?.level === level, nextUpgrade.json?.error || '');
      const nextJob = await waitForJob(nextUpgrade.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
      check(`level ${level} upgrade confirmed`, nextJob.status === 'confirmed', nextJob.failure || '');
      if (level === 5) {
        const motteAndBailey = await api(`/api/plots/${target.id}`);
        check('level 5 settlement becomes a Motte-and-Bailey',
          motteAndBailey.json.plot.building?.settlementForm === 'motte_and_bailey' &&
          motteAndBailey.json.plot.building?.name.startsWith('Motte-and-Bailey'));
      }
    }
    const castlePlot = await api(`/api/plots/${target.id}`);
    check('level 10 settlement becomes a player-owned castle',
      castlePlot.json.plot.building?.settlementForm === 'castle' &&
      castlePlot.json.plot.isCastle === true &&
      castlePlot.json.plot.castleOwner === 'danie');
    check('castle reaches full castle integrity',
      castlePlot.json.plot.maxHealth === 1000 && castlePlot.json.plot.health === 1000);
    const crownCastles = await api('/api/castles');
    check('player castle is not listed as a Crown castle target',
      !crownCastles.json.castles.some(plot => plot.id === target.id));

    /* ---- 5. plot resources and owner-issued metal assets ---- */
    const metal = Number(castlePlot.json.plot.resourceDeposits?.silver) > 0 ? 'silver' : 'gold';
    const mine = await api(`/api/plots/${target.id}/build`, {
      method: 'POST', user: 'danie', body: { structureType: `${metal}_mine` }
    });
    check('owner can build a precious-metal mine', mine.status === 200, mine.json?.error || '');

    const deniedMetalMint = await api(`/api/plots/${target.id}/metal-mint`, {
      method: 'POST', user: 'mercantile',
      body: { metal, form: 'coin', weightGrams: 0.001, purity: 0.999 }
    });
    check('non-owner cannot mint a plot metal asset', deniedMetalMint.status === 400);

    let resourcePlot = null;
    for (let i = 0; i < 120; i++) {
      resourcePlot = (await api(`/api/plots/${target.id}`)).json?.plot;
      if (Number(resourcePlot?.stockpile?.[metal]) >= 0.02) break;
      await sleep(250);
    }
    check('mine produces stock for metal minting', Number(resourcePlot?.stockpile?.[metal]) >= 0.02);
    const metalBeforeMint = Number(resourcePlot.stockpile[metal]);
    const metalMint = await api(`/api/plots/${target.id}/metal-mint`, {
      method: 'POST', user: 'danie',
      body: { metal, form: 'coin', weightGrams: 0.02, purity: 0.999 }
    });
    check('plot owner can queue metal asset mint', metalMint.status === 200 && metalMint.json?.pending, metalMint.json?.error || '');
    const metalJob = await waitForJob(metalMint.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('owner-issued metal asset confirms', metalJob.status === 'confirmed', metalJob.failure || '');
    const asset = await api(`/api/assets/${metalMint.json.assetId}`);
    check('minted metal asset is on chain', asset.status === 200 && asset.json.asset.assetType === 'fungible');
    const metalMetadata = await api(`/api/assets/${metalMint.json.assetId}/metadata`);
    check('metal asset metadata records its plot owner',
      metalMetadata.json?.verified === true &&
      metalMetadata.json?.metadata?.issuer === 'danie' &&
      (metalMetadata.json?.metadata?.originPlotId === target.id ||
       metalMetadata.json?.metadata?.plotId === target.id));
    const metalBalance = await api(`/api/assets/${metalMint.json.assetId}/balance/danie`);
    check('metal asset minted to the owner', Number(metalBalance.json?.balance) > 0);
    const resourceAfterMint = (await api(`/api/plots/${target.id}`)).json.plot;
    check('metal stock is consumed only after mint submission', Number(resourceAfterMint.stockpile[metal]) < metalBeforeMint);
    check('metal asset mint does not replace the plot deed', resourceAfterMint.nftState?.assetId === afterClaim.json.plot.nftState.assetId);

    /* ---- 6. forged gear and silver-paid army dispatch ---- */
    const enemyTarget = plots.find(p =>
      !p.isClaimed && !p.isLandmark && p.rarity === 1 &&
      Math.abs(p.row - target.row) + Math.abs(p.col - target.col) === 1
    );
    check('found adjacent enemy plot for army test', !!enemyTarget, enemyTarget?.id);
    const enemyClaim = await api(`/api/plots/${enemyTarget.id}/claim`, { method: 'POST', user: 'mercantile', body: {} });
    check('enemy plot claim accepted', enemyClaim.status === 200 && enemyClaim.json?.pending, enemyClaim.json?.error || '');
    check('another player cannot read job status',
      (await api(`/api/jobs/${claim.json.job.id}`, { user: 'mercantile' })).status === 404);
    check('admin can read plot job status',
      (await api(`/api/plots/${enemyTarget.id}/job`, { user: 'danie' })).status === 200);
    check('admin can read job from public plot details',
      (await api(`/api/plots/${enemyTarget.id}`, { user: 'danie' })).json?.job?.id === enemyClaim.json.job.id);
    check('plot owner can read job from plot details',
      (await api(`/api/plots/${enemyTarget.id}`, { user: 'mercantile' })).json?.job?.id === enemyClaim.json.job.id);
    const enemyClaimJob = await waitForJob(enemyClaim.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status), 60000, 'mercantile');
    check('enemy plot deed confirmed', enemyClaimJob.status === 'confirmed', enemyClaimJob.failure || '');

    const forge = await api(`/api/plots/${enemyTarget.id}/build`, {
      method: 'POST', user: 'mercantile', body: { structureType: 'forge' }
    });
    check('settlement forge can be built', forge.status === 200, forge.json?.error || '');
    const helmetCraft = await api(`/api/plots/${enemyTarget.id}/craft`, {
      method: 'POST', user: 'mercantile', body: { recipe: 'iron_helmet' }
    });
    check('iron helmet can be forged', helmetCraft.status === 200 && helmetCraft.json?.item?.slot === 'helmet', helmetCraft.json?.error || '');
    check('forged helmet has health and HP bonus',
      helmetCraft.json?.item?.health === helmetCraft.json?.item?.maxHealth &&
      helmetCraft.json?.item?.hpBonus > 0);

    const merchantTitle = await api('/api/titles/buy', {
      method: 'POST', user: 'mercantile', body: { titleKey: 'baron' }
    });
    check('merchant peerage purchase accepted', merchantTitle.status === 200 && merchantTitle.json?.pending);
    const merchantTitleJob = await waitForJob(merchantTitle.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status), 60000, 'mercantile');
    check('merchant peerage confirmed', merchantTitleJob.status === 'confirmed', merchantTitleJob.failure || '');
    const merchantRecruit = await api('/api/army/recruit', {
      method: 'POST', user: 'mercantile', body: { unitType: 'levy', count: 1 }
    });
    check('defending soldier recruitment accepted', merchantRecruit.status === 200 && merchantRecruit.json?.pending);
    const merchantRecruitJob = await waitForJob(merchantRecruit.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status), 60000, 'mercantile');
    check('defending soldier recruited', merchantRecruitJob.status === 'confirmed', merchantRecruitJob.failure || '');
    let merchantRoster = await api('/api/soldiers', { user: 'mercantile' });
    const defender = merchantRoster.json?.soldiers?.[0];
    const equipHelmet = await api(`/api/soldiers/${defender.id}/equip`, {
      method: 'POST', user: 'mercantile', body: { itemId: helmetCraft.json.item.id }
    });
    check('helmet equips and adds soldier HP', equipHelmet.status === 200 && equipHelmet.json?.soldier?.maxHp === 112, equipHelmet.json?.error || '');
    const defenderArmy = await api('/api/army/create', {
      method: 'POST', user: 'mercantile', body: { name: 'Silverguard', soldierIds: [defender.id] }
    });
    check('defender army formed', defenderArmy.status === 200, defenderArmy.json?.error || '');

    const attackerTitle = await api('/api/titles/buy', {
      method: 'POST', user: 'danie', body: { titleKey: 'baron' }
    });
    check('attacker peerage purchase accepted', attackerTitle.status === 200 && attackerTitle.json?.pending);
    const attackerTitleJob = await waitForJob(attackerTitle.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('attacker peerage confirmed', attackerTitleJob.status === 'confirmed', attackerTitleJob.failure || '');
    const attackerRecruit = await api('/api/army/recruit', {
      method: 'POST', user: 'danie', body: { unitType: 'cavalry', count: 1 }
    });
    check('attacker cavalry recruitment accepted', attackerRecruit.status === 200 && attackerRecruit.json?.pending);
    const attackerRecruitJob = await waitForJob(attackerRecruit.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('attacker cavalry recruited', attackerRecruitJob.status === 'confirmed', attackerRecruitJob.failure || '');
    const attackerRoster = await api('/api/soldiers', { user: 'danie' });
    const attacker = attackerRoster.json?.soldiers?.[0];
    const attackArmy = await api('/api/army/create', {
      method: 'POST', user: 'danie', body: { name: 'Silver Lance', soldierIds: [attacker.id] }
    });
    check('attacking army formed', attackArmy.status === 200, attackArmy.json?.error || '');
    const armyId = attackArmy.json?.army?.id;

    const estimate = await api(`/api/army/${armyId}/march-estimate?targetPlotId=${enemyTarget.id}`, { user: 'danie' });
    check('attack estimate prices route distance in silver',
      estimate.status === 200 &&
      estimate.json?.estimate?.distanceTiles === 1 &&
      estimate.json?.estimate?.silverFineGrams === 0.01 &&
      estimate.json?.estimate?.canAfford === true,
      estimate.json?.error || JSON.stringify(estimate.json?.estimate));
    const attack = await api(`/api/army/${armyId}/move`, {
      method: 'POST', user: 'danie',
      body: { targetPlotId: enemyTarget.id, siege: true }
    });
    check('attack waits for silver payroll confirmation',
      attack.status === 200 && attack.json?.pending === true && attack.json?.army?.status === 'payroll_pending',
      attack.json?.error || '');
    const payrollJob = await waitForJob(attack.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('player-minted silver payroll confirms before march', payrollJob.status === 'confirmed', payrollJob.failure || '');
    const paidAssetBalance = await api(`/api/assets/${metalMint.json.assetId}/balance/danie`);
    check('silver balance decreases by the distance-based fee',
      Number(paidAssetBalance.json?.balanceUnits) === Number(metalBalance.json?.balanceUnits) - 10);
    const marchingArmy = (await api('/api/army', { user: 'danie' })).json?.army?.armies?.find(a => a.id === armyId);
    check('army begins marching only after payroll confirms', marchingArmy?.status === 'marching_to_siege');

    let battle = null;
    for (let i = 0; i < 150 && !battle; i++) {
      const currentArmy = await api('/api/army', { user: 'danie' });
      battle = currentArmy.json?.army?.battles?.find(b => b.plotId === enemyTarget.id && b.attacker === 'danie');
      if (!battle) await sleep(500);
    }
    check('silver-paid army reaches battle', !!battle);
    check('battle report records helmet HP and wear',
      battle?.defenderRoster?.[0]?.helmet?.maxHealth === 90 &&
      battle?.equipmentWear?.some(w => w.soldierId === defender.id && w.helmet === 1));
    merchantRoster = await api('/api/soldiers', { user: 'mercantile' });
    check('helmet loses health after battle', merchantRoster.json?.soldiers?.find(s => s.id === defender.id)?.helmet?.health === 89);

    /* ---- 7. failure + rollback ---- */
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

    /* ---- 8. admin gating ---- */
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
    check('admin can strike gold', adminMint.status === 200 && adminMint.json?.coin?.coin?.metal === 'gold', `${adminMint.status}: ${adminMint.text}`);

    /* ---- 8. renewable wood production ---- */
    const woodTarget = plots.find(p => !p.isClaimed && !p.isLandmark && p.rarity === 1 &&
      p.id !== target.id && p.id !== rollbackTarget.id && p.id !== enemyTarget.id);
    const woodClaim = await api(`/api/plots/${woodTarget.id}/claim`, { method: 'POST', user: 'danie', body: {} });
    check('wood production plot claimed', woodClaim.status === 200, woodClaim.json?.error || '');
    const woodClaimJob = await waitForJob(woodClaim.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('wood plot deed confirms', woodClaimJob.status === 'confirmed', woodClaimJob.failure || '');
    const woodBefore = (await api(`/api/plots/${woodTarget.id}`)).json.plot;
    const woodcutter = await api(`/api/plots/${woodTarget.id}/build`, {
      method: 'POST', user: 'danie', body: { structureType: 'woodcutter' }
    });
    check('woodcutter can be built on the plot', woodcutter.status === 200, woodcutter.json?.error || '');
    const woodAfterBuild = woodcutter.json.plot;
    let woodAfter = null;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      woodAfter = (await api(`/api/plots/${woodTarget.id}`)).json?.plot;
      if (Number(woodAfter?.stockpile?.wood) > Number(woodAfterBuild.stockpile.wood)) break;
    }
    check('wood regenerates into the plot stockpile',
      Number(woodAfter?.stockpile?.wood) > Number(woodAfterBuild.stockpile.wood),
      `${woodAfterBuild.stockpile.wood} → ${woodAfter?.stockpile?.wood}`);
    check('woodcutter does not deplete the renewable wood deposit',
      Number(woodAfter?.resourceDeposits?.wood) === Number(woodAfterBuild.resourceDeposits.wood),
      `${woodAfterBuild.resourceDeposits.wood} → ${woodAfter?.resourceDeposits?.wood}`);

    /* ---- 9. atomic plot sales and asset auctions ---- */
    const listing = await api(`/api/plots/${woodTarget.id}/list`, {
      method: 'POST', user: 'danie', body: { priceNum: 1 }
    });
    check('confirmed plot deed can be listed for sale',
      listing.status === 200 && listing.json?.plot?.marketListing?.priceNum === 1,
      listing.json?.error || '');
    const buyerBalanceBeforeSale = (await api('/api/wallet', { user: 'mercantile' })).json.available;
    await api('/api/dev/sim/fail', { method: 'POST', user: 'danie', body: { count: 1 } });
    const failedSale = await api(`/api/plots/${woodTarget.id}/buy`, { method: 'POST', user: 'mercantile' });
    check('plot purchase reserves payment without changing ownership',
      failedSale.status === 200 && failedSale.json?.plot?.owner === '@danie' && failedSale.json?.plot?.marketSalePending,
      failedSale.json?.error || '');
    const failedSaleJob = await waitForJob(failedSale.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('failed plot purchase rolls back cleanly', failedSaleJob.status === 'failed');
    const saleAfterFailure = await api(`/api/plots/${woodTarget.id}`);
    check('failed plot purchase preserves listing and seller ownership',
      saleAfterFailure.json?.plot?.owner === '@danie' && saleAfterFailure.json?.plot?.marketListing?.seller === 'danie' &&
      saleAfterFailure.json?.plot?.marketSalePending === false);
    check('failed plot purchase restores buyer balance',
      Math.abs((await api('/api/wallet', { user: 'mercantile' })).json.available - buyerBalanceBeforeSale) < 0.001);
    const successfulSale = await api(`/api/plots/${woodTarget.id}/buy`, { method: 'POST', user: 'mercantile' });
    const successfulSaleJob = await waitForJob(successfulSale.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('plot payment and deed transfer confirm together', successfulSaleJob.status === 'confirmed', successfulSaleJob.failure || '');
    const deedAfterSale = await api(`/api/assets/${successfulSaleJob.assetId}/balance/mercantile`);
    const plotAfterSale = await api(`/api/plots/${woodTarget.id}`);
    check('confirmed plot sale transfers on-chain and local ownership',
      Number(deedAfterSale.json?.balanceUnits) === 1 && plotAfterSale.json?.plot?.owner === '@mercantile' &&
      plotAfterSale.json?.plot?.marketListing === null);

    const baron = await api('/api/titles/buy', { method: 'POST', user: 'danie', body: { titleKey: 'baron' } });
    await waitForJob(baron.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    const buyoutAuction = await api('/api/auctions/create', {
      method: 'POST', user: 'danie',
      body: { category: 'Peerage Title', assetRef: 'Baron / Baroness', startingBid: 0.05, buyoutPrice: 1, durationHours: 1 }
    });
    check('auction listing requires and accepts a player-owned title',
      buyoutAuction.status === 200, buyoutAuction.json?.error || '');
    const buyerBalanceBeforeBuyout = (await api('/api/wallet', { user: 'mercantile' })).json.available;
    await api('/api/dev/sim/fail', { method: 'POST', user: 'danie', body: { count: 1 } });
    const rejectedBuyout = await api(`/api/auctions/${buyoutAuction.json.auction.id}/buyout`, {
      method: 'POST', user: 'mercantile'
    });
    const rejectedBuyoutJob = await waitForJob(rejectedBuyout.json.auction.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    const auctionAfterBuyoutFailure = (await api('/api/auctions')).json.auctions
      .find(item => item.id === buyoutAuction.json.auction.id);
    check('failed buyout restores funds and leaves the title listed',
      rejectedBuyoutJob.status === 'failed' && auctionAfterBuyoutFailure.status === 'active' &&
      (await api('/api/army', { user: 'danie' })).json?.army?.peerage === 'Baron / Baroness' &&
      Math.abs((await api('/api/wallet', { user: 'mercantile' })).json.available - buyerBalanceBeforeBuyout) < 0.001);
    const buyout = await api(`/api/auctions/${buyoutAuction.json.auction.id}/buyout`, {
      method: 'POST', user: 'mercantile'
    });
    const buyoutJob = await waitForJob(buyout.json.auction.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('auction buyout settles payment before transferring the title',
      buyoutJob.status === 'confirmed' && (await api('/api/army', { user: 'mercantile' })).json?.army?.peerage === 'Baron / Baroness',
      buyoutJob.failure || '');

    const earl = await api('/api/titles/buy', { method: 'POST', user: 'danie', body: { titleKey: 'earl' } });
    await waitForJob(earl.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    const bidAuction = await api('/api/auctions/create', {
      method: 'POST', user: 'danie',
      body: { category: 'Peerage Title', assetRef: 'Earl / Countess', startingBid: 0.05, durationHours: 1 }
    });
    check('second player-owned title can be listed', bidAuction.status === 200, bidAuction.json?.error || '');
    const bid = await api(`/api/auctions/${bidAuction.json.auction.id}/bid`, {
      method: 'POST', user: 'mercantile', body: { amount: 0.1 }
    });
    const bidJob = await waitForJob(bid.json.auction.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('auction bid enters confirmed escrow', bidJob.status === 'confirmed', bidJob.failure || '');
    const expiredAuction = await api(`/api/dev/sim/expire-auction/${bidAuction.json.auction.id}`, {
      method: 'POST', user: 'danie'
    });
    const settlementJob = await waitForJob(expiredAuction.json.job.id, j => ['confirmed', 'reverted', 'failed'].includes(j.status));
    check('expired auction pays seller and transfers the asset after confirmation',
      settlementJob.status === 'confirmed' &&
      (await api('/api/army', { user: 'mercantile' })).json?.army?.peerage === 'Earl / Countess',
      settlementJob.failure || '');

    /* ---- 10. recover failed native-deposit mints ---- */
    const depositBalanceBefore = (await api('/api/wallet', { user: 'danie' })).json.available;
    const deposit = await api('/api/dev/sim/deposit-failure', {
      method: 'POST', user: 'danie', body: { amount: 0.5 }
    });
    check('simulated native deposit is queued with failure injected', deposit.status === 200, deposit.json?.error || '');
    const failedDepositJob = await waitForJob(deposit.json.job.id, j => ['failed', 'reverted'].includes(j.status));
    check('failed deposit mint remains recoverable', failedDepositJob.status === 'failed');
    let recoveredDepositBalance = depositBalanceBefore;
    for (let i = 0; i < 80 && recoveredDepositBalance < depositBalanceBefore + 0.5; i++) {
      await sleep(250);
      recoveredDepositBalance = (await api('/api/wallet', { user: 'danie' })).json.available;
    }
    check('failed native deposit is re-minted without another native transfer',
      Math.abs(recoveredDepositBalance - depositBalanceBefore - 0.5) < 0.001);

    /* ---- 11. no fabricated tx hashes in balances ---- */
    const wallet = await api('/api/wallet', { user: 'danie' });
    const transfers = wallet.json?.recentTransfers || [];
    check('wallet transfers have no placeholder hashes',
      transfers.every(t => t.txHash === null || /^[a-f0-9]{64}$/.test(t.txHash)));

    const ledgerSummary = (await api('/api/network/capabilities')).json.ledger;
    check('ledger has no negative/locked residue', ledgerSummary.locked === 0, JSON.stringify(ledgerSummary));

    /* ---- 12. single-player signup-to-conquest journey ---- */
    const journeyWorld = (await api('/api/plots')).json.plots;
    let journeyHome = null;
    let journeyEnemy = null;
    for (const candidate of journeyWorld) {
      if (candidate.isClaimed || candidate.isLandmark || candidate.rarity !== 1 ||
          !(Number(candidate.resourceDeposits?.silver) >= 0.2)) continue;
      const neighbor = journeyWorld.find(plot =>
        !plot.isClaimed && !plot.isLandmark && plot.rarity === 1 &&
        Math.abs(plot.row - candidate.row) + Math.abs(plot.col - candidate.col) === 1
      );
      if (neighbor) {
        journeyHome = candidate;
        journeyEnemy = neighbor;
        break;
      }
    }
    check('full journey finds a silver settlement beside an enemy plot',
      !!journeyHome && !!journeyEnemy, journeyHome?.id || '');

    const journeyClaim = await api(`/api/plots/${journeyHome.id}/claim`, {
      method: 'POST', user: journeyUser, body: {}
    });
    check('new player buys a plot after signup, deposit, and NUM purchase',
      journeyClaim.status === 200 && journeyClaim.json?.pending,
      journeyClaim.json?.error || '');
    const journeyClaimJob = await waitForJob(
      journeyClaim.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      journeyUser
    );
    check('new player plot deed confirms', journeyClaimJob.status === 'confirmed', journeyClaimJob.failure || '');

    let journeyLevel = 1;
    while (journeyLevel < 10) {
      const upgrade = await api(`/api/plots/${journeyHome.id}/upgrade`, {
        method: 'POST', user: journeyUser, body: {}
      });
      if (upgrade.status !== 200 || !upgrade.json?.job?.id) {
        check(`property upgrade to level ${journeyLevel + 1} is accepted`, false, upgrade.json?.error || upgrade.text);
      }
      const upgradeJob = await waitForJob(
        upgrade.json.job.id,
        j => ['confirmed', 'failed', 'reverted'].includes(j.status),
        60000,
        journeyUser
      );
      check(`property upgrade to level ${journeyLevel + 1} confirms`,
        upgradeJob.status === 'confirmed', upgradeJob.failure || '');
      journeyLevel += 1;
    }
    const journeyCastle = (await api(`/api/plots/${journeyHome.id}`)).json?.plot;
    check('full journey reaches the level-10 castle upgrade',
      journeyCastle?.building?.level === 10 && journeyCastle?.isCastle === true);

    const journeyMine = await api(`/api/plots/${journeyHome.id}/build`, {
      method: 'POST', user: journeyUser, body: { structureType: 'silver_mine' }
    });
    check('new player builds a silver mine on the upgraded plot',
      journeyMine.status === 200, journeyMine.json?.error || '');
    const fastForward = await api('/api/dev/sim/tick', {
      method: 'POST', user: 'danie', body: { ticks: 30 }
    });
    check('simulation advances resource production for the test',
      fastForward.status === 200 && fastForward.json?.ticks === 30, fastForward.json?.error || '');
    const journeyResources = (await api(`/api/plots/${journeyHome.id}`)).json?.plot;
    check('silver mine produces enough stock for an asset mint',
      Number(journeyResources?.stockpile?.silver) >= 0.2,
      String(journeyResources?.stockpile?.silver));
    const journeyMint = await api(`/api/plots/${journeyHome.id}/metal-mint`, {
      method: 'POST',
      user: journeyUser,
      body: { metal: 'silver', form: 'coin', weightGrams: 0.2, purity: 0.999 }
    });
    check('new player mints silver from the plot mine',
      journeyMint.status === 200 && journeyMint.json?.pending, journeyMint.json?.error || '');
    const journeyMintJob = await waitForJob(
      journeyMint.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      journeyUser
    );
    check('new player silver asset is confirmed',
      journeyMintJob.status === 'confirmed', journeyMintJob.failure || '');

    const defenderDeposit = await api('/api/dev/sim/deposit', {
      method: 'POST', user: 'danie', body: { recipientUsername: 'mercantile', amount: 100 }
    });
    check('test opponent has simulated funds for a plot deed',
      defenderDeposit.status === 200, defenderDeposit.json?.error || '');
    const defenderDepositJob = await waitForJob(
      defenderDeposit.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      'mercantile'
    );
    check('opponent deposit confirms', defenderDepositJob.status === 'confirmed', defenderDepositJob.failure || '');
    const journeyEnemyClaim = await api(`/api/plots/${journeyEnemy.id}/claim`, {
      method: 'POST', user: 'mercantile', body: {}
    });
    check('another player claims the future conquest target',
      journeyEnemyClaim.status === 200 && journeyEnemyClaim.json?.pending,
      journeyEnemyClaim.json?.error || '');
    const journeyEnemyJob = await waitForJob(
      journeyEnemyClaim.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      'mercantile'
    );
    check('opponent deed confirms before the battle', journeyEnemyJob.status === 'confirmed', journeyEnemyJob.failure || '');

    const journeyTitle = await api('/api/titles/buy', {
      method: 'POST', user: journeyUser, body: { titleKey: 'baron' }
    });
    check('new player purchases peerage', journeyTitle.status === 200 && journeyTitle.json?.pending);
    const journeyTitleJob = await waitForJob(
      journeyTitle.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      journeyUser
    );
    check('peerage confirms and unlocks recruitment',
      journeyTitleJob.status === 'confirmed' &&
      (await api('/api/army', { user: journeyUser })).json?.army?.peerage === 'Baron / Baroness',
      journeyTitleJob.failure || '');

    const journeyRecruit = await api('/api/army/recruit', {
      method: 'POST', user: journeyUser, body: { unitType: 'cavalry', count: 20 }
    });
    check('new peer forms a cavalry army', journeyRecruit.status === 200 && journeyRecruit.json?.pending);
    const journeyRecruitJob = await waitForJob(
      journeyRecruit.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      journeyUser
    );
    check('cavalry recruitment confirms', journeyRecruitJob.status === 'confirmed', journeyRecruitJob.failure || '');
    const journeyRoster = (await api('/api/soldiers', { user: journeyUser })).json?.soldiers || [];
    const journeyArmy = await api('/api/army/create', {
      method: 'POST',
      user: journeyUser,
      body: { name: 'Test Conquest', soldierIds: journeyRoster.map(soldier => soldier.id) }
    });
    check('new player forms an army from recruited soldiers',
      journeyArmy.status === 200 && journeyArmy.json?.army?.soldierIds?.length === 20,
      journeyArmy.json?.error || '');

    const journeyEstimate = await api(
      `/api/army/${journeyArmy.json.army.id}/march-estimate?targetPlotId=${journeyEnemy.id}`,
      { user: journeyUser }
    );
    check('army has silver for the adjacent attack',
      journeyEstimate.status === 200 &&
      journeyEstimate.json?.estimate?.distanceTiles === 1 &&
      journeyEstimate.json?.estimate?.silverFineGrams === 0.2 &&
      journeyEstimate.json?.estimate?.canAfford === true,
      journeyEstimate.json?.error || JSON.stringify(journeyEstimate.json?.estimate));
    const journeyAttack = await api(`/api/army/${journeyArmy.json.army.id}/move`, {
      method: 'POST',
      user: journeyUser,
      body: { targetPlotId: journeyEnemy.id, siege: true }
    });
    check('army marches after confirmed silver payroll',
      journeyAttack.status === 200 && journeyAttack.json?.pending === true,
      journeyAttack.json?.error || '');
    const journeyPayrollJob = await waitForJob(
      journeyAttack.json.job.id,
      j => ['confirmed', 'failed', 'reverted'].includes(j.status),
      60000,
      journeyUser
    );
    check('silver payroll settles before battle', journeyPayrollJob.status === 'confirmed', journeyPayrollJob.failure || '');

    let conquest = null;
    for (let i = 0; i < 240 && !conquest; i++) {
      const armyState = (await api('/api/army', { user: journeyUser })).json?.army;
      conquest = armyState?.battles?.find(battle =>
        battle.plotId === journeyEnemy.id && battle.attacker === journeyUser && battle.captured
      );
      if (!conquest) await sleep(250);
    }
    check('new player wins battle and captures the opponent plot', !!conquest);
    const conqueredPlot = (await api(`/api/plots/${journeyEnemy.id}`)).json?.plot;
    check('battle settlement transfers plot control to the victor',
      conqueredPlot?.controller === journeyUser && conqueredPlot?.health < conqueredPlot?.maxHealth);
    const battleAsset = await api(`/api/assets/${conquest.assetId}`);
    check('confirmed battle report is recorded as an on-chain asset',
      battleAsset.status === 200 && battleAsset.json?.asset?.assetType === 'collectible');

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
