import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { 
  Pickaxe, 
  Cpu, 
  Zap, 
  Coins, 
  CheckCircle2, 
  Activity, 
  Flame, 
  Sliders, 
  ShieldCheck, 
  RotateCcw,
  Layers,
  Award,
  Radio
} from 'lucide-react';

export default function BrowserMinerModal() {
  const { 
    isMining, 
    threads, 
    setThreads, 
    hashrate, 
    totalHashes, 
    sharesSubmitted, 
    minedSessionNum, 
    startMining, 
    stopMining, 
    wallet,
    network,
    user,
    setActiveModal
  } = useGame();

  const [poolStats, setPoolStats] = useState(null);
  const maxCores = navigator.hardwareConcurrency || 8;

  useEffect(() => {
    let mounted = true;
    const fetchStats = async () => {
      try {
        const username = user?.username ? encodeURIComponent(user.username) : '';
        const res = await fetch(`/api/mining/stats?username=${username}`);
        if (res.ok) {
          const data = await res.json();
          if (mounted) setPoolStats(data);
        }
      } catch {
        // Non-critical
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [user?.username]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-orange-500/40 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-orange-950/60 via-slate-900 to-[#161d2a] border-b border-orange-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-lg border border-orange-300 transition-all ${
              isMining 
                ? 'bg-gradient-to-tr from-orange-600 to-amber-500 shadow-orange-500/50 animate-pulse' 
                : 'bg-slate-800 text-slate-400'
            }`}>
              <Pickaxe className={`w-6 h-6 ${isMining ? 'animate-bounce' : ''}`} />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-orange-400 bg-orange-950 border border-orange-700/60 px-2 py-0.5 rounded">
                  Web Worker Proof-of-Work
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  RandomX-Lite WASM/Worker
                </span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1">Numista In-Browser Miner</h2>
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

          {/* Primary Telemetry Display */}
          <div className="p-6 rounded-2xl bg-gradient-to-br from-orange-950/30 via-slate-900 to-slate-900 border border-orange-500/30 grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
            
            {/* Hashrate */}
            <div className="space-y-1">
              <span className="text-xs text-slate-400 uppercase font-mono flex items-center justify-center space-x-1">
                <Activity className="w-3.5 h-3.5 text-orange-400" />
                <span>Hashrate</span>
              </span>
              <div className="text-4xl font-black font-mono text-white tracking-tight">
                {hashrate.toLocaleString()}
              </div>
              <span className="text-xs font-mono text-orange-400 font-semibold">Hashes / sec</span>
            </div>

            {/* Mined Coins in Session */}
            <div className="space-y-1 sm:border-x sm:border-slate-800 sm:px-4">
              <span className="text-xs text-slate-400 uppercase font-mono flex items-center justify-center space-x-1">
                <Coins className="w-3.5 h-3.5 text-amber-400" />
                <span>Session Mined</span>
              </span>
              <div className="text-4xl font-black font-mono text-amber-300 tracking-tight">
                +{minedSessionNum.toFixed(4)}
              </div>
              <span className="text-xs font-mono text-slate-400">NUM Credited</span>
            </div>

            {/* Accepted Proofs / Shares */}
            <div className="space-y-1">
              <span className="text-xs text-slate-400 uppercase font-mono flex items-center justify-center space-x-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>Valid Shares</span>
              </span>
              <div className="text-4xl font-black font-mono text-emerald-400 tracking-tight">
                {sharesSubmitted}
              </div>
              <span className="text-xs font-mono text-slate-400">Target Met</span>
            </div>

          </div>

          {/* Mining Controls & Hardware Threads */}
          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-4">
            
            {/* Status Notice */}
            <div className={`p-3 rounded-xl border text-xs font-mono flex items-center justify-between ${
              isMining 
                ? 'bg-orange-950/40 border-orange-500/50 text-orange-300' 
                : 'bg-slate-950 border-slate-800 text-slate-400'
            }`}>
              <span className="flex items-center">
                <span className={`w-2.5 h-2.5 rounded-full mr-2 ${isMining ? 'bg-orange-500 animate-ping' : 'bg-rose-500'}`}></span>
                Miner Status: <strong className={`ml-1 ${isMining ? 'text-orange-400' : 'text-slate-300'}`}>{isMining ? 'ACTIVE (Mining)' : 'OFF (Idle)'}</strong>
              </span>
              <span className="text-[11px] text-slate-500">
                {isMining ? 'Earning 0.05 NUM/share' : 'Turn ON to start hashing'}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Cpu className="w-4 h-4 text-orange-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
                  Hardware CPU Threads: {threads} / {maxCores}
                </span>
              </div>
              <span className="text-xs text-slate-400 font-mono">
                {threads === maxCores ? 'Maximum Load' : `${Math.round((threads/maxCores)*100)}% Capacity`}
              </span>
            </div>

            {/* Thread Slider */}
            <input
              type="range"
              min="1"
              max={maxCores}
              value={threads}
              disabled={isMining}
              onChange={(e) => setThreads(parseInt(e.target.value, 10))}
              className="w-full accent-orange-500 cursor-pointer disabled:opacity-50"
            />

            <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
              <span>Eco (1 Thread)</span>
              <span>Balanced ({Math.floor(maxCores / 2)} Threads)</span>
              <span>Full Rig ({maxCores} Threads)</span>
            </div>

            {/* Start / Stop Button */}
            <div className="pt-2">
              {!isMining ? (
                <button
                  onClick={startMining}
                  className="w-full py-3.5 rounded-xl bg-gradient-to-r from-orange-600 via-amber-600 to-orange-500 hover:from-orange-500 hover:to-amber-500 text-white font-extrabold text-sm shadow-xl shadow-orange-600/30 transition-all flex items-center justify-center space-x-2 transform active:scale-95"
                >
                  <Pickaxe className="w-5 h-5 text-white" />
                  <span>START BROWSER MINER</span>
                </button>
              ) : (
                <button
                  onClick={stopMining}
                  className="w-full py-3.5 rounded-xl bg-gradient-to-r from-rose-700 to-red-600 hover:from-rose-600 hover:to-red-500 text-white font-extrabold text-sm shadow-xl shadow-red-700/30 transition-all flex items-center justify-center space-x-2 transform active:scale-95"
                >
                  <Flame className="w-5 h-5 text-white animate-pulse" />
                  <span>PAUSE MINER</span>
                </button>
              )}
            </div>

          </div>

          {/* PPLNS Mining Pool Telemetry */}
          <div className="p-4 rounded-xl bg-slate-900/60 border border-orange-500/20 text-xs space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 flex items-center space-x-1.5">
                <Layers className="w-3.5 h-3.5 text-orange-400" />
                <span>Pool Scheme:</span>
              </span>
              <span className="font-mono font-bold text-orange-400 bg-orange-950/80 px-2 py-0.5 rounded border border-orange-800/50">
                {poolStats?.scheme || 'PPLNS'} (Pay-Per-Last-N-Shares)
              </span>
            </div>

            <div className="flex items-center justify-between text-slate-400">
              <span>PPLNS Rolling Window:</span>
              <span className="font-mono text-slate-200">
                {poolStats?.sharesInWindow ?? 0} / {poolStats?.pplnsWindowSize ?? 1000} shares
              </span>
            </div>

            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div 
                className="bg-gradient-to-r from-orange-500 to-amber-400 h-full transition-all duration-500"
                style={{ width: `${Math.min(100, ((poolStats?.sharesInWindow || 0) / (poolStats?.pplnsWindowSize || 1000)) * 100)}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800/80">
              <div className="flex items-center justify-between text-slate-400">
                <span>Your Pool Share:</span>
                <span className="font-mono font-bold text-amber-300">
                  {poolStats?.userPplns?.sharePct ?? 0}%
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-400">
                <span>Est. Round Payout:</span>
                <span className="font-mono font-bold text-emerald-400">
                  ~{poolStats?.userPplns?.estimatedBlockPayout ?? 0} NUM
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between text-slate-400 pt-1 border-t border-slate-800/60">
              <span className="flex items-center space-x-1">
                <Award className="w-3.5 h-3.5 text-amber-400" />
                <span>Round Bounty:</span>
              </span>
              <span className="font-mono text-white">
                {poolStats?.expectedBlockReward ?? 50} NUM ({poolStats?.blocksFound ?? 0} blocks solved)
              </span>
            </div>

            <div className="flex items-center justify-between text-slate-400 pt-1 border-t border-slate-800/60">
              <span className="flex items-center space-x-1">
                <Radio className="w-3.5 h-3.5 text-cyan-400" />
                <span>Native Blockchain:</span>
              </span>
              <span className="font-mono text-cyan-300">
                {poolStats?.connectedToNativeDaemon 
                  ? `Live Template (Height #${poolStats.nativeHeight})` 
                  : 'Daemon Standby'}
              </span>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
