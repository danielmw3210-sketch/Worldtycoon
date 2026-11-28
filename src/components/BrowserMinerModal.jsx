import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { treasureSprite } from './sprites';
export default function BrowserMinerModal() {
  const { network, isMining, hashrate, sharesSubmitted, threads, setThreads, miningMode, setMiningMode, stratumEndpoint, setStratumEndpoint, stratumStatus, setStratumStatus, startMining, stopMining, user, setActiveModal, addToast } = useGame();
  const [receiveAddr, setReceiveAddr] = useState('');
  const [accountIndex, setAccountIndex] = useState(null);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    let ok = true;
    fetch('/api/wallet/receive?username=' + encodeURIComponent(user?.username || ''), { headers: user?.token ? { Authorization: 'Bearer ' + user.token } : {} }).then(r => r.ok ? r.json() : null).then(d => { if (ok && d) { setReceiveAddr(d.address || ''); setAccountIndex(d.accountIndex ?? null); } }).catch(() => {});
    fetch('/api/mining/stratum/status?username=' + encodeURIComponent(user?.username || '')).then(r => r.ok ? r.json() : null).then(s => { if (ok && s?.connected) { setStratumStatus(s); if (!stratumEndpoint && s.poolHost) setStratumEndpoint(s.poolHost + ':' + s.poolPort); } }).catch(() => {});
    return () => { ok = false; };
  }, [user?.username]);
  const copy = (k, v) => { navigator.clipboard.writeText(v); setCopied(k); addToast('Copied', 'success'); setTimeout(() => setCopied(''), 2000); };
  const poolCmd = 'xmrig -o ' + (stratumEndpoint || 'pool.numista.local:3333') + ' -u ' + (receiveAddr || 'YOUR_SB_ADDRESS') + '.' + (user?.username || 'worker1') + ' -p x -a rx/0';
  const soloCmd = 'xmrig -o 127.0.0.1:48081 --daemon -u ' + (receiveAddr || 'YOUR_SB_ADDRESS') + ' -a rx/0';
  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md'>
      <div className='bg-[#161d2a] border border-orange-500/40 w-full max-w-lg max-h-[88vh] rounded-2xl shadow-2xl overflow-y-auto flex flex-col'>
        <div className='p-4 bg-slate-900 border-b border-orange-500/30 flex items-center justify-between'>
          <div className="flex items-center gap-3"><GameSprite sprite={treasureSprite('mining_rig')} className="game-art--large" /><div><span className='text-[10px] font-mono uppercase font-bold text-orange-400'>RandomX (rx/0) Native Mining</span><h2 className='text-lg font-black text-white'>External Stratum & Solo Miner</h2></div></div>
          <button onClick={() => setActiveModal(null)} className='text-slate-400 hover:text-white px-2.5 py-1 rounded-lg hover:bg-slate-800'>X</button>
        </div>
        <div className='p-4 space-y-4'><div className='grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-center font-mono text-[11px]'><div><div className='text-slate-400'>Daemon Height</div><div className='text-emerald-400 font-bold'>#{network?.height || '-'}</div></div><div><div className='text-slate-400'>Net Difficulty</div><div className='text-amber-300 font-bold'>{(network?.difficulty || 0).toLocaleString()}</div></div><div><div className='text-slate-400'>Daemon Status</div><div className='text-cyan-300 font-bold'>{network?.online ? 'ONLINE' : 'OFFLINE'}</div></div></div>
          <div className='grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800'>
            <button disabled={isMining} onClick={() => setMiningMode('pplns')} className={'py-2 rounded-lg text-xs font-bold ' + (miningMode === 'pplns' ? 'bg-orange-600 text-white' : 'text-slate-400')}>External PPLNS Pool</button>
            <button disabled={isMining} onClick={() => setMiningMode('solo')} className={'py-2 rounded-lg text-xs font-bold ' + (miningMode === 'solo' ? 'bg-amber-600 text-white' : 'text-slate-400')}>Solo Mode (100% Direct)</button>
          </div>
          <div className='p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1'>
            <div className='flex items-center justify-between text-[11px] font-mono text-emerald-400'><span>Native Payout Address (Account #{accountIndex ?? '...'})</span><button onClick={() => copy('addr', receiveAddr)} className='text-slate-300 hover:text-white'>{copied === 'addr' ? 'Copied' : 'Copy'}</button></div>
            <div className='font-mono text-[11px] text-slate-200 break-all bg-slate-950 p-2 rounded-lg border border-slate-800'>{receiveAddr || 'Loading player native Sb... address...'}</div>
          </div>
          {miningMode === 'pplns' ? (
            <div className='space-y-3'>
              <div><label className='block text-xs font-mono text-slate-300 mb-1'>External PPLNS Stratum Pool (host:port)</label><input type='text' disabled={isMining} value={stratumEndpoint} onChange={(e) => setStratumEndpoint(e.target.value)} placeholder='pool.example.com:3333' className='w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm font-mono text-white' /><p className='mt-1 text-xs text-amber-300'>The built-in pool is disabled; use a trusted external pool.</p></div>
              {stratumStatus?.connected && (<div className='p-3 rounded-xl bg-emerald-950/30 border border-emerald-500/40 text-xs font-mono space-y-1'><div className='flex justify-between text-emerald-400 font-bold'><span>Stratum Connected</span><span>Height #{stratumStatus.height || '-'}</span></div><div className='text-slate-300'>Pool: {stratumStatus.poolHost}:{stratumStatus.poolPort}</div><div className='flex justify-between text-amber-300 font-bold'><span>Hashrate: {hashrate.toLocaleString()} H/s</span><span>Accepted Shares: {stratumStatus.acceptedShares ?? sharesSubmitted}</span></div><div className='text-slate-400 truncate'>Job ID: {stratumStatus.jobId || 'Waiting...'}</div></div>)}
              <div className='flex items-center justify-between p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono'><span className='text-slate-300'>Browser CPU Threads:</span><div className='flex gap-1'>{[1, 2, 4, 8].map(n => <button key={n} type='button' disabled={isMining} onClick={() => setThreads(n)} className={'px-2.5 py-1 rounded-lg font-bold ' + (threads === n ? 'bg-orange-600 text-white' : 'bg-slate-800 text-slate-400')}>{n}x</button>)}</div></div><button onClick={() => (isMining ? stopMining() : startMining())} className={'w-full py-2.5 rounded-xl font-bold text-xs text-white ' + (isMining ? 'bg-rose-600 hover:bg-rose-500' : 'bg-orange-600 hover:bg-orange-500')}>{isMining ? 'Disconnect Stratum Pool' : 'Start PPLNS Pool Mining'}</button>
              <div className='p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1'><div className='flex justify-between text-[11px] font-mono text-slate-400'><span>XMRig Pool Rig Command</span><button onClick={() => copy('pool', poolCmd)} className='text-slate-300 hover:text-white'>{copied === 'pool' ? 'Copied' : 'Copy'}</button></div><pre className='text-[10px] font-mono text-amber-300 bg-slate-950 p-2 rounded-lg overflow-x-auto'>{poolCmd}</pre></div>
            </div>
          ) : (
            <div className='space-y-3'>
              <div className='p-3 rounded-xl bg-amber-950/30 border border-amber-500/40 text-xs text-slate-300 space-y-1'><div className='font-bold text-amber-300'>100% Direct Solo Block Rewards</div><p className='text-[11px] text-slate-400'>Point XMRig directly at a Numista daemon with your isolated player address below. Every block found pays 100% of the coinbase reward directly into your Account #{accountIndex ?? '...'} on-chain.</p></div>
              <div className='p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1'><div className='flex justify-between text-[11px] font-mono text-slate-400'><span>XMRig Solo Daemon Command (rx/0)</span><button onClick={() => copy('solo', soloCmd)} className='text-slate-300 hover:text-white'>{copied === 'solo' ? 'Copied' : 'Copy'}</button></div><pre className='text-[10px] font-mono text-emerald-300 bg-slate-950 p-2 rounded-lg overflow-x-auto'>{soloCmd}</pre></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}