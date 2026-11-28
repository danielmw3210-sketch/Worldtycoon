import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import { Search, Hash, Coins, MapPin, User, X } from 'lucide-react';
import GameSprite from './GameSprite';
import { townSprite } from './sprites';

export default function ExplorerModal() {
  const { setActiveModal, network } = useGame();
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const runSearch = async (override) => {
    const query = String(override ?? q).trim();
    if (!query) return;
    setQ(query);
    setLoading(true); setErr(''); setData(null);
    try {
      const r = await fetch('/api/explorer/search?q=' + encodeURIComponent(query));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Not found on blockchain');
      setData(d.result);
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#161d2a] border border-cyan-500/40 w-full max-w-3xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <div className="p-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <GameSprite sprite={townSprite('library')} className="game-art--small" />
            <div><h2 className="text-base font-black text-white">Numista Blockchain & Asset Explorer</h2><p className="text-[11px] text-slate-400">Verify any Block Height, Block/Tx Hash, Coin Serial, Plot Deed, @Handle, or Sb.../UGN... Address</p></div>
          </div>
          <button onClick={() => setActiveModal(null)} className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          <form onSubmit={e => { e.preventDefault(); runSearch(); }} className="flex gap-2">
            <input type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="Paste 64-hex tx/block hash, block height, COIN-1887-000001, uk-0001, @handle, or Sb.../UGN..." className="flex-1 px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" />
            <button disabled={loading} type="submit" className="px-4 py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold flex items-center gap-1.5"><Search className="w-3.5 h-3.5" /> {loading ? 'Scanning...' : 'Verify On-Chain'}</button>
          </form>

          <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
            {network?.height && <button type="button" onClick={() => runSearch(String(network.height))} className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-700">Latest Block #{network.height}</button>}
            <button type="button" onClick={() => runSearch('uk-0001')} className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-amber-300 border border-slate-700">Plot uk-0001</button>
            <button type="button" onClick={() => runSearch('@danie')} className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-emerald-300 border border-slate-700">@danie</button>
            <button type="button" onClick={() => runSearch('@unknown_1')} className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-purple-300 border border-slate-700">@unknown_1</button>
          </div>

          {err && <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs font-mono text-rose-300">{err}</div>}

          {data && (
            <div className="p-3.5 rounded-xl bg-slate-950 border border-cyan-500/30 space-y-2 text-xs font-mono">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="uppercase font-bold text-cyan-400 flex items-center gap-1.5"><Hash className="w-3.5 h-3.5" /> On-Chain {data.kind} Proof</span>
                {data.txHashes?.length > 0 && <span className="text-[10px] text-slate-400">Click any hash below to inspect</span>}
              </div>
              {data.txHashes?.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[10px] text-slate-400">Transactions in Block #{data.height}:</div>
                  {data.txHashes.map(h => <button key={h} type="button" onClick={() => runSearch(h)} className="block w-full text-left truncate px-2 py-1 rounded bg-slate-900 hover:bg-cyan-950/40 text-cyan-300 text-[11px]">{h}</button>)}
                </div>
              )}
              <pre className="text-[11px] text-slate-200 whitespace-pre-wrap break-all max-h-72 overflow-y-auto bg-slate-900/80 p-3 rounded-lg border border-slate-800">{JSON.stringify(data, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}