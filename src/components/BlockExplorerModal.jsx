import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import {
  Search,
  Database,
  Layers,
  Clock,
  CheckCircle2,
  Cpu,
  ArrowRight,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  FileCode,
  Zap
} from 'lucide-react';

export default function BlockExplorerModal() {
  const { setActiveModal } = useGame();
  const [status, setStatus] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [txDetails, setTxDetails] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [searching, setSearching] = useState(false);

  const fetchExplorerData = async () => {
    try {
      setLoading(true);
      const [statusRes, blocksRes] = await Promise.all([
        fetch('/api/explorer/status'),
        fetch('/api/explorer/latest-blocks?count=10')
      ]);

      if (statusRes.ok) setStatus(await statusRes.json());
      if (blocksRes.ok) {
        const data = await blocksRes.json();
        setBlocks(data.blocks || []);
      }
    } catch {
      // Non-critical
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExplorerData();
    const interval = setInterval(fetchExplorerData, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleSearch = async (e) => {
    e?.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;

    setSearching(true);
    setSearchError(null);
    setTxDetails(null);

    try {
      if (/^[a-f0-9]{64}$/i.test(query)) {
        // Search as Transaction Hash
        const res = await fetch(`/api/explorer/tx/${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = await res.json();
          setTxDetails({ type: 'tx', data });
          return;
        }
        // Fallback: search as Block Hash
        const blockRes = await fetch(`/api/explorer/block/${encodeURIComponent(query)}`);
        if (blockRes.ok) {
          const bData = await blockRes.json();
          setTxDetails({ type: 'block', data: bData });
          return;
        }
        throw new Error('Hash not found in mempool or blockchain history');
      } else if (/^\d+$/.test(query)) {
        // Search as Block Height
        const blockRes = await fetch(`/api/explorer/block/${encodeURIComponent(query)}`);
        if (blockRes.ok) {
          const bData = await blockRes.json();
          setTxDetails({ type: 'block', data: bData });
          return;
        }
        throw new Error(`Block #${query} not found on chain`);
      } else {
        throw new Error('Enter a valid 64-hex transaction/block hash or integer block height');
      }
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#121824] border border-cyan-500/40 w-full max-w-4xl max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="p-5 bg-gradient-to-r from-cyan-950/60 via-slate-900 to-[#121824] border-b border-cyan-500/30 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 flex items-center justify-center text-white shadow-lg border border-cyan-300">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-cyan-400 bg-cyan-950 border border-cyan-800/60 px-2 py-0.5 rounded">
                  Numista Blockchain Explorer
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {status?.nettype || 'unknown network'}
                </span>
              </div>
              <h2 className="text-xl font-black text-white mt-0.5">On-Chain Ledger & Proofs</h2>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={fetchExplorerData}
              disabled={loading}
              className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
              title="Refresh ledger"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => setActiveModal(null)}
              className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="p-4 bg-slate-900/80 border-b border-slate-800">
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5" />
              <input
                type="text"
                placeholder="Search transaction hash (tx_extra deed), block hash, or block height..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-slate-950 border border-slate-700/80 rounded-xl text-xs font-mono text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={searching || !searchQuery.trim()}
              className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl transition-colors font-mono flex items-center space-x-1.5"
            >
              <span>LOOKUP</span>
            </button>
          </form>

          {searchError && (
            <div className="mt-2 text-xs font-mono text-rose-400 bg-rose-950/40 border border-rose-900/60 p-2 rounded-lg">
              {searchError}
            </div>
          )}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          
          {/* Telemetry Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-slate-400 flex items-center space-x-1">
                <Layers className="w-3 h-3 text-cyan-400" />
                <span>Chain Height</span>
              </span>
              <div className="text-xl font-bold font-mono text-white mt-1">
                #{status?.height?.toLocaleString() ?? '...'}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-slate-400 flex items-center space-x-1">
                <Cpu className="w-3 h-3 text-amber-400" />
                <span>Difficulty</span>
              </span>
              <div className="text-xl font-bold font-mono text-amber-300 mt-1">
                {status?.difficulty?.toLocaleString() ?? '...'}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-slate-400 flex items-center space-x-1">
                <Zap className="w-3 h-3 text-emerald-400" />
                <span>Mempool</span>
              </span>
              <div className="text-xl font-bold font-mono text-emerald-400 mt-1">
                {status?.txPoolCount ?? 0} <span className="text-xs text-slate-500 font-normal">txs</span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-900/70 border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-slate-400 flex items-center space-x-1">
                <ShieldCheck className="w-3 h-3 text-cyan-400" />
                <span>P2P Peers</span>
              </span>
              <div className="text-xl font-bold font-mono text-cyan-300 mt-1">
                {status?.peerCount ?? 0} <span className="text-xs text-slate-500 font-normal">nodes</span>
              </div>
            </div>
          </div>

          {/* Searched Item Inspector Modal */}
          {txDetails && (
            <div className="p-4 rounded-xl bg-cyan-950/20 border border-cyan-500/40 space-y-3 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-cyan-500/20 pb-2">
                <span className="text-xs font-mono font-bold text-cyan-400 uppercase flex items-center space-x-1.5">
                  <FileCode className="w-4 h-4" />
                  <span>{txDetails.type === 'tx' ? 'Transaction Proof' : 'Block Header'}</span>
                </span>
                <button
                  onClick={() => setTxDetails(null)}
                  className="text-xs font-mono text-slate-400 hover:text-white"
                >
                  Clear Inspection ✕
                </button>
              </div>

              {txDetails.type === 'tx' ? (
                <div className="space-y-2 text-xs font-mono">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <span className="text-slate-400">Transaction Hash:</span>
                    <span className="text-cyan-300 break-all">{txDetails.data.txHash}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Block Inclusion:</span>
                    <span className="text-white">
                      {txDetails.data.blockHeight ? `#${txDetails.data.blockHeight}` : 'In Mempool (Pending)'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Confirmations:</span>
                    <span className="text-emerald-400 font-bold">{txDetails.data.confirmations || 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Fee:</span>
                    <span className="text-slate-300">{(txDetails.data.fee / 1e12).toFixed(6)} NUM</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Block Height:</span>
                    <span className="text-white font-bold">#{txDetails.data.height}</span>
                  </div>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <span className="text-slate-400">Block Hash:</span>
                    <span className="text-cyan-300 break-all">{txDetails.data.hash}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Reward:</span>
                    <span className="text-amber-300">{txDetails.data.reward} NUM</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Transactions Count:</span>
                    <span className="text-white">{txDetails.data.txHashes?.length || 0}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Latest Mined Blocks Table */}
          <div className="space-y-2">
            <h3 className="text-xs font-mono font-bold uppercase text-slate-400 tracking-wider">
              Recent On-Chain Blocks
            </h3>
            
            <div className="rounded-xl border border-slate-800 overflow-hidden">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="p-3">Height</th>
                    <th className="p-3">Hash</th>
                    <th className="p-3">Difficulty</th>
                    <th className="p-3">Txs</th>
                    <th className="p-3 text-right">Reward</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 bg-slate-950/40">
                  {blocks.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="p-6 text-center text-slate-500">
                        {loading ? 'Loading blockchain history...' : 'No blocks reported yet'}
                      </td>
                    </tr>
                  ) : (
                    blocks.map((b) => (
                      <tr 
                        key={b.hash} 
                        onClick={() => {
                          setSearchQuery(b.hash);
                          handleSearch();
                        }}
                        className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                      >
                        <td className="p-3 font-bold text-cyan-400">#{b.height}</td>
                        <td className="p-3 text-slate-300 font-mono">
                          {b.hash.slice(0, 10)}...{b.hash.slice(-8)}
                        </td>
                        <td className="p-3 text-amber-300/90">{b.difficulty.toLocaleString()}</td>
                        <td className="p-3 text-slate-300">{b.numTxes}</td>
                        <td className="p-3 text-right text-emerald-400 font-semibold">{b.reward} NUM</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
