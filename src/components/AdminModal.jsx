import React, { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, X, Coins, Pickaxe, CreditCard } from 'lucide-react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { resourceIcon } from './sprites';

function Metric({ label, value, detail, icon: Icon, tone = 'orange' }) {
  const tones = {
    orange: 'border-orange-500/30 bg-orange-950/20 text-orange-300',
    emerald: 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300',
    cyan: 'border-cyan-500/30 bg-cyan-950/20 text-cyan-300',
    amber: 'border-amber-500/30 bg-amber-950/20 text-amber-300'
  };
  return (
    <div className={`game-modal-card p-4 rounded-xl ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
        {Icon && <Icon className="w-4 h-4" />}
        {label}
      </div>
      <div className="mt-2 text-2xl font-black font-mono text-white">{value}</div>
      {detail && <div className="mt-1 text-[10px] text-slate-400">{detail}</div>}
    </div>
  );
}

export default function AdminModal() {
  const { user, setActiveModal, addToast } = useGame();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/summary', {
        headers: { Authorization: `Bearer ${user?.token || ''}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load admin summary');
      setSummary(data);
      setError('');
    } catch (err) {
      setError(err.message || 'Admin summary unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [user?.token]);

  if (user?.role !== 'admin') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop">
        <section className="game-modal-panel w-full max-w-md rounded-2xl p-6 text-center">
          <ShieldCheck className="mx-auto w-10 h-10 text-red-300" />
          <h2 className="mt-3 font-black text-white">Administrator Access Required</h2>
          <p className="mt-2 text-xs text-slate-400">Sign in with the configured administrator account.</p>
          <button onClick={() => setActiveModal(null)} className="mt-5 px-4 py-2 rounded-lg bg-slate-800 text-xs text-white">Close</button>
        </section>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop">
      <section className="game-modal-panel w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl text-white">
        <header className="game-modal-header flex items-center justify-between p-5">
          <div className="flex items-center gap-3">
            <GameSprite sprite={resourceIcon('vault')} className="game-art--large" />
            <div>
              <h2 className="text-lg font-black">Administrator Treasury</h2>
              <p className="text-xs text-slate-400">Worldtycoon supply and purchase telemetry</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="game-modal-close" onClick={load} aria-label="Refresh" disabled={loading}>
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button className="game-modal-close" onClick={() => setActiveModal(null)} aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <main className="p-5 space-y-4">
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-4 text-xs text-red-300">{error}</div>
          )}
          {summary && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Metric label="In-game supply" value={`${Number(summary.inGameSupply.totalNum).toFixed(4)} NUM`} detail={`${summary.inGameSupply.accountCount} player accounts`} icon={Coins} tone="orange" />
                <Metric label="In-game mined" value={`${Number(summary.inGameSupply.minedNum).toFixed(4)} NUM`} detail={`${summary.inGameSupply.transactionCount} ledger transactions`} icon={Pickaxe} tone="emerald" />
                <Metric label="Paid purchases" value={`£${Number(summary.purchases.gbpPaid).toFixed(2)}`} detail={`${summary.purchases.paidOrderCount} paid of ${summary.purchases.orderCount} orders · ${Number(summary.purchases.numPurchased).toFixed(4)} NUM`} icon={CreditCard} tone="cyan" />
                <Metric label="Native generated" value={summary.nativeSupply.available ? `${Number(summary.nativeSupply.generatedNum).toFixed(4)} NUM` : 'Unavailable'} detail={summary.nativeSupply.available ? 'Cumulative native issuance' : 'Requires live wallet/node RPC'} icon={ShieldCheck} tone="amber" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="game-modal-card p-4 rounded-xl">
                  <div className="text-xs font-bold text-slate-200">GBP launch reference</div>
                  <div className="mt-2 text-sm font-mono text-amber-300">£{summary.launchReferenceGbpPerNum} per displayed NUM</div>
                  <div className="mt-3 space-y-2 text-xs font-mono">
                    <div className="flex justify-between gap-3"><span className="text-slate-400">In-game supply value</span><span>£{Number(summary.inGameSupply.launchReferenceGbp).toFixed(2)}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-slate-400">Native generated value</span><span>{summary.nativeSupply.launchReferenceGbp == null ? 'Unavailable' : `£${Number(summary.nativeSupply.launchReferenceGbp).toFixed(2)}`}</span></div>
                  </div>
                  <p className="mt-3 text-[10px] text-slate-500">Estimated launch reference only. It is not live liquidity, a redemption quote, or realized profit.</p>
                </div>
                <div className="game-modal-card p-4 rounded-xl">
                  <div className="text-xs font-bold text-slate-200">Chain telemetry</div>
                  <div className="mt-3 space-y-2 text-xs font-mono">
                    <div className="flex justify-between"><span className="text-slate-400">Network</span><span>{summary.network}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Chain height</span><span>#{summary.height}</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Updated</span><span className="text-slate-300">{summary.asOf ? new Date(summary.asOf).toLocaleTimeString() : '—'}</span></div>
                  </div>
                </div>
              </div>
            </>
          )}
          {!summary && !error && !loading && (
            <div className="text-center py-10 text-xs text-slate-500">No summary available</div>
          )}
        </main>
      </section>
    </div>
  );
}
