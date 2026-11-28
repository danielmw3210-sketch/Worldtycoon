import React, { useCallback, useEffect, useState } from 'react';
import { Shield, X, Swords, Map, Users, Coins, RefreshCw } from 'lucide-react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { itemSprite, townSprite } from './sprites';

export default function ArmyModal() {
  const { user, setActiveModal, addToast, refreshWallet, watchJob } = useGame();
  const [data, setData] = useState(null), [count, setCount] = useState(1), [busy, setBusy] = useState(false), [plots, setPlots] = useState([]), [destination, setDestination] = useState(''), [estimates, setEstimates] = useState({});
  const load = useCallback(async () => { const [response, plotResponse] = await Promise.all([fetch('/api/army', { headers: { Authorization: `Bearer ${user?.token || ''}` } }), fetch('/api/plots')]); const json = await response.json(), plotJson = await plotResponse.json(); if (!response.ok) throw new Error(json.error || 'Could not load forces'); setData(json.army); setPlots(plotJson.plots || []); setDestination(old => old || plotJson.plots?.find(p=>p.isClaimed)?.id || ''); }, [user?.token]);
  useEffect(() => { load().catch(e => addToast(e.message, 'error')); const timer = setInterval(() => load().catch(() => {}), 5000); return () => clearInterval(timer); }, [load, addToast]);
  const armySignature = (data?.armies || []).map(a => `${a.id}:${a.locationPlotId}:${a.status}:${a.soldierIds?.length || 0}`).join('|');
  useEffect(() => {
    let cancelled = false;
    const armies = (data?.armies || []).filter(a => a.status === 'idle');
    if (!destination || !armies.length) { setEstimates({}); return () => { cancelled = true; }; }
    Promise.all(armies.map(async army => {
      const response = await fetch(`/api/army/${encodeURIComponent(army.id)}/march-estimate?targetPlotId=${encodeURIComponent(destination)}`, {
        headers: { Authorization: `Bearer ${user?.token || ''}` }
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Could not estimate silver payroll');
      return [army.id, json.estimate];
    })).then(entries => {
      if (!cancelled) setEstimates(Object.fromEntries(entries));
    }).catch(() => {
      if (!cancelled) setEstimates({});
    });
    return () => { cancelled = true; };
  }, [armySignature, destination, user?.token]);
  const recruit = async type => { setBusy(true); try { const response = await fetch('/api/army/recruit', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` }, body: JSON.stringify({ unitType: type, count }) }); const json = await response.json(); if (!response.ok) throw new Error(json.error || 'Recruitment failed'); addToast('Recruitment submitted. Soldiers join after chain confirmation.', 'success'); await Promise.all([load(), refreshWallet()]); watchJob(json.job?.id).then(load); } catch (e) { addToast(e.message, 'error'); } finally { setBusy(false); } };
  const move = async (army, siege = false) => {
    if (!destination) return addToast('Choose a destination plot on the map list.', 'error');
    try {
      const response = await fetch(`/api/army/${army.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` },
        body: JSON.stringify({ targetPlotId: destination, siege })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Could not move army');
      if (json.pending && json.job?.id) {
        addToast(`Silver payroll of ${Number(json.silverFineGrams).toFixed(3)} units queued; the army marches after confirmation.`, 'info');
        watchJob(json.job.id).then(() => load());
      } else {
        addToast(`${army.name} is marching.`, 'success');
        load();
      }
    } catch (e) { addToast(e.message, 'error'); }
  };
  const soldiers = data?.soldiers || [];
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop"><section className="game-modal-panel w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl text-white">
    <header className="game-modal-header flex items-center justify-between p-5"><div className="flex gap-3 items-center"><GameSprite sprite={townSprite('barracks')} className="game-art--small" /><div><h2 className="font-black">Royal Muster</h2><p className="text-xs text-slate-400">Soldiers, equipment, formations and marches</p></div></div><div className="flex gap-2"><button className="game-modal-close" onClick={() => load().catch(e=>addToast(e.message,'error'))} aria-label="Refresh"><RefreshCw size={16}/></button><button className="game-modal-close" onClick={() => setActiveModal(null)} aria-label="Close"><X/></button></div></header>
    <main className="p-5 space-y-4">{!data?.unlocked ? <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-700/40">Your first peerage unlocks recruitment and army command.</div> : <>
      <div className="grid sm:grid-cols-3 gap-3"><div className="p-3 rounded-xl bg-slate-900"><div className="text-xs text-slate-400">Peerage</div><b className="text-amber-300">{data.peerage}</b></div><div className="p-3 rounded-xl bg-slate-900"><div className="text-xs text-slate-400">Soldiers</div><b>{soldiers.length}</b></div><div className="p-3 rounded-xl bg-slate-900"><div className="text-xs text-slate-400">Game coin purse</div><b className="text-amber-300">{Number(data.coinBalance || 0).toFixed(4)} minted NUM</b></div></div>
      <section className="game-modal-card p-4 rounded-xl"><h3 className="font-bold flex gap-2 items-center"><Users size={16}/> Muster new troops</h3><p className="text-xs text-slate-400 mt-1">Recruitment charges NUM on chain. Attacks require a separate, distance-based silver payroll.</p><label className="mt-3 flex items-center gap-2 text-xs text-slate-300">Quantity <input type="number" min="1" max="100" value={count} onChange={e => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="w-20 p-2 rounded bg-slate-950"/></label><div className="mt-3 grid sm:grid-cols-3 gap-2">{[['levy','Levy Spearman',1],['archer','Bowman',3],['cavalry','Light Cavalry',8]].map(([key,label,cost])=><button key={key} disabled={busy} onClick={() => recruit(key)} className="p-2 rounded-xl border border-red-800/60 bg-slate-950/70 hover:border-red-400 disabled:opacity-50 text-left flex items-center gap-2"><GameSprite sprite={itemSprite(key)} /><span><b className="block text-xs">{label}</b><span className="text-xs text-amber-300">{count*cost} NUM</span></span></button>)}</div></section>
      <section className="space-y-2"><h3 className="font-bold">Armies</h3><label className="block text-xs text-slate-400">Destination<select value={destination} onChange={e=>setDestination(e.target.value)} className="mt-1 w-full p-2 rounded bg-slate-950 text-white">{plots.map(p=><option key={p.id} value={p.id}>{p.label} · {p.name}{p.isClaimed?` · controlled by ${p.controller||p.castleOwner||p.owner||'unknown'}`:' · unclaimed'}</option>)}</select></label>{(data.armies || []).length ? data.armies.map(a=>{const estimate=estimates[a.id];return <div key={a.id} className="p-3 rounded-xl bg-slate-900 flex flex-wrap items-center justify-between gap-2"><div><b>{a.name}</b><div className="text-xs text-slate-400">{a.soldierIds.length} soldiers · {a.status} · location {a.locationPlotId || 'unassigned'}{a.arrivesAt?` · ETA ${new Date(a.arrivesAt).toLocaleTimeString()}`:''}</div>{a.status==='idle'&&estimate&&<div className={`mt-1 text-[11px] ${estimate.canAfford?'text-emerald-300':'text-amber-300'}`}>Attack payroll: {Number(estimate.silverFineGrams).toFixed(3)}g fine silver · {estimate.distanceTiles} tiles · wallet {Number(estimate.availableSilverFineGrams).toFixed(3)}g</div>}{a.payrollError&&<div className="mt-1 text-[11px] text-red-300">{a.payrollError}</div>}</div><div className="flex gap-2"><button disabled={a.status !== 'idle'} onClick={() => move(a)} className="px-3 py-2 rounded bg-slate-800 disabled:opacity-40"><Map size={14} className="inline mr-1"/>March</button><button disabled={a.status !== 'idle' || !plots.find(p=>p.id===destination)?.isClaimed || !estimate?.canAfford} onClick={() => move(a,true)} className="px-3 py-2 rounded bg-red-900 disabled:opacity-40"><Swords size={14} className="inline mr-1"/>Attack</button></div></div>}) : <p className="text-xs text-slate-500">Muster soldiers, then use the Soldiers panel to organize a force.</p>}</section>
      {!!data.battles?.length && <section className="space-y-2"><h3 className="font-bold">On-chain battle records</h3>{data.battles.slice(0,5).map(b=><a key={b.assetId} href={`/api/battles/${b.assetId}`} target="_blank" rel="noreferrer" className="block p-3 rounded-lg bg-slate-900 border border-emerald-900/50 text-xs hover:border-emerald-500"><b>{b.captured?'Victory':'Battle round'} · {b.plotId}</b><div className="text-slate-400">{b.casualties} losses · {b.plotDamage} plot damage · block {b.blockHeight}</div><code className="text-[9px] text-emerald-300 break-all">tx {b.txHash}</code></a>)}</section>}
      <section className="space-y-2"><div className="flex items-center justify-between"><h3 className="font-bold">Unassigned soldiers · {soldiers.filter(s=>!s.armyId).length}</h3><button onClick={() => setActiveModal('soldiers')} className="px-3 py-1.5 rounded bg-slate-800 text-xs">Open Soldier Roster</button></div>{soldiers.filter(s=>!s.armyId).slice(0,6).map(s=><div key={s.id} className="game-modal-card p-2 rounded-xl text-xs flex items-center justify-between"><div className="flex items-center gap-2"><GameSprite sprite={itemSprite(s.type)} className="game-art--small" /><span>{s.name} · {s.type}</span></div><span>HP {s.hp}/{s.maxHp} · ATK {s.attack+(s.weapon?.health!==0?(s.weapon?.attack||0):0)}</span></div>)}</section>
      <p className="text-[10px] text-slate-500 flex gap-1"><Coins size={12}/> Attacks require confirmed player-minted silver payroll: 0.01 resource units or fine grams of coin/bar silver per soldier per route tile. Marching without attacking is free.</p>
    </>}</main></section></div>;
}
