import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { Pickaxe, Radio, Server, ShieldCheck, Copy, Check, Power, PowerOff } from 'lucide-react';

export default function BrowserMinerModal() {
  const {
    isMining,
    miningMode,
    setMiningMode,
    stratumEndpoint,
    setStratumEndpoint,
    stratumStatus,
    setStratumStatus,
    startMining,
    stopMining,
    user,
    sessionHeaders,
    setActiveModal,
    addToast
  } = useGame();

  const [receiveAddr, setReceiveAddr] = useState('');
  const [accountIndex, setAccountIndex] = useState(null);
  const [copiedCmd, setCopiedCmd] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch('/api/wallet/receive', { headers: sessionHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (mounted) {
            setReceiveAddr(data.address || '');
            setAccountIndex(data.accountIndex ?? null);
          }
        }
      } catch {}
      try {
        const sRes = await fetch('/api/mining/stratum/status?username=' + encodeURIComponent(user?.username || ''));
        if (sRes.ok) {
          const sData = await sRes.json();
          if (mounted && sData.connected) {
            setStratumStatus(sData);
            if (!stratumEndpoint && sData.poolHost) setStratumEndpoint(`${sData.poolHost}:${sData.poolPort}`);
          }
        }
      } catch {}
    })();
    return () => { mounted = false; };
  }, [user?.username]);

  const copyText = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopiedCmd(key);
    addToast('Copied to clipboard', 'success');
    setTimeout(() => setCopiedCmd(''), 2000);
  };

  const xmrigPoolCmd = `xmrig -o ${stratumEndpoint || 'pool.numista.local:3333'} -u ${receiveAddr || '<YOUR_SB_ADDRESS>'}.${user?.username || 'worker1'} -p x -a rx/0`;
  const xmrigSoloCmd = `xmrig -o 127.0.0.1:48081 --daemon -u ${receiveAddr || '<YOUR_SB_ADDRESS>'} -a rx/0`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <div className="bg-[#161d2a] border border-orange-500/40 w-full max-w-lg max-h-[88vh] rounded-2xl shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="p-4 bg-gradient-to-r from-orange-950/60 via-slate-900 to-[#161d2a] border-b border-orange-500/30 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-white border border-orange-400/50 ${isMining ? 'bg-orange-600 animate-pulse' : 'bg-slate-800 text-slate-400'}`}>
              <Pickaxe className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-mono uppercase font-bold text-orange-400">RandomX (rx/0) Native Mining</span>
              <h2 className="text-lg font-black text-white leading-tight">External Stratum & Solo Miner</h2>
            </div>
          </div>
          <button onClick={() => setActiveModal(null)} className="text-slate-400 hover:text-white px-2.5 py-1 rounded-lg hover:bg-slate-800">✕</button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Mode Switcher */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800">
            <button
              disabled={isMining}
              onClick={() => setMiningMode('pplns')}
              className={`py-2 rounded-lg text-xs font-bold transition-all ${miningMode === 'pplns' ? 'bg-orange-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
            >
              External PPLNS Pool
            </button>
            <button
              disabled={isMining}
              onClick={() => setMiningMode('solo')}
              className={`py-2 rounded-lg text-xs font-bold transition-all ${miningMode === 'solo' ? 'bg-amber-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
            >
              Solo Mode (100% Direct)
            </button>
          </div>

          {/* Player Native Payout Address */}
          <div className="p-3 rounded-xl bg-slate-900/90 border border-slate-800 space-y-1">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
              <span className="flex items-center gap-1 text-emerald-400"><ShieldCheck className="w-3.5 h-3.5" /> Native Payout Wallet (Account #{accountIndex ?? '…'})</span>
              <button onClick={() => copyText('addr', receiveAddr)} className="text-slate-300 hover:text-white flex items-center gap-1">
                {copiedCmd === 'addr' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />} Copy
              </button>
            </div>
            <div className="font-mono text-[11px] text-slate-200 break-all bg-slate-950 p-2 rounded-lg border border-slate-800/80">
              {receiveAddr || 'Loading player native Sb... address...'}
            </div>
          </div>

          {miningMode === 'pplns' ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">External PPLNS Stratum Pool (`host:port`)</label>
                <input
                  type="text"
                  disabled={isMining}
                  value={stratumEndpoint}
                  onChange={(e) => setStratumEndpoint(e.target.value)}
                  placeholder="e.g. ://example.com"
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm font-mono text-white focus:outline-none focus:border-orange-500"
                />
              </div>

              {stratumStatus?.connected && (
                <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-500/40 text-xs font-mono space-y-1">
                  <div className="flex items-center justify-between text-emerald-400 font-bold">
                    <span className="flex items-center gap-1.5"><Radio className="w-3.5 h-3.5 animate-pulse" /> Stratum Connected</span>
                    <span>Height #{stratumStatus.height || '—'}</span>
                  </div>
                  <div className="text-slate-300">Pool: {stratumStatus.poolHost}:{stratumStatus.poolPort}</div>
                  <div className="text-slate-400 truncate">Job ID: {stratumStatus.jobId || 'Waiting for job…'}</div>
                </div>
              )}

              <button
                onClick={() => (isMining ? stopMining() : startMining())}
                className={`w-full py-2.5 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all ${
                  isMining
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white shadow-lg'
                }`}
              >
                {isMining ? <><PowerOff className="w-4 h-4" /> Disconnect Stratum Pool</> : <><Power className="w-4 h-4" /> Connect to PPLNS Stratum Pool</>}
              </button>

              <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
Use code with caution.
 XMRig Pool Rig Command
<button onClick={() => copyText('pool', xmrigPoolCmd)} className="text-slate-300 hover:text-white flex items-center gap-1">
{copiedCmd === 'pool' ?  : } Copy


{xmrigPoolCmd}


) : (


100% Direct Solo Block Rewards
Point XMRig directly at a Numista daemon with your isolated player address below. Every block found pays 100% of the coinbase reward directly into your Account #{accountIndex ?? '…'} on-chain.
XMRig Solo Daemon Command (rx/0)
<button onClick={() => copyText('solo', xmrigSoloCmd)} className="text-slate-300 hover:text-white flex items-center gap-1">
{copiedCmd === 'solo' ?  : } Copy


{xmrigSoloCmd}


)}



);
}