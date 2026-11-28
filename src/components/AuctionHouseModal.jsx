import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { Gavel, Coins, Clock, Plus, ShoppingBag, X } from 'lucide-react';

export default function AuctionHouseModal() {
  const { user, wallet, plots, setActiveModal, refreshWallet, addToast } = useGame();
  const [auctions, setAuctions] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('browse');
  const [filter, setFilter] = useState('All');
  const [bidAmount, setBidAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [category, setCategory] = useState('Land Plot');
  const [title, setTitle] = useState('');
  const [assetRef, setAssetRef] = useState('');
  const [startingBid, setStartingBid] = useState('10');
  const [buyoutPrice, setBuyoutPrice] = useState('25');
  const [durationHours, setDurationHours] = useState('24');

  const myPlots = (plots || []).filter(p => p.isClaimed && String(p.owner || '').toLowerCase() === String(user?.username || '').toLowerCase());

  const fetchAuctions = async () => {
    try {
      const res = await fetch('/api/auctions');
      if (res.ok) {
        const data = await res.json();
        const list = data.auctions || [];
        setAuctions(list);
        if (!selected && list.length > 0) setSelected(list);
        else if (selected) { const u = list.find(a => a.id === selected.id); if (u) setSelected(u); }
      }
    } catch {}
  };

  useEffect(() => { fetchAuctions(); const id = setInterval(fetchAuctions, 5000); return () => clearInterval(id); }, []);

  const handleBid = async (auctionId) => {
    const val = parseFloat(bidAmount);
    if (!val || val <= 0) return addToast('Enter a valid bid', 'error');
    try {
      setSubmitting(true);
      const res = await fetch(`/api/auctions/${auctionId}/bid`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` }, body: JSON.stringify({ amount: val }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      addToast('Bid submitted on-chain; awaiting confirmations', 'success'); setBidAmount(''); await fetchAuctions(); await refreshWallet();
    } catch (err) { addToast(err.message, 'error'); } finally { setSubmitting(false); }
  };

  const handleBuyout = async (auctionId) => {
    try {
      setSubmitting(true);
      const res = await fetch(`/api/auctions/${auctionId}/buyout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      addToast('Buyout submitted on-chain; ownership changes after confirmation', 'success'); await fetchAuctions(); await refreshWallet();
    } catch (err) { addToast(err.message, 'error'); } finally { setSubmitting(false); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      setSubmitting(true);
      const res = await fetch('/api/auctions/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` }, body: JSON.stringify({ title, category, assetRef, startingBid: Number(startingBid), buyoutPrice: Number(buyoutPrice), durationHours: Number(durationHours) }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      addToast('Asset listed on the Universal Auction Exchange!', 'success'); setTitle(''); setAssetRef(''); setTab('browse'); await fetchAuctions();
    } catch (err) { addToast(err.message, 'error'); } finally { setSubmitting(false); }
  };

  const categories = ['All', 'Land Plot', 'Pre-1920 Coin', 'Peerage Title'];
  const visible = auctions.filter(a => filter === 'All' || (a.category || a.assetType) === filter);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#161d2a] border border-slate-700 w-full max-w-4xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="p-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Gavel className="w-5 h-5 text-amber-400" />
            <div><h2 className="text-base font-black text-white">Universal Asset Auction House</h2><p className="text-[11px] text-slate-400">Trade Plots, Pre-1920 Coins & Peerage Titles · 5% Sovereign Vault Tax</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setTab('browse')} className={'px-3 py-1.5 rounded-lg text-xs font-bold ' + (tab === 'browse' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300')}>Browse Lots</button>
            <button onClick={() => setTab('create')} className={'px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ' + (tab === 'create' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300')}><Plus className="w-3.5 h-3.5" /> List Asset</button>
            <button onClick={() => setActiveModal(null)} className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        </div>
        {tab === 'create' ? (
          <form onSubmit={handleCreate} className="p-5 space-y-3 overflow-y-auto">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-mono text-slate-300 mb-1">Asset Type</label><select value={category} onChange={e => setCategory(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white"><option value="Land Plot">Land Plot Deed</option><option value="Pre-1920 Coin">Pre-1920 Gold/Silver Coin</option><option value="Peerage Title">Peerage / Royal Title</option></select></div>
              <div><label className="block text-xs font-mono text-slate-300 mb-1">Duration (Hours)</label><select value={durationHours} onChange={e => setDurationHours(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white"><option value="1">1 Hour</option><option value="6">6 Hours</option><option value="24">24 Hours</option><option value="72">3 Days</option></select></div>
            </div>
            {category === 'Land Plot' ? (
              <div><label className="block text-xs font-mono text-slate-300 mb-1">Select Your Owned Plot</label><select value={assetRef} onChange={e => { setAssetRef(e.target.value); const pl = myPlots.find(x => x.id === e.target.value); if (pl && !title) setTitle(`${pl.label} (${pl.id})`); }} className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white"><option value="">-- Choose Owned Plot ({myPlots.length}) --</option>{myPlots.map(pl => <option key={pl.id} value={pl.id}>{pl.label} ({pl.id})</option>)}</select></div>
            ) : (
              <div><label className="block text-xs font-mono text-slate-300 mb-1">Asset Serial / @Handle / Title Name</label><input type="text" value={assetRef} onChange={e => setAssetRef(e.target.value)} placeholder="e.g. PRE-1920-000001 or @sovereign or Duke" className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" /></div>
            )}
            <div><label className="block text-xs font-mono text-slate-300 mb-1">Auction Title</label><input type="text" required value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. 1895 Gold Sovereign (20s) or Westminster Plot Deed" className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs text-white" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-mono text-slate-300 mb-1">Starting Bid (NUM)</label><input type="number" step="0.1" min="0" value={startingBid} onChange={e => setStartingBid(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" /></div>
              <div><label className="block text-xs font-mono text-slate-300 mb-1">Instant Buyout (NUM)</label><input type="number" step="0.1" min="1" value={buyoutPrice} onChange={e => setBuyoutPrice(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" /></div>
            </div>
            <button disabled={submitting} type="submit" className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">{submitting ? 'Listing...' : 'Publish Asset Auction (95% Seller / 5% Sovereign Vault)'}</button>
          </form>
        ) : (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800 flex gap-1.5 overflow-x-auto">{categories.map(c => <button key={c} onClick={() => setFilter(c)} className={'px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap ' + (filter === c ? 'bg-amber-600 text-white' : 'bg-slate-900 text-slate-400 hover:text-white')}>{c}</button>)}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 flex-1 overflow-y-auto divide-y md:divide-y-0 md:divide-x divide-slate-800">
              <div className="p-3 space-y-2 overflow-y-auto">{visible.length === 0 ? <p className="text-xs text-slate-500 p-4 text-center">No listings in this category yet.</p> : visible.map(a => { const exp = a.status === 'expired' || a.status === 'settled' || Date.now() >= new Date(a.endsAt).getTime(); return (<button key={a.id} onClick={() => setSelected(a)} className={'w-full text-left p-3 rounded-xl border transition ' + (selected?.id === a.id ? 'bg-amber-950/30 border-amber-500/50' : 'bg-slate-900/70 border-slate-800 hover:border-slate-700')}><div className="flex items-center justify-between gap-2"><span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-slate-800 text-amber-300">{a.category || a.assetType}</span><span className={'text-[10px] font-mono ' + (exp ? 'text-rose-400' : 'text-emerald-400')}>{exp ? (a.status === 'settled' ? 'SETTLED' : 'EXPIRED') : 'LIVE'}</span></div><div className="text-xs font-bold text-white mt-1.5">{a.title}</div><div className="flex items-center justify-between text-[11px] text-slate-400 mt-1 font-mono"><span>Bid: <strong className="text-amber-300">{a.currentBid} NUM</strong></span>{a.buyoutPrice && <span>Buyout: <strong className="text-emerald-300">{a.buyoutPrice} NUM</strong></span>}</div></button>); })}</div>
              <div className="p-4 flex flex-col justify-between bg-slate-950/40">{selected ? (() => { const exp = selected.status === 'expired' || selected.status === 'settled' || Date.now() >= new Date(selected.endsAt).getTime(); return (<div className="space-y-3"><div className="flex items-center justify-between"><span className="text-xs font-mono text-amber-400">{selected.category || selected.assetType}</span><span className="text-[11px] font-mono text-slate-400 flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {exp ? 'Ended' : new Date(selected.endsAt).toLocaleString()}</span></div><h3 className="text-base font-black text-white">{selected.title}</h3><div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5 text-xs font-mono"><div className="flex justify-between"><span className="text-slate-400">Seller:</span><span className="text-white">{selected.seller}</span></div><div className="flex justify-between"><span className="text-slate-400">Highest Bid:</span><span className="text-amber-400 font-bold">{selected.currentBid} NUM</span></div><div className="flex justify-between"><span className="text-slate-400">Leader:</span><span className="text-emerald-300">{selected.highestBidder || 'None'}</span></div>{selected.buyoutPrice && <div className="flex justify-between"><span className="text-slate-400">Instant Buyout:</span><span className="text-emerald-400 font-bold">{selected.buyoutPrice} NUM</span></div>}</div>{!exp ? (<div className="space-y-2.5 pt-2"><div className="flex gap-2"><input type="number" step="0.1" value={bidAmount} onChange={e => setBidAmount(e.target.value)} placeholder={`> ${selected.currentBid} NUM`} className="flex-1 px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" /><button disabled={submitting} onClick={() => handleBid(selected.id)} className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold flex items-center gap-1"><Coins className="w-3.5 h-3.5" /> Place Bid</button></div>{selected.buyoutPrice && (<button disabled={submitting} onClick={() => handleBuyout(selected.id)} className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1.5"><ShoppingBag className="w-4 h-4" /> Instant Buyout ({selected.buyoutPrice} NUM · 5% Vault Tax)</button>)}</div>) : (<div className="p-3 rounded-xl bg-rose-950/30 border border-rose-500/30 text-xs text-rose-300 font-mono text-center">This auction has {selected.status === 'settled' ? 'settled on-chain' : 'expired'}.</div>)}</div>); })() : <p className="text-xs text-slate-500 text-center my-auto">Select an auction lot to inspect or bid.</p>}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}