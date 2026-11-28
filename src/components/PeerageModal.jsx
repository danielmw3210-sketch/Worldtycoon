import React, { useEffect, useState } from 'react';
import { Crown, X } from 'lucide-react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { townSprite } from './sprites';

const titles = [
  { key: 'baron', name: 'Baron / Baroness', price: 10 },
  { key: 'viscount', name: 'Viscount / Viscountess', price: 25 },
  { key: 'earl', name: 'Earl / Countess', price: 50 },
  { key: 'marquess', name: 'Marquess / Marchioness', price: 100 },
  { key: 'duke', name: 'Duke / Duchess', price: 250 },
  { key: 'elector', name: 'Sovereign Elector', price: 500 }
];

export default function PeerageModal() {
  const { user, setUser, setActiveModal, watchJob, refreshWallet, addToast } = useGame();
  const [buying, setBuying] = useState(false);
  const current = user?.title || null;

  useEffect(() => {
    if (!user?.token) return;
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${user.token}` } })
      .then(response => response.ok ? response.json() : null)
      .then(me => {
        if (!me) return;
        const updated = { ...user, role: me.role || user.role, title: me.title || null };
        setUser(updated);
        localStorage.setItem('goldnumista_user', JSON.stringify(updated));
      })
      .catch(() => {});
  }, [user?.username, user?.token]);

  const buyTitle = async key => {
    if (buying) return;
    setBuying(true);
    try {
      const response = await fetch('/api/titles/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` },
        body: JSON.stringify({ titleKey: key })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Peerage purchase failed');
      addToast('Peerage payment submitted. It will appear after chain confirmation.', 'info');
      const job = await watchJob(data.job?.id);
      if (job?.status !== 'confirmed') return;

      const meResponse = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${user?.token || ''}` } });
      const me = meResponse.ok ? await meResponse.json() : null;
      const updated = { ...user, title: me?.title || data.title };
      setUser(updated);
      localStorage.setItem('goldnumista_user', JSON.stringify(updated));
      await refreshWallet();
      addToast(`${updated.title} granted to @${user.username}.`, 'success');
      setActiveModal('army');
    } catch (error) {
      addToast(error.message || 'Peerage purchase failed', 'error');
    } finally {
      setBuying(false);
    }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop">
    <section className="game-modal-panel w-full max-w-xl rounded-2xl overflow-hidden">
      <header className="game-modal-header flex items-center justify-between p-5">
        <div className="flex items-center gap-3"><GameSprite sprite={townSprite('throne_hall')} className="game-art--small" /><div><h2 className="text-lg font-black text-white">Peerage</h2><p className="text-xs text-slate-400">Your title appears beside @{user?.username} and unlocks recruitment.</p></div></div>
        <button onClick={() => setActiveModal(null)} className="game-modal-close" aria-label="Close"><X className="w-4 h-4" /></button>
      </header>
      <div className="p-5 space-y-4">
        <div className="rounded-xl bg-slate-900 p-4 text-sm text-slate-300">Current title: <strong className="text-amber-300">{current || 'None yet'}</strong></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {titles.map(title => <button key={title.key} disabled={buying || !!current} onClick={() => buyTitle(title.key)} className="flex justify-between items-center p-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-amber-500/50 disabled:opacity-50 text-left">
            <span className="text-sm font-semibold text-slate-100">{title.name}</span><span className="text-xs font-mono text-amber-300">{title.price} NUM</span>
          </button>)}
        </div>
      </div>
    </section>
  </div>;
}
