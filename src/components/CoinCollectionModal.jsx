import React, { useEffect, useState } from 'react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { buildingSprite } from './sprites';
import { Coins, X, RefreshCw } from 'lucide-react';

const rarityStyle = {
  mythic: 'border-fuchsia-500/50 bg-fuchsia-950/30 text-fuchsia-200',
  ultra_rare: 'border-amber-500/50 bg-amber-950/30 text-amber-200',
  rare: 'border-sky-500/50 bg-sky-950/30 text-sky-200',
  uncommon: 'border-emerald-500/50 bg-emerald-950/30 text-emerald-200',
  common: 'border-slate-700 bg-slate-950 text-slate-200'
};

export default function CoinCollectionModal() {
  const { user, setActiveModal } = useGame();
  const [coins, setCoins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [gameCoinBalance, setGameCoinBalance] = useState(0);

  const loadCoins = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/mints/my-coins', {
        headers: { Authorization: `Bearer ${user?.token || ''}` }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load your coin collection');
      setCoins(data.coins || []);
      setGameCoinBalance(Number(data.gameCoinBalance || 0));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadCoins(); }, [user?.token]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop">
      <section className="game-modal-panel w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl flex flex-col">
        <header className="game-modal-header flex items-center justify-between p-5">
          <div className="flex items-center gap-3"><Coins className="w-6 h-6 text-yellow-300" /><div><h2 className="text-lg font-black text-white">Coin Collection</h2><p className="text-xs text-slate-400">Your struck coinage, serials, rarity and game treasury</p><p className="text-xs text-amber-300">Available minted coins for army wages: {gameCoinBalance.toFixed(4)} NUM value</p></div></div>
          <div className="flex gap-2">
            <button onClick={loadCoins} className="game-modal-close" aria-label="Refresh"><RefreshCw className="w-4 h-4" /></button>
            <button onClick={() => setActiveModal(null)} className="game-modal-close" aria-label="Close"><X className="w-4 h-4" /></button>
          </div>
        </header>
        <div className="overflow-y-auto p-4 space-y-2">
          {loading ? <p className="py-10 text-center text-sm text-slate-400">Loading coin collection…</p> : null}
          {!loading && error ? <p className="p-4 rounded-xl bg-rose-950/30 text-sm text-rose-300">{error}</p> : null}
          {!loading && !error && coins.length === 0 ? <p className="py-10 text-center text-sm text-slate-400">No coins struck yet. Visit a Royal Mint plot to begin your collection.</p> : null}
          {!loading && coins.map((coin, index) => (
            <article key={coin.serial || index} className={`p-3 rounded-xl border ${rarityStyle[coin.badge] || rarityStyle.common} flex flex-wrap items-center justify-between gap-3`}>
              <div className="flex items-center gap-3">{buildingSprite({ type: `${coin.metal}_coin` }) ? <GameSprite sprite={buildingSprite({ type: `${coin.metal}_coin` })} className="game-art--small" /> : <Coins className="w-8 h-8 text-amber-400 shrink-0" />}<div><div className="font-bold text-sm">{coin.year} {coin.name} <span className="text-[10px] uppercase opacity-80">· {coin.rarity} · {coin.collectorMult}×</span></div><div className="mt-1 text-xs opacity-80">{coin.ruler} · {coin.weightGrams}g · {(Number(coin.purity) * 100).toFixed(2)}% {coin.metal}</div></div></div>
              <code className="px-2 py-1 rounded bg-black/30 text-[10px] select-all">{coin.serial}</code>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
