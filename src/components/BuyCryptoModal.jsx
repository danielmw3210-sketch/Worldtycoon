import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { 
  CreditCard, 
  Coins, 
  ArrowRight, 
  CheckCircle2, 
  QrCode, 
  Copy, 
  ExternalLink, 
  ShieldCheck, 
  Clock, 
  Sparkles 
} from 'lucide-react';

export default function BuyCryptoModal() {
  const { user, setActiveModal, refreshWallet, addToast } = useGame();

  const [currency, setCurrency] = useState('GBP'); // 'GBP' | 'EUR' | 'USD' | 'XMR' | 'USDT'
  const [payAmount, setPayAmount] = useState('50');
  const [quote, setQuote] = useState({ numAmount: 111.11, payAmount: 50, rate: 0.45 });
  const [order, setOrder] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Calculate quote when amount or currency changes
  useEffect(() => {
    const fetchQuote = async () => {
      const val = parseFloat(payAmount) || 0;
      if (val <= 0) return;

      try {
        const res = await fetch('/api/onramp/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency, fiatAmount: val })
        });
        if (res.ok) {
          const data = await res.json();
          setQuote(data);
        }
      } catch (err) {
        console.error(err);
      }
    };

    fetchQuote();
  }, [payAmount, currency]);

  // Create purchase order
  const handleCreateOrder = async () => {
    try {
      setProcessing(true);
      const res = await fetch('/api/onramp/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currency,
          amount: parseFloat(payAmount),
          paymentMethod: ['GBP', 'EUR', 'USD'].includes(currency) ? 'card' : 'crypto_swap',
          username: user?.username
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setOrder(data);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setProcessing(false);
    }
  };

  // Complete / Confirm payment
  const handleConfirmPayment = async () => {
    if (!order) return;
    try {
      setProcessing(true);
      const res = await fetch('/api/onramp/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: order.orderId, username: user?.username })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`Payment confirmed. ${order.numAmount} NUM is minting on-chain (10 confirmations).`, 'success');
      await refreshWallet();
      setOrder(null);
      setActiveModal(null);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setProcessing(false);
    }
  };

  const copyDeposit = (addr) => {
    navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-emerald-500/40 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-emerald-950/60 via-slate-900 to-[#161d2a] border-b border-emerald-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-white shadow-lg shadow-emerald-500/30 border border-emerald-200">
              <CreditCard className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-emerald-400 bg-emerald-950 border border-emerald-700/60 px-2 py-0.5 rounded">
                  Official Numista Onramp & Swap
                </span>
                <span className="text-xs text-slate-400 font-mono">Instant Delivery</span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1">Buy Numista Coin (NUM)</h2>
            </div>
          </div>
          <button
            onClick={() => setActiveModal(null)}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">

          {!order ? (
            /* Purchase Step 1: Calculator */
            <div className="space-y-5">
              
              {/* Currency Selector */}
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono block mb-2">
                  Select Payment Currency:
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {[
                    { id: 'GBP', label: '£ GBP', desc: 'Card / UK Faster Pay' },
                    { id: 'EUR', label: '€ EUR', desc: 'SEPA / Card' },
                    { id: 'USD', label: '$ USD', desc: 'Card / ACH' },
                    { id: 'XMR', label: 'XMR', desc: 'Monero Swap' },
                    { id: 'USDT', label: 'USDT', desc: 'Tether TRC20' },
                  ].map(c => (
                    <button
                      key={c.id}
                      onClick={() => setCurrency(c.id)}
                      className={`p-2.5 rounded-xl border text-center transition-all ${
                        currency === c.id
                          ? 'bg-emerald-600/30 border-emerald-500 text-white font-bold shadow-md shadow-emerald-950'
                          : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      <div className="text-xs font-bold font-mono">{c.label}</div>
                      <div className="text-[9px] text-slate-500 truncate">{c.id}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Conversion Calculator Box */}
              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
                
                {/* You Pay Input */}
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1.5 font-mono">
                    <span>You Pay:</span>
                    <span>1 NUM ≈ {quote.rate} {currency}</span>
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-xl font-mono text-white focus:outline-none focus:border-emerald-500"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 font-mono font-bold text-slate-400 text-sm">
                      {currency}
                    </span>
                  </div>
                </div>

                {/* Quick Presets */}
                <div className="flex space-x-2">
                  {['20', '50', '100', '250'].map(amt => (
                    <button
                      key={amt}
                      onClick={() => setPayAmount(amt)}
                      className="flex-1 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-300 transition-colors"
                    >
                      {currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : ''}{amt}
                    </button>
                  ))}
                </div>

                {/* Arrow Divider */}
                <div className="flex items-center justify-center">
                  <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-emerald-400 border border-slate-700">
                    <ArrowRight className="w-4 h-4 rotate-90" />
                  </div>
                </div>

                {/* You Receive Output */}
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1.5 font-mono">
                    <span>You Receive (Estimated):</span>
                    <span className="text-emerald-400 font-semibold">Zero Slippage</span>
                  </div>
                  <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-700 flex items-center justify-between">
                    <span className="text-2xl font-black font-mono text-emerald-300">
                      {quote.numAmount}
                    </span>
                    <span className="font-mono font-extrabold text-orange-400">
                      NUM
                    </span>
                  </div>
                </div>

              </div>

              {/* Delivery account */}
              <div className="p-3 rounded-xl bg-slate-900/50 border border-slate-800 flex items-center justify-between text-xs">
                <span className="text-slate-400">Credited to account:</span>
                <span className="font-mono text-slate-200">@{user?.username || 'guest'}</span>
              </div>

              {/* Action Button */}
              <button
                disabled
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white font-bold text-sm shadow-xl shadow-emerald-700/20 transition-all flex items-center justify-center space-x-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>Purchases unavailable — payment provider not configured</span>
              </button>
              <p className="text-center text-[11px] text-slate-400">
                Use the receive address in Wallet for blockchain deposits. Native coin deposits do not automatically become in-game NUM.
              </p>

            </div>
          ) : (
            /* Purchase Step 2: Payment Gateway / Confirmation */
            <div className="space-y-5 animate-fadeIn">
              
              <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold block">
                    Invoice Created • Order #{order.orderId}
                  </span>
                  <div className="text-lg font-black text-white font-mono mt-0.5">
                    Pay {order.payAmount} {order.currency}
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] text-slate-400 font-mono block">Delivery Amount</span>
                  <span className="text-lg font-black text-orange-400 font-mono">
                    +{order.numAmount} NUM
                  </span>
                </div>
              </div>

              {/* Deposit Address for Crypto or Card Simulator */}
              {order.depositAddress ? (
                <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 text-center space-y-3">
                  <div className="w-16 h-16 rounded-xl bg-slate-800 border border-slate-700 mx-auto flex items-center justify-center text-emerald-400">
                    <QrCode className="w-10 h-10" />
                  </div>
                  <div className="text-xs text-slate-300">
                    Send exactly <span className="font-bold text-white font-mono">{order.payAmount} {order.currency}</span> to the bridge address:
                  </div>
                  <div className="p-2.5 rounded-lg bg-black/60 border border-slate-800 font-mono text-[11px] text-slate-300 break-all select-all flex items-center justify-between">
                    <span className="truncate pr-2">{order.depositAddress}</span>
                    <button
                      onClick={() => copyDeposit(order.depositAddress)}
                      className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {copied && <span className="text-xs text-emerald-400 font-mono">Copied to clipboard!</span>}
                </div>
              ) : (
                <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3 text-xs">
                  <div className="flex items-center space-x-2 text-slate-300 font-bold">
                    <CreditCard className="w-4 h-4 text-emerald-400" />
                    <span>Instant Debit/Credit Card or Apple Pay</span>
                  </div>
                  <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 font-mono text-slate-400 flex items-center justify-between">
                    <span>•••• •••• •••• 4242</span>
                    <span className="text-emerald-400 font-bold">VISA / MC</span>
                  </div>
                </div>
              )}

              {/* Complete Order Simulator Button */}
              <div className="space-y-2">
                <button
                  onClick={handleConfirmPayment}
                  disabled={processing}
                  className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold text-sm shadow-xl shadow-emerald-700/20 transition-all flex items-center justify-center space-x-2"
                >
                  <CheckCircle2 className="w-5 h-5" />
                  <span>{processing ? 'Processing Payment & Minting...' : 'Authorize Payment & Receive NUM'}</span>
                </button>
                <button
                  onClick={() => setOrder(null)}
                  className="w-full py-2 text-xs text-slate-400 hover:text-white transition-colors"
                >
                  Cancel / Modify Amount
                </button>
              </div>

            </div>
          )}

        </div>

      </div>
    </div>
  );
}
