/**
 * Mint queue
 * ─────────────────────────────────────────────────────────────────────────────
 * Every deed mint, income payout, upgrade and transfer is submitted as an
 * on-chain Numista asset operation. Each job is a sequence of steps that must
 * reach CHAIN.CONFIRMATIONS blocks before the game state commits.
 *
 * If any step fails (or is dropped from the transaction pool), the job is
 * reverted:
 *   - game state is restored from the job snapshot;
 *   - every already-confirmed step with a `compensate` operation is undone with
 *     a compensating on-chain transaction (assets cannot be destroyed).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ACTIVE_STATUSES = new Set(['queued', 'confirming', 'reverting']);
const TERMINAL_STATUSES = new Set(['confirmed', 'reverted', 'failed', 'revert_failed']);

function nowIso() {
  return new Date().toISOString();
}

class MintQueue {
  constructor({ adapter, file, pollMs = CONFIG.CHAIN.POLL_MS, timeoutMs = CONFIG.CHAIN.TX_TIMEOUT_MS } = {}) {
    this.adapter = adapter;
    this.file = file || process.env.NUMISTA_QUEUE_FILE || path.join(__dirname, '..', 'data', 'mintQueue.json');
    this.pollMs = pollMs;
    this.timeoutMs = timeoutMs;
    this.jobs = [];
    this.history = [];
    this.handlers = { onConfirmed: null, onReverted: null };
    this._timer = null;
    this._busy = false;
    this._saveTimer = null;
    this._ready = false;
  }

  configure({ adapter }) {
    if (adapter) this.adapter = adapter;
  }

  setHandlers({ onConfirmed, onReverted }) {
    this.handlers.onConfirmed = onConfirmed || null;
    this.handlers.onReverted = onReverted || null;
  }

  /* ---- persistence ---- */

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.jobs = (raw.jobs || []).filter(j => j && j.id);
      this.history = (raw.history || []).filter(j => j && j.id).slice(0, 200);
      // Anything that was mid-flight when the process stopped resumes polling.
      this.jobs.forEach(job => {
        if (!ACTIVE_STATUSES.has(job.status) && !TERMINAL_STATUSES.has(job.status)) {
          job.status = 'queued';
        }
      });
      console.log(`[mint-queue] Restored ${this.jobs.length} in-flight job(s)`);
    } catch (err) {
      console.warn('[mint-queue] Could not load queue:', err.message);
    }
  }

  _saveSoon() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 400);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        savedAt: nowIso(),
        jobs: this.jobs,
        history: this.history.slice(0, 200)
      }), 'utf8');
    } catch (err) {
      console.warn('[mint-queue] Could not save queue:', err.message);
    }
  }

  /* ---- lifecycle ---- */

  start() {
    this.load();
    this._ready = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this.tick(), this.pollMs);
    if (this._timer.unref) this._timer.unref();
    setTimeout(() => this.tick(), 250).unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._saveNow();
  }

  /* ---- API ---- */

  enqueue({
    type,
    username,
    plotId = null,
    assetId = null,
    steps = [],
    snapshot = null,
    meta = {},
    requiredConfirmations = CONFIG.CHAIN.CONFIRMATIONS
  }) {
    if (!type) throw new Error('Job type is required');
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('Job must have at least one step');

    const job = {
      id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      username: username || null,
      plotId,
      assetId,
      status: 'queued',
      requiredConfirmations: Number(requiredConfirmations) || CONFIG.CHAIN.CONFIRMATIONS,
      steps: steps.map((s, i) => ({
        key: s.key || `step_${i + 1}`,
        label: s.label || s.key || `Step ${i + 1}`,
        operation: s.operation,
        compensate: s.compensate || null,
        compensation: !!s.compensation,
        status: 'pending',
        txHash: null,
        submittedHeight: null,
        submittedAt: null,
        confirmedHeight: null,
        confirmations: 0,
        attempts: 0,
        error: null
      })),
      snapshot,
      meta,
      failure: null,
      handlerFired: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null
    };

    this.jobs.push(job);
    this._saveSoon();
    setTimeout(() => this.tick(), 0).unref?.();
    return job;
  }

  getJob(id) {
    return this.jobs.find(j => j.id === id) || this.history.find(j => j.id === id) || null;
  }

  getJobForPlot(plotId) {
    return this.jobs.find(j => j.plotId === plotId && ACTIVE_STATUSES.has(j.status)) || null;
  }

  getJobsFor(username, limit = 25) {
    const key = String(username || '').toLowerCase();
    return [...this.jobs, ...this.history]
      .filter(j => String(j.username || '').toLowerCase() === key)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  listActive() {
    return this.jobs.filter(j => ACTIVE_STATUSES.has(j.status));
  }

  /* ---- processing ---- */

  async tick() {
    if (this._busy || !this.adapter || !this._ready) return this.summary();
    this._busy = true;
    try {
      for (const job of [...this.jobs]) {
        if (!ACTIVE_STATUSES.has(job.status)) continue;
        await this._advance(job);
      }
    } catch (err) {
      console.warn('[mint-queue] Tick error:', err.message);
    } finally {
      this._busy = false;
      this._saveSoon();
      this._purge();
    }
    return this.summary();
  }

  async _advance(job) {
    const height = await this._safeHeight();

    for (const step of job.steps) {
      if (step.status === 'confirmed' || step.status === 'failed' || step.status === 'skipped') continue;

      // Never run ordinary steps once the job is rolling back, and never run a
      // later step when an earlier one has already failed.
      if (!step.compensation && job.status === 'reverting') continue;
      if (!step.compensation && job.steps.some(s => !s.compensation && s.status === 'failed')) continue;

      if (step.status === 'pending') {
        try {
          const result = await this.adapter.execute(step.operation);
          step.status = 'submitted';
          step.txHash = result.txHash;
          step.submittedHeight = result.acceptedAtHeight ?? height;
          step.submittedAt = nowIso();
          step.attempts += 1;
          step.error = null;
          if (!step.compensation) job.status = 'confirming';
          job.updatedAt = nowIso();
        } catch (err) {
          step.status = 'failed';
          step.error = err.message;
          await this._handleFailure(job, err.message);
          return;
        }
        this._saveSoon();
        return; // one operation per tick keeps nonces and ordering sane
      }

      if (step.status === 'submitted') {
        const status = await this.adapter.getTxStatus(step.txHash);
        step.confirmations = status.confirmations || 0;

        if (status.status === 'confirmed') {
          if (step.confirmations >= job.requiredConfirmations) {
            step.status = 'confirmed';
            step.confirmedHeight = status.includedHeight ?? height;
            step.confirmations = job.requiredConfirmations;
            job.updatedAt = nowIso();
          }
          this._saveSoon();
          return; // wait for the next tick to continue the chain
        }

        if (status.status === 'failed' || status.status === 'dropped') {
          step.status = 'failed';
          step.error = status.error ||
            (status.status === 'dropped'
              ? 'Transaction was dropped from the mempool'
              : 'Transaction failed on-chain');
          await this._handleFailure(job, step.error);
          return;
        }

        const submittedAt = Date.parse(step.submittedAt || '');
        if (submittedAt && Date.now() - submittedAt > this.timeoutMs) {
          step.status = 'failed';
          step.error = `Timed out waiting for confirmations (${step.confirmations}/${job.requiredConfirmations})`;
          await this._handleFailure(job, step.error);
          return;
        }

        this._saveSoon();
        return;
      }
    }

    // No runnable step remains.
    if (job.status === 'reverting') {
      this._finaliseRevert(job);
      return;
    }

    const allConfirmed = job.steps.every(s => s.status === 'confirmed' || s.status === 'skipped');
    if (allConfirmed) {
      job.status = 'confirmed';
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
      this._fire('onConfirmed', job);
      return;
    }

    const failed = job.steps.find(s => s.status === 'failed');
    if (failed) {
      await this._handleFailure(job, failed.error || 'Step failed');
      return;
    }

    job.status = 'confirming';
  }

  async _handleFailure(job, reason) {
    // Idempotent: a job already rolling back must not queue more reversals.
    if (job.status === 'reverting' || job.status === 'revert_failed') return;

    job.failure = reason;
    const reversible = job.steps.filter(s => s.status === 'confirmed' && !s.compensation && s.compensate);

    if (reversible.length === 0) {
      job.status = 'failed';
      job.completedAt = nowIso();
      job.updatedAt = job.completedAt;
      this._fire('onReverted', job);
      return;
    }

    // Undo confirmed effects in reverse order via compensating transactions.
    const compensations = reversible.reverse().map((s, i) => ({
      key: `revert_${i + 1}_${s.key}`,
      label: `Revert: ${s.label}`,
      operation: s.compensate,
      compensate: null,
      compensation: true,
      status: 'pending',
      txHash: null,
      submittedHeight: null,
      submittedAt: null,
      confirmedHeight: null,
      confirmations: 0,
      attempts: 0,
      error: null
    }));

    job.steps.push(...compensations);
    job.status = 'reverting';
    job.updatedAt = nowIso();
    console.log(`[mint-queue] ${job.id} failed (${reason}); submitted ${compensations.length} reversal step(s)`);
    this._saveSoon();
  }

  _finaliseRevert(job) {
    const compensationFailed = job.steps.some(s => s.compensation && s.status === 'failed');
    job.status = compensationFailed ? 'revert_failed' : 'reverted';
    job.completedAt = nowIso();
    job.updatedAt = job.completedAt;
    this._fire('onReverted', job);
  }

  _fire(name, job) {
    if (job.handlerFired) return;
    job.handlerFired = true;
    const handler = this.handlers[name];
    if (typeof handler !== 'function') return;
    try {
      handler(job);
    } catch (err) {
      console.error(`[mint-queue] ${name} handler failed for ${job.id}:`, err.message);
    }
  }

  async _safeHeight() {
    try {
      return await this.adapter.getHeight();
    } catch {
      return 0;
    }
  }

  _purge() {
    const keep = [];
    for (const job of this.jobs) {
      if (ACTIVE_STATUSES.has(job.status)) {
        keep.push(job);
      } else {
        this.history.unshift(job);
      }
    }
    this.jobs = keep;
    this.history = this.history.slice(0, 200);
  }

  /* ---- views ---- */

  publicJob(job) {
    if (!job) return null;
    const counted = job.steps.filter(s => !s.compensation);
    const confirmed = counted.filter(s => s.status === 'confirmed').length;
    const total = counted.length || 1;

    return {
      id: job.id,
      type: job.type,
      status: job.status,
      plotId: job.plotId,
      username: job.username,
      assetId: job.assetId,
      requiredConfirmations: job.requiredConfirmations,
      confirmations: counted.reduce((min, s) => Math.min(min, s.confirmations || 0), Infinity) === Infinity
        ? 0
        : counted.reduce((min, s) => Math.min(min, s.confirmations || 0), Infinity),
      confirmedSteps: confirmed,
      totalSteps: total,
      progress: Math.round((confirmed / total) * 100),
      failure: job.failure,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      steps: job.steps.map((s, i) => ({
        index: i + 1,
        key: s.key,
        label: s.label,
        status: s.status,
        txHash: s.txHash,
        confirmations: s.confirmations || 0,
        error: s.error,
        compensation: !!s.compensation
      }))
    };
  }

  summary() {
    return {
      active: this.jobs.filter(j => ACTIVE_STATUSES.has(j.status)).length,
      confirmed: this.history.filter(j => j.status === 'confirmed').length,
      reverted: this.history.filter(j => j.status === 'reverted' || j.status === 'revert_failed' || j.status === 'failed').length,
      confirmationsRequired: CONFIG.CHAIN.CONFIRMATIONS
    };
  }
}

export const mintQueue = new MintQueue({ adapter: null });
export { MintQueue };
