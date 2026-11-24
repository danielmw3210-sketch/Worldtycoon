/**
 * Chain identity
 * ─────────────────────────────────────────────────────────────────────────────
 * Numista asset operations address usernames, not raw addresses. Before a
 * username can receive a mint or a transfer it must be registered on chain.
 *
 * The game is custodial: every game username is registered against the single
 * issuer public key, and the custodial issuer wallet signs all operations.
 *
 * Registration is a normal queued chain step, so it reaches the same
 * 10-confirmation depth as every other operation and rolls back like any other
 * step.
 */

import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { chainAdapter } from './chainAdapter.js';
import { chainLedger } from '../data/chainLedger.js';
import { userManager } from '../data/users.js';
import { mintQueue } from './mintQueue.js';

/** Institutional, non-login accounts used by game services. */
export const INSTITUTIONAL_ACCOUNTS = [
  CONFIG.CHAIN.TREASURY_USERNAME,
  'auction_escrow',
  'numista_bank',
  'stock_broker'
];

export function registrationStep(username) {
  const clean = String(username || '').trim().toLowerCase();
  return {
    key: `register_${clean}`,
    label: `Register @${clean} on chain`,
    operation: {
      kind: 'register_username',
      username: clean,
      key: CONFIG.CHAIN.ISSUER_PUBLIC_KEY
    },
    compensate: null
  };
}

export function needsRegistration(username) {
  const clean = String(username || '').trim().toLowerCase();
  if (!clean) return false;
  if (chainLedger.getUsernameRecord(clean)) return false;
  const user = userManager.getUser(clean);
  if (user?.chainIdentity === 'registered') return false;
  const active = mintQueue.jobs.some(job =>
    job.steps?.some(step =>
      step.key === `register_${clean}` &&
      !step.compensation &&
      ['pending', 'submitted', 'confirmed'].includes(step.status)
    )
  );
  if (active) return false;
  return true;
}

/**
 * Registration steps to place before a job that involves these usernames.
 * Already-registered users produce no step, so the 10-block confirmation cost
 * is paid once per username rather than on every operation.
 */
export function registrationSteps(usernames = []) {
  const unique = [...new Set(
    usernames
      .filter(Boolean)
      .map(name => String(name).trim().toLowerCase())
      .filter(Boolean)
  )];
  const steps = unique.filter(needsRegistration).map(registrationStep);
  steps.forEach(step => {
    const user = userManager.getUser(step.operation.username);
    if (user && user.chainIdentity !== 'pending') {
      try { userManager.setChainIdentity(step.operation.username, 'pending'); } catch { /* ignore */ }
    }
  });
  return steps;
}

/** Mark usernames that just confirmed a registration step. */
export function applyRegistrationConfirmations(job) {
  for (const step of job.steps || []) {
    if (!step.key?.startsWith('register_') || step.compensation) continue;
    if (step.status !== 'confirmed') continue;
    const username = step.operation?.username;
    if (!username) continue;
    chainLedger.markUsernameRegistered(username, { key: step.operation.key, jobId: job.id });
    try { userManager.setChainIdentity(username, 'registered'); } catch { /* ignore */ }
  }
}

/** Mark users whose registration step was rolled back. */
export function applyRegistrationReverts(job) {
  for (const step of job.steps || []) {
    if (!step.key?.startsWith('register_') || step.compensation) continue;
    const username = step.operation?.username;
    if (!username) continue;
    if (step.status === 'confirmed') continue;
    try { userManager.setChainIdentity(username, 'failed'); } catch { /* ignore */ }
  }
}

/** Probe the chain and cache identities that already exist there. */
export async function reconcileIdentities(usernames = userManager.allUsernames()) {
  let found = 0;
  for (const username of usernames) {
    if (chainLedger.getUsernameRecord(username)) continue;
    try {
      const record = await chainAdapter.getUsernameKey(username);
      if (record) {
        chainLedger.markUsernameRegistered(username, { key: record.key || null });
        userManager.setChainIdentity(username, 'registered');
        found += 1;
      }
    } catch { /* node hiccup: leave unregistered */ }
  }
  if (found) console.log(`[identity] Reconciled ${found} registered username(s) from chain`);
  return found;
}

/** Ensure all institutional accounts have a registration job. */
export function ensureInstitutionalIdentities() {
  const missing = INSTITUTIONAL_ACCOUNTS.filter(name => needsRegistration(name));
  if (!missing.length) return null;
  missing.forEach(name => {
    if (!userManager.getUser(name)) {
      // Institutional accounts are not login accounts; create a locked record.
      userManager.users.set(name, {
        username: name,
        password: crypto.randomBytes(24).toString('hex'),
        role: 'institution',
        createdAt: new Date().toISOString(),
        wallet: userManager._emptyWallet(),
        receiveAddress: null,
        chainIdentity: 'pending'
      });
    }
  });
  userManager.save();
  const steps = missing.map(registrationStep);
  return mintQueue.enqueue({
    type: 'identity',
    username: null,
    assetId: null,
    requiredConfirmations: CONFIG.CHAIN.CONFIRMATIONS,
    snapshot: { usernames: missing },
    meta: { name: 'Institutional chain identity' },
    steps
  });
}
