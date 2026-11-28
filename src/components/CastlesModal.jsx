import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { buildingSprite, grandCastleSprite } from './sprites';

export default function CastlesModal() {
  const { user, refreshPlots, setActiveModal, addToast, watchJob } = useGame();
  const [castles,setCastles]=useState([]),[army,setArmy]=useState(null),[busy,setBusy]=useState(''),[loading,setLoading]=useState(true),[estimates,setEstimates]=useState({});
  const load=useCallback(async()=>{setLoading(true);try{const headers={Authorization:`Bearer ${user?.token||''}`};const [c,a]=await Promise.all([fetch('/api/castles'),fetch('/api/army',{headers})]);const cj=await c.json(),aj=await a.json();if(!c.ok)throw new Error(cj.error||'Could not load castles');setCastles(cj.castles||[]);setArmy(aj.army||null);}catch(e){addToast(e.message,'error');}finally{setLoading(false);}},[user?.token,addToast]);
  useEffect(()=>{load();},[load]);
  const forceId=(army?.armies||[]).find(a=>a.status==='idle')?.id||'';
  const castleSignature=castles.map(c=>c.id).join('|');
  useEffect(()=>{let cancelled=false;if(!forceId||!castles.length){setEstimates({});return()=>{cancelled=true;};}Promise.all(castles.map(async castle=>{const response=await fetch(`/api/army/${encodeURIComponent(forceId)}/march-estimate?targetPlotId=${encodeURIComponent(castle.id)}`,{headers:{Authorization:`Bearer ${user?.token||''}`}});const json=await response.json();if(!response.ok)throw new Error(json.error||'Could not estimate silver payroll');return[castle.id,json.estimate];})).then(entries=>{if(!cancelled)setEstimates(Object.fromEntries(entries));}).catch(()=>{if(!cancelled)setEstimates({});});return()=>{cancelled=true;};},[forceId,castleSignature,user?.token]);
  const attack=async castle=>{const force=(army?.armies||[]).find(a=>a.status==='idle');if(!force)return addToast('Form an idle army in Royal Muster before marching.', 'error');setBusy(castle.id);try{const response=await fetch(`/api/castles/${encodeURIComponent(castle.id)}/conquer`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${user?.token||''}`},body:JSON.stringify({armyId:force.id})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not dispatch siege');addToast(`${Number(data.silverFineGrams).toFixed(3)}g silver payroll submitted; march begins after confirmation.`, 'info');if(data.job?.id)watchJob(data.job.id).then(()=>Promise.all([load(),refreshPlots()]));}catch(e){addToast(e.message,'error');}finally{setBusy('');}};
  const idle=(army?.armies||[]).filter(a=>a.status==='idle').length;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop">
      <section className="game-modal-panel w-full max-w-3xl max-h-[90vh] rounded-2xl text-white overflow-hidden flex flex-col">
        <header className="game-modal-header flex items-center justify-between p-5">
          <div className="flex gap-3 items-center">
            <GameSprite sprite={buildingSprite({ type: 'castle_keep' })} className="game-art--small" />
            <div><h2 className="font-black">Frontier Castles</h2><p className="text-xs text-slate-400">A silver payroll must confirm before the army marches.</p></div>
          </div>
          <div className="flex gap-2">
            <button className="game-modal-close" onClick={load} aria-label="Refresh"><RefreshCw className={`w-4 h-4 ${loading?'animate-spin':''}`}/></button>
            <button className="game-modal-close" onClick={()=>setActiveModal(null)} aria-label="Close"><X/></button>
          </div>
        </header>
        <div className="p-4 border-b border-slate-800 text-xs text-slate-300">Idle armies: <b className="text-amber-300">{idle}</b> · 0.01 silver resource units or fine grams per soldier per route tile.</div>
        <main className="p-4 overflow-y-auto">{loading?<p className="text-center py-10 text-slate-400">Loadingâ€¦</p>:!castles.length?<p className="text-center py-10 text-slate-400">No Crown castles are available.</p>:<div className="grid sm:grid-cols-2 gap-3">{castles.map(c=>{const estimate=estimates[c.id];return <article key={c.id} className="game-modal-card p-4 rounded-xl space-y-3"><GameSprite sprite={grandCastleSprite(c.id)} className="game-art--large mx-auto" /><div><div className="text-[10px] uppercase text-slate-500">{c.label||c.id} Â· {c.rarityName}</div><h3 className="font-bold">{c.name}</h3><div className="text-xs text-slate-400">{c.region} Â· Garrison {c.garrison} Â· Fortification {c.fortificationLevel}</div></div><div><div className="flex justify-between text-[10px] text-slate-400"><span>Wall health</span><span>{c.health}/{c.maxHealth}</span></div><div className="h-2 mt-1 rounded bg-slate-800"><div className="h-full rounded bg-red-500" style={{width:`${Math.max(0,Math.min(100,100*c.health/(c.maxHealth||1000)))}%`}}/></div></div>{estimate&&<div className={`text-xs ${estimate.canAfford?'text-emerald-300':'text-amber-300'}`}>Estimated: {Number(estimate.silverFineGrams).toFixed(3)}g silver Â· {estimate.distanceTiles} tiles Â· wallet {Number(estimate.availableSilverFineGrams).toFixed(3)}g</div>}<button disabled={!idle||busy===c.id||!army?.unlocked||!estimate?.canAfford} onClick={()=>attack(c)} className="w-full py-2 rounded-lg bg-red-800 hover:bg-red-700 disabled:opacity-40 text-xs font-bold"><ShieldCheck size={14} className="inline mr-1"/>{busy===c.id?'Dispatchingâ€¦':!army?.unlocked?'Buy a peerage first':!idle?'Form an idle army first':'Pay silver & march'}</button></article>})}</div>}</main>
      </section>
    </div>
  );
}
