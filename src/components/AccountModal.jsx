import React, { useEffect, useState } from 'react';
import { useGame } from '../context/GameContext';
import {
  User,
  MapPin,
  Building2,
  Landmark,
  Gavel,
  TrendingUp,
  ShieldCheck,
  Sparkles,
  Coins,
  ExternalLink,
  RefreshCw,
  Zap,
  Crown,
  Hammer
} from 'lucide-react';

const RARITY_COLORS = {
  common: '#94a3b8',
  uncommon: '#4ade80',
  rare: '#38bdf8',
  super_rare: '#a78bfa',
  epic: '#f472b6',
  legendary: '#fbbf24',
  mythic: '#fb7185',
  transcendent: '#22d3ee'
};

function buildingMeta(building) {
  const type = typeof building === 'string' ? building : building?.type;
  const category = typeof building === 'string' ? null : building?.category;

  if (category === 'utility') return { label: 'Utility', icon: Zap, color: 'text-sky-400', bg: 'bg-sky-500/10 border-sky-500/30' };
  if (category === 'resource') return { label: 'Resource', icon: Hammer, color: 'text-stone-300', bg: 'bg-stone-500/10 border-stone-500/30' };
  if (category === 'mint') return { label: 'Mint', icon: Crown, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' };
  if (category === 'leisure') return { label: 'Leisure', icon: Sparkles, color: 'text-pink-400', bg: 'bg-pink-500/10 border-pink-500/30' };
  if (category === 'housing') return { label: 'Housing', icon: Building2, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' };
  if (category === 'transport') return { label: 'Transport', icon: MapPin, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/30' };

  switch (type) {
    case 'town_hall': return { label: 'Town Hall', icon: Landmark, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' };
    case 'bank': return { label: 'Imperial Bank', icon: Landmark, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' };
    case 'auction_house': return { label: 'Auction House', icon: Gavel, color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/30' };
    case 'stock_broker': return { label: 'Stock Broker', icon: TrendingUp, color: 'text-cyan-400', bg: 'bg-cyan-500/10 border-cyan-500/30' };
    default: return { label: 'Open Lot', icon: Building2, color: 'text-slate-300', bg: 'bg-slate-700/20 border-slate-600/40' };
  }
}

function formatIncome(n) {
  const value = Number(n) || 0;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(4);
}


export default function AccountModal() {
  const {
    user,
    wallet,
    network,
    plots,
    setActiveModal,
    fetchAccount,
    refreshWallet,
    refreshPlots,
    collectIncome,
    setSelectedPlot,
    addToast
  } = useGame();

  const [accountData, setAccountData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collectingId, setCollectingId] = useState(null);

  const load = async () => {
    if (!user?.username) return;
    try {
      setLoading(true);
      const data = await fetchAccount(user.username);
      setAccountData(data);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.username, plots]);

  const deeds = (accountData?.deeds || []).slice().sort((a, b) => {
    const ao = a.nftState?.stage === 'onchain' ? 1 : 0;
    const bo = b.nftState?.stage === 'onchain' ? 1 : 0;
    return ao - bo || a.name.localeCompare(b.name);
  });

  const onChainCount = deeds.filter(d => d.nftState?.stage === 'onchain').length;
  const pendingCount = deeds.filter(d => d.nftState?.stage === 'pending').length;

  const handleCollect = async (plotId) => {
    try {
      setCollectingId(plotId);
      await collectIncome(plotId);
      await Promise.all([load(), refreshPlots(), refreshWallet()]);
    } catch (_) {
      // toast handled in context
    } finally {
      setCollectingId(null);
    }
  };

  if (!user) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
        <div className="bg-[#161d2a] border border-slate-700 rounded-2xl p-6 max-w-md w-full text-center space-y-3">
          <p className="text-slate-300 text-sm">Log in to view your account and deeds.</p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => setActiveModal('auth')} className="px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-bold">Log In</button>
            <button onClick={() => setActiveModal(null)} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm">Close</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-slate-700 w-full max-w-4xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">

        <div className="p-6 bg-gradient-to-r from-orange-950/40 via-slate-900 to-[#161d2a] border-b border-slate-800 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center text-white shadow-lg border border-orange-300">
              <User className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono uppercase font-bold text-orange-400 bg-orange-950 border border-orange-700/60 px-2 py-0.5 rounded">Account & Deed Registry</span>
                <span className="text-xs text-emerald-400 font-mono flex items-center">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5 animate-pulse"></span>
                  @{user.username}
                </span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1">My Account & Deeds</h2>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Wallet address kept private • Ownership shown by username</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={load}
              className="text-slate-300 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition-colors"
              title="Refresh account"
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

        <div className="p-6 overflow-y-auto space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <div className="text-[10px] font-mono uppercase text-slate-400">Wallet Balance</div>
              <div className="text-xl font-black font-mono text-orange-400 mt-1">{(wallet?.balance ?? 0).toFixed(4)} <span className="text-xs text-slate-400 font-normal">NUM</span></div>
              {(wallet?.pendingBalance || 0) > 0 && (
                <div className="text-[10px] font-mono text-amber-400 mt-0.5">+{(wallet.pendingBalance).toFixed(4)} pending</div>
              )}
            </div>
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <div className="text-[10px] font-mono uppercase text-slate-400">Claimed Deeds</div>
              <div className="text-xl font-black font-mono text-white mt-1">{deeds.length}</div>
            </div>
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <div className="text-[10px] font-mono uppercase text-slate-400">On-Chain Deeds</div>
              <div className="text-xl font-black font-mono text-emerald-400 mt-1">{onChainCount}</div>
              {pendingCount > 0 && <div className="text-[10px] font-mono text-amber-400 mt-0.5">{pendingCount} confirming</div>}
            </div>
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <div className="text-[10px] font-mono uppercase text-slate-400">Chain Height</div>
              <div className="text-xl font-black font-mono text-cyan-300 mt-1">#{network?.height || 0}</div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-xs font-mono space-y-1.5">
            <div className="flex justify-between gap-3"><span className="text-slate-400">Username</span><span className="text-white font-bold">@{user.username}</span></div>
            <div className="flex justify-between gap-3"><span className="text-slate-400">Chain Mode</span><span className="text-emerald-400">{network?.chain?.mode || 'unknown'} • {network?.chain?.ready ? 'ready' : 'unavailable'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-slate-400">Node / Network</span><span className="text-emerald-400">{network?.nettype || 'numista-testnet'} • {network?.online ? 'online' : 'offline'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-slate-400">Settlement</span><span className="text-slate-200">{network?.confirmationsRequired || 10} confirmations</span></div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-300 font-mono flex items-center gap-2">
                <MapPin className="w-4 h-4 text-orange-400" />
                Your Deeds & Properties
              </h3>
              <span className="text-xs text-slate-500 font-mono">{deeds.length} owned parcel{deeds.length === 1 ? '' : 's'}</span>
            </div>

            {loading ? (
              <div className="p-8 rounded-xl bg-slate-900/50 border border-slate-800 text-center text-slate-400 text-sm font-mono">Loading your deeds...</div>
            ) : deeds.length === 0 ? (
              <div className="p-8 rounded-xl bg-slate-900/50 border border-slate-800 text-center space-y-2">
                <div className="text-slate-300 font-semibold">No deeds claimed yet</div>
                <div className="text-xs text-slate-500 font-mono">Claim a plot on the UK map to register a deed to @{user.username}.</div>
                <button onClick={() => setActiveModal(null)} className="mt-2 px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold">Explore Map</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {deeds.map((plot) => {
                  const meta = buildingMeta(plot.building);
                  const Icon = meta.icon;
                  const onChain = plot.nftState?.stage === 'onchain';
                  const pending = plot.nftState?.stage === 'pending';
                  const legacy = plot.nftState?.stage === 'legacy_simulated';
                  const badge = pending
                    ? { label: 'MINT CONFIRMING', cls: 'bg-amber-950/60 text-amber-400 border-amber-700/50' }
                    : onChain
                      ? { label: 'ON-CHAIN DEED', cls: 'bg-emerald-950/60 text-emerald-400 border-emerald-700/50' }
                      : legacy
                        ? { label: 'LEGACY SIM', cls: 'bg-rose-950/40 text-rose-300 border-rose-800/50' }
                        : { label: 'DEED', cls: 'bg-slate-800 text-slate-300 border-slate-700' };
                  return (
                    <div key={plot.id} className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-mono text-slate-500">{plot.label || plot.id}</span>
                            <span
                              className="text-[10px] font-mono px-2 py-0.5 rounded border"
                              style={{
                                color: RARITY_COLORS[plot.rarityKey] || '#94a3b8',
                                borderColor: `${RARITY_COLORS[plot.rarityKey] || '#94a3b8'}80`,
                                backgroundColor: `${RARITY_COLORS[plot.rarityKey] || '#94a3b8'}1a`
                              }}
                            >
                              {plot.rarityName || 'Common'}
                            </span>
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${badge.cls}`}>
                              {badge.label}
                            </span>
                          </div>
                          <div className="font-bold text-white mt-1 truncate">{plot.name}</div>
                          <div className="text-xs text-slate-400 mt-0.5">{plot.region} • {plot.description}</div>
                        </div>
                        <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${meta.bg}`}>
                          <Icon className={`w-5 h-5 ${meta.color}`} />
                        </div>
                      </div>

                      <div className="text-xs space-y-1.5">
                        <div className="flex justify-between"><span className="text-slate-500">Building</span><span className="text-slate-200 font-medium">{plot.building?.name || meta.label}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Owner</span><span className="text-cyan-300 font-mono font-semibold">@{user.username}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Asset ID</span><span className="text-slate-300 font-mono truncate max-w-[60%] text-right" title={plot.assetId || ''}>{(plot.assetId || plot.nftState?.assetId || '—').slice(0, 18)}…</span></div>
                        {plot.nftState?.txHash && (
                          <div className="flex justify-between gap-2"><span className="text-slate-500">TX Hash</span><span className="text-emerald-300/90 font-mono truncate max-w-[60%] text-right">{plot.nftState.txHash}</span></div>
                        )}
                      </div>

                      {plot.building?.incomePerHour > 0 && (
                        <div className="text-xs space-y-1.5 border-t border-slate-800 pt-2">
                          <div className="flex justify-between">
                            <span className="text-slate-500">Income</span>
                            <span className="text-emerald-300 font-mono font-semibold">
                              {formatIncome(plot.building.incomePerHour)} NUM/h · L{plot.building.level}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-500">Uncollected</span>
                            <span className="text-orange-300 font-mono">{formatIncome(plot.building.stats?.accruedIncome)} NUM</span>
                          </div>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2 pt-1">
                        <button
                          onClick={() => { setSelectedPlot(plot); setActiveModal('plot_details'); }}
                          className="flex-1 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-orange-400" />
                          Inspect Deed
                        </button>
                        {plot.building?.incomePerHour > 0 && (
                          <button
                            onClick={() => handleCollect(plot.id)}
                            disabled={collectingId === plot.id || pending || (plot.building.stats?.accruedIncome || 0) <= 0.0001}
                            className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-700 to-teal-700 hover:from-emerald-600 hover:to-teal-600 disabled:opacity-40 text-white text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                          >
                            <Coins className="w-3.5 h-3.5" />
                            {collectingId === plot.id ? 'Collecting...' : 'Collect'}
                          </button>
                        )}
                        {pending ? (
                          <div className="flex-1 py-2 px-3 rounded-xl bg-amber-950/40 border border-amber-700/40 text-amber-300 text-xs font-bold flex items-center justify-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5" /> Confirming {network?.confirmationsRequired || 10} blocks
                          </div>
                        ) : onChain ? (
                          <div className="flex-1 py-2 px-3 rounded-xl bg-emerald-950/40 border border-emerald-700/40 text-emerald-400 text-xs font-bold flex items-center justify-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5" /> On-Chain Deed
                          </div>
                        ) : (
                          <div className="flex-1 py-2 px-3 rounded-xl bg-slate-800/60 border border-slate-700 text-slate-400 text-xs font-bold flex items-center justify-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5" /> {legacy ? 'Legacy Deed' : 'Not Minted'}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}