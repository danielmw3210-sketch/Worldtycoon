import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { townSprite } from './sprites';
import { 
  TrendingUp, 
  Coins, 
  ArrowUpRight, 
  ArrowDownRight, 
  DollarSign, 
  PieChart, 
  CheckCircle, 
  Percent 
} from 'lucide-react';

export default function StockBrokerModal() {
  const { user, wallet, setActiveModal, refreshWallet, addToast } = useGame();

  const [stocks, setStocks] = useState([]);
  const [portfolio, setPortfolio] = useState({});
  const [selectedStock, setSelectedStock] = useState(null);
  const [sharesInput, setSharesInput] = useState('1');
  const [orderAction, setOrderAction] = useState('buy'); // 'buy' | 'sell'
  const [submitting, setSubmitting] = useState(false);

  const fetchStocks = async () => {
    try {
      const res = await fetch(`/api/stocks?username=${encodeURIComponent(user?.username || '')}`, {
        headers: { Authorization: `Bearer ${user?.token || ''}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStocks(data.stocks || []);
        setPortfolio(data.portfolio || {});
        if (!selectedStock && data.stocks?.length > 0) {
          setSelectedStock(data.stocks[0]);
        } else if (selectedStock) {
          const fresh = data.stocks.find(s => s.ticker === selectedStock.ticker);
          if (fresh) setSelectedStock(fresh);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchStocks();
    const interval = setInterval(fetchStocks, 4000);
    return () => clearInterval(interval);
  }, [user?.username, user?.token]);

  const handleTrade = async () => {
    const shares = parseInt(sharesInput, 10);
    if (!shares || shares <= 0) return addToast('Enter a valid quantity of shares', 'error');

    try {
      setSubmitting(true);
      const res = await fetch('/api/stocks/trade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user?.token || ''}`
        },
        body: JSON.stringify({
          ticker: selectedStock.ticker,
          action: orderAction,
          shares,
          username: user?.username
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`${orderAction === 'buy' ? 'Purchase' : 'Sale'} submitted to the blockchain; holdings update after confirmation.`, 'info');
      await fetchStocks();
      await refreshWallet();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const ownedShares = selectedStock ? (portfolio[selectedStock.ticker] || 0) : 0;
  const totalCost = selectedStock ? +(selectedStock.price * (parseInt(sharesInput) || 0)).toFixed(2) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-cyan-500/40 w-full max-w-4xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-cyan-950/60 via-slate-900 to-[#161d2a] border-b border-cyan-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-400 flex items-center justify-center text-white shadow-lg shadow-cyan-500/30 border border-cyan-200">
              <TrendingUp className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-cyan-400 bg-cyan-950 border border-cyan-700/60 px-2 py-0.5 rounded">
                  Worldtycoon Equities Exchange
                </span>
                <span className="text-xs text-slate-400 font-mono">Canary Wharf & Albert Dock Bourse</span>
              </div>
              <div className="flex items-center gap-3 mt-1"><GameSprite sprite={townSprite('stock_exchange')} className="game-art--small" /><h2 className="text-2xl font-black text-white">Sovereign Stock Broker & Securities</h2></div>
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
        <div className="p-6 overflow-y-auto space-y-6">

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Stocks List (Left 2 cols) */}
            <div className="lg:col-span-2 space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono block">
                Listed Equities & Infrastructure REITs ({stocks.length})
              </span>

              <div className="space-y-2.5">
                {stocks.map(stock => {
                  const userOwns = portfolio[stock.ticker] || 0;
                  const isPositive = stock.change24h >= 0;

                  return (
                    <div
                      key={stock.ticker}
                      onClick={() => setSelectedStock(stock)}
                      className={`p-4 rounded-xl border transition-all cursor-pointer ${
                        selectedStock?.ticker === stock.ticker
                          ? 'bg-cyan-950/30 border-cyan-500 shadow-lg shadow-cyan-950/30'
                          : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="text-xs font-mono font-bold text-cyan-400 bg-cyan-950 px-2 py-0.5 rounded border border-cyan-800">
                              {stock.ticker}
                            </span>
                            <span className="text-sm font-bold text-white">{stock.name}</span>
                          </div>
                          <div className="flex items-center space-x-3 text-xs text-slate-400 mt-1 font-mono">
                            <span>Yield: {stock.dividendYield}% APY</span>
                            <span>•</span>
                            <span>Mkt Cap: {stock.marketCap.toLocaleString()} NUM</span>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-base font-black font-mono text-white">
                            {stock.price.toFixed(2)} NUM
                          </div>
                          <div className={`text-xs font-mono font-semibold flex items-center justify-end ${
                            isPositive ? 'text-emerald-400' : 'text-rose-400'
                          }`}>
                            {isPositive ? <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" /> : <ArrowDownRight className="w-3.5 h-3.5 mr-0.5" />}
                            {stock.change24h}%
                          </div>
                        </div>
                      </div>

                      {userOwns > 0 && (
                        <div className="mt-2.5 pt-2 border-t border-slate-800 flex justify-between text-xs">
                          <span className="text-slate-400">Your Holdings:</span>
                          <span className="font-mono text-cyan-300 font-bold">
                            {userOwns} shares (~{(userOwns * stock.price).toFixed(2)} NUM)
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Trading Slip (Right col) */}
            {selectedStock && (
              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center space-x-2 pb-2 border-b border-slate-800">
                    <span className="text-xs font-mono font-bold uppercase text-cyan-400">Trading Desk</span>
                    <span className="text-xs text-white font-bold">{selectedStock.ticker}</span>
                  </div>

                  {/* Buy / Sell Tabs */}
                  <div className="flex rounded-xl bg-slate-950 p-1 my-3">
                    <button
                      onClick={() => setOrderAction('buy')}
                      className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${
                        orderAction === 'buy' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Buy Shares
                    </button>
                    <button
                      onClick={() => setOrderAction('sell')}
                      className={`flex-1 py-1.5 text-xs font-bold rounded-lg transition-all ${
                        orderAction === 'sell' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Sell Shares
                    </button>
                  </div>

                  {/* Holdings & Price Info */}
                  <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1.5 text-xs font-mono">
                    <div className="flex justify-between text-slate-400">
                      <span>Market Price:</span>
                      <span className="text-white font-bold">{selectedStock.price.toFixed(2)} NUM</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>You Own:</span>
                      <span className="text-cyan-300 font-bold">{ownedShares} shares</span>
                    </div>
                    <div className="flex justify-between text-slate-400">
                      <span>Wallet Balance:</span>
                      <span className="text-orange-400 font-bold">{wallet.balance.toFixed(2)} NUM</span>
                    </div>
                  </div>

                  {/* Quantity Input */}
                  <div className="space-y-2 mt-4">
                    <label className="text-xs text-slate-400 block">Quantity of Shares:</label>
                    <div className="relative">
                      <input
                        type="number"
                        min="1"
                        value={sharesInput}
                        onChange={(e) => setSharesInput(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-base font-mono text-white focus:outline-none focus:border-cyan-500"
                      />
                      {orderAction === 'sell' && ownedShares > 0 && (
                        <button
                          onClick={() => setSharesInput(ownedShares.toString())}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-cyan-400"
                        >
                          ALL
                        </button>
                      )}
                    </div>

                    <div className="flex justify-between text-xs text-slate-400 font-mono pt-1">
                      <span>Order Value:</span>
                      <span className="text-white font-bold">{totalCost} NUM</span>
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-500 font-mono">
                      <span>Brokerage (1.5%) + Tax:</span>
                      <span>+{(totalCost * 0.025).toFixed(2)} NUM</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={handleTrade}
                  disabled={submitting || !sharesInput || parseInt(sharesInput) <= 0 || (orderAction === 'sell' && ownedShares < parseInt(sharesInput))}
                  className={`w-full py-3 rounded-xl font-bold text-xs text-white shadow-xl transition-all flex items-center justify-center space-x-2 ${
                    orderAction === 'buy'
                      ? 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 shadow-cyan-700/20'
                      : 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 disabled:opacity-40 shadow-rose-700/20'
                  }`}
                >
                  <Coins className="w-4 h-4" />
                  <span>
                    {submitting 
                      ? 'Executing Order...' 
                      : `${orderAction.toUpperCase()} ${sharesInput || 0} SHARES`
                    }
                  </span>
                </button>
              </div>
            )}

          </div>

        </div>

      </div>
    </div>
  );
}
