import React from 'react';
import { User, X, MapPin, Crown, Coins, ShieldCheck } from 'lucide-react';
import GameSprite from './GameSprite';
import { treasureSprite } from './sprites';
import { useGame } from '../context/GameContext';

export default function AccountModal() {
  const { user, wallet, network, setActiveModal } = useGame();
  const links = [
    { key: 'deeds', label: 'My Deeds', detail: 'Settlements, plots, income and resources', icon: MapPin, color: 'text-orange-300' },
    { key: 'peerage', label: 'Peerage', detail: 'Title and recruitment access', icon: Crown, color: 'text-amber-300' },
    { key: 'coins', label: 'Coin Collection', detail: 'Minted coins and serial numbers', icon: Coins, color: 'text-yellow-300' },
    { key: 'army', label: 'Army', detail: 'Recruit and command your soldiers', icon: ShieldCheck, color: 'text-rose-300' },
    { key: 'castles', label: 'Frontier Castles', detail: 'Besiege and capture abandoned deeds', icon: ShieldCheck, color: 'text-red-300' }
  ];

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop">
    <section className="game-modal-panel w-full max-w-lg rounded-2xl overflow-y-auto">
      <header className="game-modal-header flex items-center justify-between p-5">
        <div className="flex items-center gap-3"><GameSprite sprite={treasureSprite('signet_ring')} className="game-art--small" /><div><h2 className="text-lg font-black text-white">Account</h2><p className="text-xs text-slate-400">{user?.title ? <><span className="text-amber-300">{user.title.split(' / ')[0]}</span> · </> : null}@{user?.username}</p></div></div>
        <button onClick={() => setActiveModal(null)} className="game-modal-close" aria-label="Close"><X className="w-4 h-4" /></button>
      </header>
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-slate-900 p-4"><div className="text-[10px] uppercase text-slate-400">NUM Balance</div><div className="mt-1 text-xl font-black font-mono text-orange-300">{Number(wallet?.balance || 0).toFixed(4)}</div></div>
          <div className="rounded-xl bg-slate-900 p-4"><div className="text-[10px] uppercase text-slate-400">Chain</div><div className="mt-1 text-sm font-bold text-cyan-300">{network?.nettype || 'Numista'}</div><div className="text-xs text-slate-500">Block #{network?.height || 0}</div></div>
        </div>
        <div className="space-y-2">
          {links.map(({ key, label, detail, icon: Icon, color }) => <button key={key} onClick={() => setActiveModal(key)} className="w-full flex items-center gap-3 p-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left">
            <Icon className={`w-5 h-5 ${color}`} /><span className="flex-1"><span className="block text-sm font-semibold text-white">{label}</span><span className="block text-xs text-slate-400">{detail}</span></span><span className="text-slate-500">›</span>
          </button>)}
        </div>
      </div>
    </section>
  </div>;
}
