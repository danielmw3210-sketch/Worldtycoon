import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { 
  CreditCard,
  ArrowRight,
  Sparkles
} from 'lucide-react';

export default function BuyCryptoModal() {
  const { user, setActiveModal, refreshWallet, addToast } = useGame();

  const [payAmount, setPayAmount] = useState('10');
  const [quote, setQuote] = useState({ numAmount: 400, payAmount: 10, rate: 0.025 });
  const [order, setOrder] = useState(null);
  const [destination, setDestination] = useState('game_balance');
  const [walletAddress, setWalletAddress] = useState('');
  const [processing, setProcessing] = useState(false);
  const sessionId = new URLSearchParams(window.location.search).get('session_id');

  useEffect(() => {
    if (!sessionId || !user?.token) return undefined;
    let active = true;
    let timer;
    const refreshOrder = async () => {
      try {
        const res = await fetch(`/api/onramp/orders/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${user.token}` }
        });
        const data = await res.json();
        if (active && res.ok) {
          setOrder(data.order);
          if (data.order.status === 'fulfilled') {
            if (timer) clearInterval(timer);
            await refreshWallet();
          }
        }
      } catch (err) {
        if (active) addToast(err.message, 'error');
      }
    };
    timer = setInterval(refreshOrder, 5000);
    refreshOrder();
    return () => { active = false; clearInterval(timer); };
  }, [sessionId, user?.token, refreshWallet, addToast]);

  // Calculate quote when amount or currency changes
  useEffect(() => {
    const fetchQuote = async () => {
      const val = parseFloat(payAmount) || 0;
      if (val <= 0) return;

      try {
        const res = await fetch('/api/onramp/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency: 'GBP', fiatAmount: val })
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
  }, [payAmount]);

  // Create purchase order
  const handleCreateOrder = async () => {
    try {
      setProcessing(true);
      const res = await fetch('/api/onramp/order', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user?.token || ''}`
        },
        body: JSON.stringify({ amount: parseFloat(payAmount), destination, walletAddress })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      window.location.assign(data.checkoutUrl);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setProcessing(false);
    }
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

          {order ? (
            <div className="space-y-4 animate-fadeIn">
              <div className="p-4 rounded-xl bg-slate-900 border border-slate-800">
                <div className="text-sm font-bold text-white">Payment status: {order.status.replaceAll('_', ' ')}</div>
                <div className="mt-2 text-xs text-slate-300">
                  £{Number(order.amountGBP).toFixed(2)} · {Number(order.numAmount).toFixed(4)} NUM · {order.destination === 'native_wallet' ? 'Mainnet wallet' : 'Worldtycoon balance'}
                </div>
                {order.txHash && <div className="mt-2 text-xs font-mono text-slate-400 break-all">Transaction: {order.txHash}</div>}
                {order.failure && <div className="mt-2 text-xs text-amber-300">{order.failure}</div>}
              </div>
              <p className="text-xs text-slate-400">
                Payment confirmation and NUM delivery are verified separately. Do not retry a completed card payment; contact support if delivery needs review.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 font-mono mb-2">Pay with</label>
                  <div className="rounded-xl border border-emerald-500 bg-emerald-600/20 p-3 text-sm font-bold text-white">GBP (£) · Stripe Checkout</div>
                </div>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 font-mono mb-2">Amount in GBP</label>
                  <input
                    type="number"
                    min="1"
                    max="250"
                    step="0.01"
                    value={payAmount}
                    onChange={event => setPayAmount(event.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-xl font-mono text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="flex items-center justify-center text-emerald-400">
                  <ArrowRight className="w-4 h-4 rotate-90" />
                </div>
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-700 flex items-center justify-between">
                  <span className="text-2xl font-black font-mono text-emerald-300">{Number(quote.numAmount || 0).toFixed(4)}</span>
                  <span className="font-mono font-extrabold text-orange-400">NUM</span>
                </div>
                <p className="text-xs text-slate-400">Rate: £{quote.rate} per NUM. Final amount is fixed when checkout is created.</p>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-400 font-mono mb-2">Deliver NUM to</label>
                <select
                  value={destination}
                  onChange={event => setDestination(event.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white"
                >
                  <option value="game_balance">Worldtycoon balance (@{user?.username})</option>
                  <option value="native_wallet">Mainnet NUM wallet address</option>
                </select>
              </div>
              {destination === 'native_wallet' && (
                <input
                  type="text"
                  value={walletAddress}
                  onChange={event => setWalletAddress(event.target.value)}
                  placeholder="Mainnet NUM wallet address"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-sm font-mono text-white"
                  autoComplete="off"
                />
              )}

              <button
                onClick={handleCreateOrder}
                disabled={processing || !user?.token || !Number(payAmount)}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white font-bold text-sm shadow-xl shadow-emerald-700/20 transition-all flex items-center justify-center space-x-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>{processing ? 'Opening secure checkout…' : 'Continue to secure checkout'}</span>
              </button>
              <p className="text-center text-[11px] text-slate-400">
                Card details are handled by Stripe. NUM is delivered only after a signed payment confirmation and chain settlement.
              </p>
            </div>
          )}

        </div>

      </div>
    </div>
  );
}
