import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ORDERS_FILE = path.join(__dirname, '..', 'data', 'stripeOrders.json');
const SIGNATURE_TOLERANCE_SECONDS = 300;

function cleanAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export class StripeOnramp {
  constructor({ file = process.env.NUMISTA_ONRAMP_ORDERS_FILE || DEFAULT_ORDERS_FILE } = {}) {
    this.file = file;
    this.state = { orders: {}, processedEvents: [] };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state.orders = saved.orders && typeof saved.orders === 'object' ? saved.orders : {};
      this.state.processedEvents = Array.isArray(saved.processedEvents) ? saved.processedEvents : [];
      for (const order of Object.values(this.state.orders)) {
        if (order.status === 'wallet_payout_submitting') {
          order.status = 'manual_review';
          order.failure = 'Wallet payout outcome is uncertain after restart; reconcile the wallet before retrying.';
        }
      }
    } catch (err) {
      console.error(`[onramp] Could not load order state: ${err.message}`);
    }
  }

  save() {
    const tempFile = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tempFile, this.file);
  }

  get mode() {
    const key = String(process.env.STRIPE_SECRET_KEY || '');
    if (!key || !process.env.STRIPE_WEBHOOK_SECRET) return null;
    if (key.startsWith('sk_test_') && process.env.NUMISTA_ONRAMP_TEST_ENABLED === '1') return 'test';
    const mainnetReady = CONFIG.NUMISTA.NETTYPE === 'numista-mainnet' &&
      process.env.NUMISTA_ONRAMP_MAINNET_READY === '1' &&
      CONFIG.NUMISTA.NETTYPE === 'numista-mainnet' &&
      CONFIG.CHAIN.MODE === 'live';
    if (key.startsWith('sk_live_') &&
        process.env.NUMISTA_ONRAMP_LIVE_ENABLED === '1' &&
        mainnetReady) return 'live';
    return null;
  }

  getUnavailableReason() {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
      return 'Stripe secret and webhook signing secrets are not configured on the server';
    }
    if (String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live_')) {
      return 'Live checkout requires the live switch, a live chain connection, and explicit mainnet readiness';
    }
    if (String(process.env.STRIPE_SECRET_KEY).startsWith('sk_test_')) {
      return 'Sandbox checkout is disabled until NUMISTA_ONRAMP_TEST_ENABLED is set';
    }
    return 'A valid Stripe secret key is not configured';
  }

  verifyWebhook(rawBody, signatureHeader, now = Date.now()) {
    const secret = String(process.env.STRIPE_WEBHOOK_SECRET || '');
    if (!secret) throw new Error('Stripe webhook secret is not configured');
    if (!Buffer.isBuffer(rawBody)) throw new Error('Webhook body must be raw bytes');
    const parts = String(signatureHeader || '').split(',').map(part => part.split('=', 2));
    const timestamp = parts.find(([key]) => key === 't')?.[1];
    const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
    const timestampNumber = Number(timestamp);
    if (!timestamp || !Number.isInteger(timestampNumber) ||
        Math.abs(Math.floor(now / 1000) - timestampNumber) > SIGNATURE_TOLERANCE_SECONDS) {
      throw new Error('Invalid or expired Stripe webhook timestamp');
    }
    const expected = crypto.createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');
    if (!signatures.some(signature => safeEqualHex(expected, signature))) {
      throw new Error('Invalid Stripe webhook signature');
    }
    return JSON.parse(rawBody.toString('utf8'));
  }

  async createCheckout({
    username,
    amountGBP,
    destination,
    walletAddress,
    gameTreasuryAvailable = 0,
    nativeTreasuryAvailable = 0
  }) {
    if (!this.mode) throw new Error(this.getUnavailableReason());
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const amountPence = cleanAmount(amountGBP);
    const minPence = cleanAmount(process.env.NUMISTA_ONRAMP_MIN_GBP || 1);
    const maxPence = cleanAmount(process.env.NUMISTA_ONRAMP_MAX_GBP || 250);
    if (amountPence < minPence || amountPence > maxPence) {
      throw new Error(`Purchase amount must be between £${(minPence / 100).toFixed(2)} and £${(maxPence / 100).toFixed(2)}`);
    }
    if (!['game_balance', 'native_wallet'].includes(destination)) {
      throw new Error('Choose a supported NUM delivery destination');
    }
    if (destination === 'native_wallet' && !walletAddress) {
      throw new Error('A mainnet wallet address is required for wallet delivery');
    }
    const numAmount = +((amountPence / 100) / CONFIG.ECONOMY.EXCHANGE_RATE_GBP).toFixed(4);
    if (!(numAmount > 0) || !Number.isFinite(numAmount)) throw new Error('Could not calculate the NUM purchase amount');
    const outstandingReservations = Object.values(this.state.orders)
      .filter(order => order.destination === destination && order.reserveInventory)
      .reduce((sum, order) => sum + Number(order.numAmount || 0), 0);
    const availableInventory = destination === 'game_balance'
      ? Number(gameTreasuryAvailable)
      : Number(nativeTreasuryAvailable);
    if (!Number.isFinite(availableInventory) || availableInventory < 0 ||
        availableInventory - outstandingReservations < numAmount) {
      throw new Error('Treasury does not have enough unreserved NUM inventory for this order');
    }
    const baseUrl = String(process.env.STRIPE_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    let parsedBaseUrl;
    try { parsedBaseUrl = new URL(baseUrl); } catch { throw new Error('STRIPE_PUBLIC_BASE_URL must be an absolute HTTPS URL'); }
    if (parsedBaseUrl.protocol !== 'https:' && !(this.mode === 'test' && parsedBaseUrl.hostname === 'localhost')) {
      throw new Error('Stripe checkout requires an HTTPS public base URL');
    }

    const orderId = crypto.randomUUID();
    const order = {
      id: orderId,
      username: String(username).toLowerCase(),
      amountPence,
      currency: 'gbp',
      numAmount,
      destination,
      walletAddress: destination === 'native_wallet' ? walletAddress : null,
      mode: this.mode,
      status: 'creating_checkout',
      createdAt: new Date().toISOString(),
      checkoutSessionId: null,
      paymentIntentId: null,
      fulfillmentJobId: null,
      txHash: null,
      failure: null,
      reserveInventory: true
    };
    this.state.orders[orderId] = order;
    this.save();

    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('payment_method_types[0]', 'card');
    form.set('line_items[0][price_data][currency]', 'gbp');
    form.set('line_items[0][price_data][unit_amount]', String(amountPence));
    form.set('line_items[0][price_data][product_data][name]', `${numAmount} NUM`);
    form.set('line_items[0][quantity]', '1');
    form.set('client_reference_id', orderId);
    form.set('metadata[order_id]', orderId);
    form.set('payment_intent_data[metadata][order_id]', orderId);
    form.set('success_url', `${baseUrl}/?onramp=success&session_id={CHECKOUT_SESSION_ID}`);
    form.set('cancel_url', `${baseUrl}/?onramp=cancelled`);

    try {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `worldtycoon-checkout-${orderId}`
        },
        body: form
      });
      const data = await response.json();
      if (!response.ok || !data.id || !data.url) {
        order.status = 'checkout_failed';
        order.failure = 'Stripe could not create the hosted checkout session';
        order.reserveInventory = false;
        this.save();
        throw new Error(order.failure);
      }
      order.checkoutSessionId = data.id;
      order.status = 'checkout_open';
      this.save();
      return {
        orderId,
        checkoutUrl: data.url,
        numAmount,
        amountGBP: amountPence / 100,
        destination
      };
    } catch (err) {
      if (order.status === 'creating_checkout') {
        order.status = 'checkout_failed';
        order.failure = 'Stripe checkout request failed';
        order.reserveInventory = false;
        this.save();
      }
      throw new Error(order.failure || 'Stripe checkout is temporarily unavailable');
    }
  }

  getOrder(orderId) {
    return this.state.orders[orderId] || null;
  }

  getOrderBySession(sessionId) {
    return Object.values(this.state.orders).find(order => order.checkoutSessionId === sessionId) || null;
  }

  async findOrderForPaymentIntent(paymentIntentId) {
    const existing = Object.values(this.state.orders).find(order => order.paymentIntentId === paymentIntentId);
    if (existing || !paymentIntentId || !process.env.STRIPE_SECRET_KEY) return existing || null;
    const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
    });
    const paymentIntent = await response.json();
    if (!response.ok) throw new Error('Could not reconcile Stripe payment intent metadata');
    const order = this.getOrder(paymentIntent.metadata?.order_id);
    if (order) {
      order.paymentIntentId = paymentIntent.id;
      this.save();
    }
    return order;
  }

  async handleEvent(event, { gameStore, numistaRpc, mintQueue }) {
    if (!event?.id || !event?.type || !event?.data?.object) throw new Error('Malformed Stripe event');
    if (this.state.processedEvents.includes(event.id)) return { duplicate: true };

    const object = event.data.object;
    if (event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded') {
      const orderId = object.metadata?.order_id;
      const order = this.getOrder(orderId);
      if (!order) throw new Error('Checkout session does not match an order');
      if (object.id !== order.checkoutSessionId || object.client_reference_id !== order.id ||
          Number(object.amount_total) !== order.amountPence || object.currency !== order.currency) {
        throw new Error('Stripe checkout details do not match the recorded order');
      }
      if (object.payment_status === 'paid') {
        order.paymentIntentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id || null;
        if (!['fulfilled', 'fulfillment_pending', 'manual_review'].includes(order.status)) {
          order.status = 'paid_unfulfilled';
          order.paidAt = new Date().toISOString();
          this.save();
          await this.fulfillPaidOrder(order, { gameStore, numistaRpc, mintQueue });
        }
      }
    } else if (event.type === 'checkout.session.expired') {
      const order = this.getOrder(object.metadata?.order_id);
      if (order && order.checkoutSessionId === object.id && order.status === 'checkout_open') {
        order.status = 'expired';
        order.reserveInventory = false;
        this.save();
      }
    } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const paymentIntentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
      const order = await this.findOrderForPaymentIntent(paymentIntentId);
      if (order) {
        order.status = 'manual_review';
        order.failure = event.type === 'charge.refunded'
          ? 'Payment was refunded; reconcile the already-issued NUM before further action.'
          : 'Payment dispute opened; review the payout and dispute before further action.';
        this.save();
      }
    }

    this.state.processedEvents.push(event.id);
    this.state.processedEvents = this.state.processedEvents.slice(-5000);
    this.save();
    return { received: true };
  }

  async fulfillPaidOrder(order, { gameStore, numistaRpc, mintQueue }) {
    if (!order || order.status !== 'paid_unfulfilled') return;
    if (order.destination === 'game_balance') {
      const existing = [...mintQueue.jobs, ...mintQueue.history].find(job =>
        job.idempotencyKey === `stripe-onramp-${order.id}`);
      if (existing) {
        order.fulfillmentJobId = existing.id;
        order.status = existing.status === 'confirmed' ? 'fulfilled'
          : ['failed', 'reverted', 'revert_failed'].includes(existing.status) ? 'manual_review'
            : 'fulfillment_pending';
        order.reserveInventory = order.status === 'manual_review';
        if (order.status === 'fulfilled') order.fulfilledAt ||= new Date().toISOString();
        if (order.status === 'manual_review') order.failure = existing.failure || 'NUM transfer failed; manual review required.';
        this.save();
        return;
      }
      try {
        order.reserveInventory = false;
        this.save();
        const job = gameStore._enqueueNumTransfer({
          type: 'onramp_purchase',
          from: CONFIG.CHAIN.TREASURY_USERNAME,
          to: order.username,
          amount: order.numAmount,
          description: `Stripe purchase ${order.id}`,
          snapshot: { paymentOrderId: order.id },
          idempotencyKey: `stripe-onramp-${order.id}`
        });
        order.fulfillmentJobId = job.id;
        order.status = 'fulfillment_pending';
        order.reserveInventory = false;
        this.save();
      } catch (err) {
        order.status = 'paid_unfulfilled';
        order.failure = 'Payment succeeded, but treasury NUM is not currently available for delivery.';
        order.reserveInventory = true;
        this.save();
        console.error(`[onramp] Fulfillment ${order.id} deferred: ${err.message}`);
      }
      return;
    }

    if (order.destination === 'native_wallet') {
      if (order.mode !== 'live' || !order.walletAddress) {
        order.status = 'manual_review';
        order.failure = 'Native wallet delivery is only available after mainnet is verified.';
        this.save();
        return;
      }
      order.status = 'wallet_payout_submitting';
      this.save();
      try {
        const payout = await numistaRpc.sendTransfer({
          toAddress: order.walletAddress,
          amountNum: order.numAmount
        });
        order.txHash = payout.txHash || null;
        order.status = 'fulfilled';
        order.reserveInventory = false;
        order.fulfilledAt = new Date().toISOString();
        order.failure = null;
        this.save();
      } catch (err) {
        order.status = 'manual_review';
        order.failure = 'Wallet payout outcome requires reconciliation before retry.';
        this.save();
        console.error(`[onramp] Wallet payout ${order.id} requires reconciliation: ${err.message}`);
      }
    }
  }

  async reconcile({ gameStore, numistaRpc, mintQueue }) {
    for (const order of Object.values(this.state.orders)) {
      if (order.status === 'paid_unfulfilled') {
        await this.fulfillPaidOrder(order, { gameStore, numistaRpc, mintQueue });
        continue;
      }
      if (order.status !== 'fulfillment_pending' || !order.fulfillmentJobId) continue;
      const job = mintQueue.getJob(order.fulfillmentJobId);
      if (!job) continue;
      if (job.status === 'confirmed') {
        order.status = 'fulfilled';
        order.fulfilledAt = new Date().toISOString();
        order.failure = null;
        this.save();
      } else if (['failed', 'reverted', 'revert_failed'].includes(job.status)) {
        order.status = 'manual_review';
        order.reserveInventory = true;
        order.failure = 'NUM transfer did not settle; review the chain job before retrying.';
        this.save();
      }
    }
  }

  publicOrder(order) {
    if (!order) return null;
    return {
      id: order.id,
      amountGBP: order.amountPence / 100,
      numAmount: order.numAmount,
      destination: order.destination,
      status: order.status,
      createdAt: order.createdAt,
      paidAt: order.paidAt || null,
      fulfilledAt: order.fulfilledAt || null,
      txHash: order.txHash || null,
      failure: order.failure || null
    };
  }

  adminSummary() {
    const orders = Object.values(this.state.orders || {});
    const paid = orders.filter(order =>
      ['fulfilled', 'wallet_payout_submitted', 'manual_review'].includes(order.status) ||
      Boolean(order.paidAt) || Boolean(order.fulfilledAt));
    return {
      orderCount: orders.length,
      paidOrderCount: paid.length,
      numPurchased: paid.reduce((sum, order) => sum + Math.max(0, Number(order.numAmount) || 0), 0),
      gbpPaid: paid.reduce((sum, order) => sum + Math.max(0, Number(order.amountPence) || 0) / 100, 0)
    };
  }
}

export const stripeOnramp = new StripeOnramp();
