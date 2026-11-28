import React, { useEffect, useMemo, useState } from 'react';
import { Hammer, X, Coins, Pickaxe } from 'lucide-react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { buildingSprite, resourceSprite } from './sprites';

const METALS = ['silver', 'gold'];

export default function ResourceManagementModal() {
  const {
    selectedPlot,
    plots,
    user,
    setActiveModal,
    addToast,
    refreshPlots,
    watchJob
  } = useGame();
  const [metal, setMetal] = useState('silver');
  const [form, setForm] = useState('coin');
  const [weightGrams, setWeightGrams] = useState('1');
  const [purity, setPurity] = useState('0.999');
  const [activeJob, setActiveJob] = useState(null);
  const [minting, setMinting] = useState(false);

  const plot = useMemo(
    () => plots.find(item => item.id === selectedPlot?.id) || selectedPlot,
    [plots, selectedPlot]
  );
  const isOwner = !!user?.username && plot?.owner?.replace(/^@/, '').toLowerCase() === user.username.toLowerCase();
  const stockpile = plot?.stockpile || {};
  const metalStock = Number(stockpile[metal]) || 0;
  const ownedPlots = plots.filter(item => item.isClaimed && item.owner?.replace(/^@/, '').toLowerCase() === user?.username?.toLowerCase());

  useEffect(() => {
    setActiveJob(null);
    if (!plot?.id) return undefined;
    let active = true;
    const checkJob = async () => {
      try {
        const response = await fetch(`/api/plots/${encodeURIComponent(plot.id)}/job`, {
          headers: { Authorization: `Bearer ${user?.token || ''}` }
        });
        if (!response.ok) return;
        const { job } = await response.json();
        if (active) setActiveJob(job && ['queued', 'confirming', 'reverting'].includes(job.status) ? job : null);
      } catch (error) {
        console.error('Failed to check plot transaction:', error);
      }
    };
    checkJob();
    const timer = setInterval(checkJob, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [plot?.id, user?.token]);

  const handleMint = async (event) => {
    event.preventDefault();
    if (!plot?.id || !isOwner) return;
    setMinting(true);
    try {
      const response = await fetch(`/api/plots/${encodeURIComponent(plot.id)}/metal-mint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user?.token || ''}`
        },
        body: JSON.stringify({
          metal,
          form,
          weightGrams: Number(weightGrams),
          purity: Number(purity)
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not mint metal asset');

      setActiveJob(data.job);
      addToast(`${data.fineWeightGrams} fine grams queued for owner-issued ${metal} ${form}`, 'success');
      await refreshPlots();
      watchJob(data.job?.id).then(async job => {
        await refreshPlots();
        if (job?.status === 'confirmed') {
          addToast(`${metal[0].toUpperCase()}${metal.slice(1)} ${form} asset minted to your blockchain account`, 'success');
        }
      });
    } catch (error) {
      addToast(error.message || 'Could not mint metal asset', 'error');
    } finally {
      setMinting(false);
    }
  };

  if (!plot) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 game-modal-backdrop">
      <section className="game-modal-panel w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl text-white">
        <header className="game-modal-header flex items-center justify-between p-5">
          <div className="flex items-center gap-3">
            <Pickaxe className="text-emerald-300" />
            <div>
              <h2 className="font-black">Plot Resources & Mint</h2>
              <p className="text-xs text-slate-400">{plot.name} · {plot.label || plot.id}</p>
            </div>
          </div>
          <button className="game-modal-close" onClick={() => setActiveModal('plot_details')} aria-label="Close resource modal">
            <X />
          </button>
        </header>

        <main className="p-5 space-y-5">
          <section className="p-4 rounded-xl bg-slate-900 border border-slate-800">
            <h3 className="font-bold flex items-center gap-2"><Hammer size={16} />Stored resources</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
              {Object.entries(stockpile).map(([resource, amount]) => (
                <div key={resource} className="game-modal-card p-2 rounded-lg flex items-center gap-2 min-w-0">
                  <GameSprite sprite={resourceSprite(resource)} className="game-art--small" />
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase text-slate-400">{resource}</div>
                    <div className="font-mono font-bold text-emerald-200">{Number(amount || 0).toFixed(3)}</div>
                    {resource === 'silver' || resource === 'gold' ? <div className="text-[9px] text-slate-500">grams in plot stockpile</div> : null}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 grid sm:grid-cols-2 gap-2">
              {(plot.structures || []).map((structure, index) => (
                <div key={`${structure.type}-${index}`} className="game-modal-card rounded-lg p-2 flex items-center gap-2 text-xs text-slate-300">
                  <GameSprite sprite={buildingSprite(structure)} className="game-art--small" />
                  <span>{structure.name}
                  {structure.resource && (
                    <span className="block text-emerald-300">{structure.resource === 'wood' ? 'renewable' : 'finite'} production · {structure.outputPerHour}/h</span>
                  )}</span>
                </div>
              ))}
            </div>
            {Object.keys(plot.resourceDeposits || {}).length > 0 && (
              <p className="mt-3 text-[10px] text-slate-500">
                Remaining finite deposits: {Object.entries(plot.resourceDeposits).map(([key, value]) => `${key} ${Number(value).toFixed(1)}`).join(' · ')}
              </p>
            )}
          </section>

          <form onSubmit={handleMint} className="p-4 rounded-xl bg-amber-950/20 border border-amber-700/40 space-y-3">
            <div className="flex items-center gap-3 text-amber-200 font-bold">
              <GameSprite sprite={buildingSprite({ type: form === 'bar' ? 'metal_bar' : `${metal}_coin` })} />
              <span className="flex items-center gap-2"><Coins size={16} />Issue metal asset to blockchain</span>
            </div>
            <p className="text-xs text-slate-300">
              Mint stored silver or gold as a coin or bar asset directly to your blockchain account. This is owner-authorized and does not require Crown approval or a NUM minting fee. Stock is reserved while the chain confirms.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">
                Metal
                <select value={metal} onChange={event => setMetal(event.target.value)} className="mt-1 w-full p-2 rounded bg-slate-950 border border-slate-700 text-white">
                  {METALS.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Output
                <select value={form} onChange={event => setForm(event.target.value)} className="mt-1 w-full p-2 rounded bg-slate-950 border border-slate-700 text-white">
                  <option value="coin">Coin</option>
                  <option value="bar">Bar</option>
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Weight (grams)
                <input type="number" min="0.001" max={metalStock} step="0.001" required value={weightGrams} onChange={event => setWeightGrams(event.target.value)} className="mt-1 w-full p-2 rounded bg-slate-950 border border-slate-700 text-white" />
                <span className="text-[10px] text-slate-500">Available: {metalStock.toFixed(3)}g</span>
              </label>
              <label className="text-xs text-slate-400">
                Purity
                <input type="number" min="0.5" max="0.9999" step="0.0001" required value={purity} onChange={event => setPurity(event.target.value)} className="mt-1 w-full p-2 rounded bg-slate-950 border border-slate-700 text-white" />
              </label>
            </div>
            <button type="submit" disabled={!isOwner || minting || !!activeJob || !(Number(weightGrams) > 0) || Number(weightGrams) > metalStock} className="w-full py-2.5 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-40 font-bold text-sm">
              {activeJob ? `Waiting for ${activeJob.requiredConfirmations} confirmations…` : minting ? 'Submitting…' : `Mint ${metal} ${form} asset`}
            </button>
            {!isOwner && <p className="text-xs text-rose-300">Only the owner can issue assets from this plot.</p>}
            {activeJob && <p className="text-[10px] text-slate-400">Transaction {activeJob.status}. Reserved metal returns to the plot if the chain rejects the mint.</p>}
          </form>

          {ownedPlots.length > 1 && (
            <p className="text-[10px] text-slate-500">
              Your other resource plots: {ownedPlots.filter(item => item.id !== plot.id).map(item => item.label || item.name).join(', ')}.
              Resources remain in their originating plot stockpiles.
            </p>
          )}
        </main>
      </section>
    </div>
  );
}
