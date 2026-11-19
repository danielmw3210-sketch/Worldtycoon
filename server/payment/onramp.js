import { CONFIG } from '../config.js';

/**
 * Fiat on-ramp quote/order bookkeeping.
 *
 * Completion does NOT invent a transaction hash. The purchase is credited to a
 * game username through gameStore.creditExternal, which mints NUM as a real
 * chain asset job (10 confirmations). The returned deliveryTxHash is filled in
 * by the queue once the mint is confirmed, never before.
 */
class CryptoOnrampManager {
  constructor() {
    this.orders = [];
    this.rates = {
      GBP: CONFIG.ECONOMY.EXCHANGE_RATE_GBP,
      EUR: 0.52,
      USD: CONFIG.ECONOMY.EXCHANGE_RATE_USDT,
      XMR: CONFIG.ECONOMY.EXCHANGE_RATE_XMR,
      USDT: CONFIG.ECONOMY.EXCHANGE_RATE_USDT
    };
  }

  calculateQuote({ currency, fiatAmount, numAmount }) {
    const rate = this.rates[currency] || this.rates.GBP;
    if (numAmount) {
      return { numAmount, payAmount: +(numAmount * rate).toFixed(2), currency, rate };
    }
    return { numAmount: +(fiatAmount / rate).toFixed(2), payAmount: fiatAmount, currency, rate };
  }

  createOrder({ currency, amount, paymentMethod, username }) {
    const isCrypto = ['crypto_swap', 'crypto'].includes(paymentMethod);
    const quote = this.calculateQuote({
      currency,
      fiatAmount: isCrypto ? null : amount,
      numAmount: isCrypto ? +(amount / (this.rates[currency] || 1)).toFixed(2) : null
    });

    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 1000);

    // Deposit addresses are operator-supplied; never fabricate them.
    const cryptoAddresses = {
      XMR: process.env.NUMISTA_ONRAMP_XMR_ADDRESS || null,
      USDT: process.env.NUMISTA_ONRAMP_USDT_ADDRESS || null,
      BTC: process.env.NUMISTA_ONRAMP_BTC_ADDRESS || null
    };

    const order = {
      orderId,
      username: username || null,
      currency,
      payAmount: quote.payAmount,
      numAmount: quote.numAmount,
      paymentMethod,
      depositAddress: cryptoAddresses[currency] || null,
      status: 'pending',
      deliveryTxHash: null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString()
    };

    this.orders.unshift(order);
    return order;
  }

  completeOrder(orderId) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) throw new Error('Order not found');
    if (order.status === 'completed') throw new Error('Order already completed');

    order.status = 'completed';
    order.completedAt = new Date().toISOString();
    // deliveryTxHash stays null until the mint job confirms on chain.
    return order;
  }

  attachDeliveryTx(orderId, txHash) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (order && txHash) order.deliveryTxHash = txHash;
  }

  getOrders() {
    return this.orders.slice(0, 20);
  }
}

export const cryptoOnramp = new CryptoOnrampManager();
