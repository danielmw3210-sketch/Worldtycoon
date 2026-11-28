import React, { useCallback, useEffect, useState } from 'react';
import { Coins, MapPin, Pickaxe, RefreshCw, X } from 'lucide-react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { buildingSprite } from './sprites';

const human = value => String(value || '').replaceAll('_', ' ');

export default function DeedsModal() {
  const { user, plots, refreshPlots, refreshWallet, setSelectedPlot, setActiveModal, watchJob, addToast } = useGame();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const deeds = (plots || []).filter(plot => plot.isClaimed && String(plot.owner || '').replace(/^@/, '').toLowerCase() === user?.username?.toLowerCase());
  const available = deeds.reduce((total, plot) => total + (Number(plot.building?.stats?.accruedIncome) || 0), 0);

  const collectAll = async () => {
    if (busy || available <= 0.0001) return;
    setBusy(true);
    try {
      const response = await fetch('/api/plots/collect-all-income', { method: 'POST', headers: { Authorization: `Bearer ${user?.token || ''}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not collect income');
      addToast(`Collecting ${Number(data.amount).toFixed(4)} NUM from ${data.count} settlement(s).`, 'info');
      const job = await watchJob(data.job?.id);
      if (job?.status === 'confirmed') addToast('Settlement income has arrived in your wallet.', 'success');
      await Promise.all([refreshPlots(), refreshWallet()]);
    } catch (error) { addToast(error.message || 'Could not collect income', 'error'); }
    finally { setBusy(false); }
  };

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await refreshPlots(); await refreshWallet(); }
    finally { setRefreshing(false); }
  }, [refreshPlots, refreshWallet]);
  useEffect(() => { refresh(); }, []);

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 game-modal-backdrop">
    <section className="game-modal-panel w-full max-w-4xl max-h-[92vh] rounded-2xl overflow-hidden flex flex-col">
      <header className="game-modal-header flex items-center justify-between p-5">
        <div className="flex items-center gap-3"><MapPin className="w-6 h-6 text-orange-300" /><div><h2 className="text-lg font-black text-white">My Deeds</h2><p className="text-xs text-slate-400">Your settlements, buildings and resource deposits</p></div></div>
        <div className="flex gap-2"><button onClick={refresh} aria-label="Refresh" className="game-modal-close"><RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} /></button><button onClick={() => setActiveModal(null)} aria-label="Close" className="game-modal-close"><X className="w-4 h-4" /></button></div>
      </header>
      <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-3">
        <div className="text-sm text-slate-300">{deeds.length} deed{deeds.length === 1 ? '' : 's'} <span className="text-slate-600">·</span> <span className="text-emerald-300 font-mono">{available.toFixed(4)} NUM uncollected</span></div>
        <button disabled={busy || available <= 0.0001} onClick={collectAll} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-xs font-bold"><Coins className="w-4 h-4" />{busy ? 'Collecting…' : 'Collect All'}</button>
      </div>
      <div className="p-4 overflow-y-auto">
        {deeds.length === 0 ? <div className="py-12 text-center text-slate-400">No settlements yet. Choose a plot on the map to begin.</div> : <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {deeds.map(plot => <article key={plot.id} className="game-modal-card p-4 rounded-xl space-y-3">
            <div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3 min-w-0"><GameSprite sprite={buildingSprite(plot.building)} /><div><div className="text-[10px] uppercase tracking-wide text-slate-500">{plot.label || plot.id} · {plot.region}</div><h3 className="mt-1 text-base font-bold text-white">{plot.isCastle ? `Castle · ${plot.name}` : plot.name}</h3><div className="text-xs text-slate-400">{plot.building?.name || 'Peasant Lodge'} · Level {plot.building?.level || 1}</div></div></div><span className="px-2 py-1 rounded-lg bg-slate-800 text-[10px] uppercase text-emerald-300">{plot.nftState?.stage || 'deed'}</span></div>
            <div className="flex flex-wrap gap-1.5">{Object.entries(plot.resourceDeposits || {}).filter(([, amount]) => Number(amount) > 0).map(([resource, amount]) => <span key={resource} className="px-2 py-1 rounded-md bg-slate-950 text-[10px] text-slate-300 capitalize">{human(resource)} · {Number(amount).toLocaleString()}</span>)}</div>
            <div className="flex items-center justify-between text-xs"><span className="text-slate-400">Income / hour</span><span className="font-mono text-emerald-300">{Number(plot.building?.incomePerHour || 0).toFixed(4)} NUM</span></div>
            <button onClick={() => { setSelectedPlot(plot); setActiveModal('plot_details'); }} className="w-full inline-flex justify-center items-center gap-2 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white"><Pickaxe className="w-3.5 h-3.5 text-orange-300" />Open Settlement</button>
          </article>)}
        </div>}
      </div>
    </section>
  </div>;
}
