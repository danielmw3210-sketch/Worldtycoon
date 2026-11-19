import { CONFIG } from '../config.js';

class CryptoOnrampManager {
  constructor() {
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
}

export const cryptoOnramp = new CryptoOnrampManager();
