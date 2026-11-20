import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import { 
  Server, 
  RotateCw, 
  CheckCircle2, 
  Layers, 
  Activity, 
  ShieldCheck, 
  ExternalLink, 
  Radio 
} from 'lucide-react';

export default function BlockchainSyncModal() {
  const { network, user, refreshNetwork, setActiveModal, addToast } = useGame();
  
  const [nodeUrl, setNodeUrl] = useState(network.daemonAddress || 'http://127.0.0.1:48081');
  const [updating, setUpdating] = useState(false);

  const handleUpdateNode = async () => {
    try {
      setUpdating(true);
      const res = await fetch('/api/network/set-node', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user?.token || ''}`
        },
        body: JSON.stringify({ nodeUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`Connected to Numista Node: ${nodeUrl}`, 'success');
      await refreshNetwork();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setUpdating(false);
    }
  };

  const sync = network.syncStatus || {};

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-cyan-500/40 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-cyan-950/60 via-slate-900 to-[#161d2a] border-b border-cyan-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center text-white shadow-lg border border-cyan-300">
              <Radio className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-cyan-400 bg-cyan-950 border border-cyan-700/60 px-2 py-0.5 rounded">
                  Numista Cryptonote Daemon
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {network.nettype || 'testnet'}
                </span>
              </div>
              <h2 className="text-xl font-bold text-white mt-1">Online Blockchain Synchronization</h2>
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

          {/* Sync Status Banner */}
          <div className="p-5 rounded-2xl bg-gradient-to-br from-cyan-950/20 via-slate-900 to-slate-900 border border-slate-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono uppercase text-slate-400">Sync Status</span>
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-mono font-bold flex items-center space-x-1 ${
                network.online ? 'bg-emerald-950 text-emerald-400 border border-emerald-700' : 'bg-amber-950 text-amber-400 border border-amber-700'
              }`}>
                <span className={`w-2 h-2 rounded-full mr-1.5 ${network.online ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
                {network.online ? '100% SYNCHRONIZED' : 'CONNECTING TO BLOCKCHAIN...'}
              </span>
            </div>

            {/* Height Progress */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-400">Current Block Height:</span>
                <span className="text-white font-bold text-base">#{network.height || 115}</span>
              </div>
              <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
                <div className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full w-full rounded-full"></div>
              </div>
            </div>

            {/* Top Block Hash */}
            <div className="pt-2 border-t border-slate-800/80 text-[11px] font-mono text-slate-400 space-y-1">
              <div>Top Block Hash:</div>
              <div className="text-slate-200 bg-slate-950 p-2 rounded border border-slate-800 break-all select-all">
                {network.topBlockHash || 'f576b2c020ab988f517af17a0266b53dd343f4f8995773afb98ae7ce2aae9386'}
              </div>
            </div>
          </div>

          {/* Network Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">NETWORK DIFFICULTY</span>
              <span className="text-base font-bold text-white mt-0.5 block">
                {network.difficulty?.toLocaleString() || '15,719'}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">TX POOL SIZE</span>
              <span className="text-base font-bold text-cyan-400 mt-0.5 block">
                {network.txPoolSize ?? network?.details?.network?.txPoolSize ?? 0}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">DAEMON VERSION</span>
              <span className="text-sm font-bold text-white mt-0.5 block truncate">
                {network.version || network?.details?.network?.version || network?.details?.version?.result?.version || '—'}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800">
              <span className="text-slate-400 block text-[10px]">TARGET BLOCK TIME</span>
              <span className="text-base font-bold text-cyan-400 mt-0.5 block">
                {network.target || 120}s
              </span>
            </div>
          </div>

          {/* Extended RPC details (daemon/wallet-rpc commands) */}
          {network.details && (
            <div className="p-4 rounded-xl bg-slate-900/50 border border-slate-800 space-y-3 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-bold flex items-center gap-2"><Activity className="w-3.5 h-3.5 text-cyan-400" /> Extended Numista RPC Status</span>
                <span className="text-[10px] text-slate-500">daemon + wallet-rpc coverage</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex justify-between gap-2">
                  <span className="text-slate-400">Hard Fork</span>
                  <span className="text-white text-right">v{network.details?.hardFork?.version ?? '—'} ({network.details?.hardFork?.state ?? '—'})</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex justify-between gap-2">
                  <span className="text-slate-400">Fee (default)</span>
                  <span className="text-white text-right">{network.details?.fee?.fee ? `${(network.details.fee.fee / 1e12).toFixed(8)} NUM` : '—'}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex justify-between gap-2">
                  <span className="text-slate-400">Sync (RPC)</span>
                  <span className="text-white text-right">{network.details?.syncInfo?.height ?? network.height ?? '—'} / {network.details?.syncInfo?.target_height || network.height || '—'}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex justify-between gap-2">
                  <span className="text-slate-400">Peers (white/gray)</span>
                  <span className="text-white text-right">{(network.details?.peers?.whitelist || []).length} / {(network.details?.peers?.graylist || []).length}</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex justify-between gap-2">
                  <span className="text-slate-400">TxPool (stats)</span>
                  <span className="text-white text-right">{network.details?.txPoolStats?.tx_count ?? network.details?.txPoolStats?.num_txs ?? 0} txs</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-800 flex justify-between gap-2">
                  <span className="text-slate-400">Mining Status</span>
                  <span className={`${network.details?.miningStatus?.active ? 'text-emerald-400' : 'text-slate-300'} text-right`}>{network.details?.miningStatus?.active ? 'active' : (network.details?.miningStatus?.status || 'inactive/unavailable')}</span>
                </div>
              </div>
              <div className="text-[10px] text-slate-500">
                Additional RPC endpoints are exposed by the server for blocks, headers, tx pool, fees, peers, connections, version, hard fork, and wallet-rpc account/address/height/validation/refresh.
              </div>
            </div>
          )}

          {/* Connect / Change Node URL */}
          <div className="space-y-3 p-4 rounded-xl bg-slate-900/40 border border-slate-800">
            <label className="text-xs text-slate-300 font-mono block font-bold">
              Numista Daemon RPC Endpoint:
            </label>
            <div className="flex space-x-2">
              <input
                type="text"
                value={nodeUrl}
                onChange={(e) => setNodeUrl(e.target.value.trim())}
                placeholder="http://127.0.0.1:48081 or http://remote-node:48081"
                className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs font-mono text-white focus:outline-none focus:border-cyan-500"
              />
              <button
                onClick={handleUpdateNode}
                disabled={updating}
                className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-bold text-xs shadow-md transition-colors flex items-center space-x-1"
              >
                <RotateCw className={`w-3.5 h-3.5 ${updating ? 'animate-spin' : ''}`} />
                <span>Sync</span>
              </button>
            </div>
            <span className="text-[10px] text-slate-500 font-mono block">
              Default: Local offline testnet node (<code className="text-slate-400">http://127.0.0.1:48081</code>). Can connect to any public or private Numista daemon.
            </span>
          </div>

        </div>

      </div>
    </div>
  );
}
