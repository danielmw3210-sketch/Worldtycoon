import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { 
  Landmark, 
  Coins, 
  ArrowDownLeft, 
  ArrowUpRight, 
  Sparkles, 
  ShieldCheck, 
  Percent, 
  Clock 
} from 'lucide-react';

export default function BankModal() {
  const { wallet, setActiveModal, refreshWallet, addToast } = useGame();

  const [bankData, setBankData] = useState({
    userBank: { depositedNum: 50.0, apy: 0.092, accruedInterest: 1.482 },
    baseApy: 0.092
  });

  const [activeTab, setActiveTab] = useState('deposit');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchBank = async () => {
    try {
      const res = await fetch('/api/bank');
      if (res.ok) {
        const data = await res.json();
        setBankData(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchBank();
    const interval = setInterval(fetchBank, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleDeposit = async () => {
    const val = parseFloat(amount);
    if (!val || val <= 0) return addToast('Enter a valid deposit amount', 'error');
    if (val > wallet.balance) return addToast('Insufficient wallet balance', 'error');

    try {
      setSubmitting(true);
      const res = await fetch('/api/bank/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: val })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`Deposited ${val} NUM into Bank Vault!`, 'success');
      setAmount('');
      await fetchBank();
      await refreshWallet();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleWithdraw = async () => {
    const val = parseFloat(amount);
    if (!val || val <= 0) return addToast('Enter a valid withdraw amount', 'error');
    if (val > bankData.userBank.depositedNum) return addToast('Withdrawal exceeds deposited funds', 'error');

    try {
      setSubmitting(true);
      const res = await fetch('/api/bank/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: val })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`Withdrew ${val} NUM from Bank Vault!`, 'success');
      setAmount('');
      await fetchBank();
      await refreshWallet();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClaimInterest = async () => {
    try {
      setSubmitting(true);
      const res = await fetch('/api/bank/claim-interest', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`Claimed ${data.claimed.toFixed(4)} NUM in bank yield!`, 'success');
      await fetchBank();
      await refreshWallet();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const userBank = bankData.userBank || {};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-emerald-500/40 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-emerald-950/60 via-slate-900 to-[#161d2a] border-b border-emerald-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center text-white shadow-lg shadow-emerald-500/30 border border-emerald-200">
              <Landmark className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-emerald-400 bg-emerald-950 border border-emerald-700/60 px-2 py-0.5 rounded">
                  Townforge Sovereign Depository
                </span>
                <span className="text-xs text-slate-400 font-mono">Lombard Vaults Protocol</span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1">Numista Bullion & Reserve Bank</h2>
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

          {/* Staking Yield Summary Card */}
          <div className="p-5 rounded-2xl bg-gradient-to-br from-emerald-950/30 via-slate-900 to-slate-900 border border-emerald-500/30 grid grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-slate-400 block font-mono">Your Staked Vault Deposit</span>
              <span className="text-3xl font-black font-mono text-white mt-1 block">
                {(userBank.depositedNum || 0).toFixed(2)} <span className="text-sm font-semibold text-emerald-400">NUM</span>
              </span>
              <span className="text-[11px] text-emerald-400 font-semibold mt-1 flex items-center">
                <Percent className="w-3 h-3 mr-0.5" /> {((userBank.apy || 0.092) * 100).toFixed(1)}% Annual Fixed APY
              </span>
            </div>

            <div className="border-l border-slate-800 pl-4 flex flex-col justify-between">
              <div>
                <span className="text-xs text-slate-400 block font-mono">Real-Time Accrued Yield</span>
                <span className="text-2xl font-black font-mono text-emerald-300 mt-1 block">
                  +{(userBank.accruedInterest || 0).toFixed(4)} <span className="text-xs font-normal text-slate-400">NUM</span>
                </span>
              </div>
              <button
                onClick={handleClaimInterest}
                disabled={submitting || (userBank.accruedInterest || 0) <= 0.001}
                className="mt-2 py-1.5 px-3 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 disabled:opacity-40 text-xs font-bold transition-all flex items-center justify-center space-x-1"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Claim Yield</span>
              </button>
            </div>
          </div>

          {/* Deposit & Withdraw Tabs */}
          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-4">
            <div className="flex rounded-xl bg-slate-800/80 p-1">
              <button
                onClick={() => { setActiveTab('deposit'); setAmount(''); }}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center space-x-1.5 ${
                  activeTab === 'deposit'
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowDownLeft className="w-3.5 h-3.5" />
                <span>Deposit Funds</span>
              </button>
              <button
                onClick={() => { setActiveTab('withdraw'); setAmount(''); }}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center space-x-1.5 ${
                  activeTab === 'withdraw'
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
                <span>Withdraw Funds</span>
              </button>
            </div>

            {/* Input Form */}
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>{activeTab === 'deposit' ? 'Wallet Balance' : 'Vault Deposited'}:</span>
                <span className="font-mono text-white font-semibold">
                  {activeTab === 'deposit' ? `${wallet.balance.toFixed(2)} NUM` : `${(userBank.depositedNum || 0).toFixed(2)} NUM`}
                </span>
              </div>

              <div className="relative">
                <input
                  type="number"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-3 text-lg font-mono text-white focus:outline-none focus:border-emerald-500 pr-20"
                />
                <button
                  onClick={() => setAmount(activeTab === 'deposit' ? wallet.balance.toString() : (userBank.depositedNum || 0).toString())}
                  className="absolute right-3 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[11px] font-mono font-bold text-emerald-400 transition-colors"
                >
                  MAX
                </button>
              </div>

              <button
                onClick={activeTab === 'deposit' ? handleDeposit : handleWithdraw}
                disabled={submitting || !amount || parseFloat(amount) <= 0}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white font-bold text-sm shadow-xl shadow-emerald-700/20 transition-all flex items-center justify-center space-x-2"
              >
                <Coins className="w-4 h-4" />
                <span>
                  {submitting 
                    ? 'Confirming Transaction...' 
                    : activeTab === 'deposit' 
                      ? `Deposit ${amount || '0'} NUM` 
                      : `Withdraw ${amount || '0'} NUM`
                  }
                </span>
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
