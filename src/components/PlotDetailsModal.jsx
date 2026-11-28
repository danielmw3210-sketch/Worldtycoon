import React, { useEffect, useState } from 'react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { buildingSprite } from './sprites';
import {
  Building2,
  Landmark,
  Gavel,
  TrendingUp,
  Sparkles,
  ShieldCheck,
  Coins,
  MapPin,
  CheckCircle2,
  Clock,
  Zap,
  Hammer,
  Crown
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

const RARITY_POOLS = {
  common: ['Country Cottage', 'Terraced Row', 'Water Works', 'Fishery'],
  uncommon: ['Georgian Townhouse', 'Electric Company', 'Market Hall', 'Railway Station'],
  rare: ['Country Manor', 'Docks & Wharves', 'Grand Theatre', 'Stone Quarry'],
  super_rare: ['Riverside Villa', 'Grand Hotel', 'Amusement Park', 'Coal Mine'],
  epic: ['Noble Estate', 'Casino', 'Salvage Yard'],
  legendary: ['Royal Palace', 'Silver Mint'],
  mythic: ['Royal Palace', 'Royal Gold Mint'],
  transcendent: ['Royal Gold Mint', 'Silver Mint']
};

function formatNum(n) {
  const value = Number(n) || 0;
  if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return `${+value.toFixed(2)}`;
}

function formatIncome(n) {
  const value = Number(n) || 0;
  if (value >= 1000) return formatNum(value);
  if (value >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

function categoryIcon(building) {
  if (!building) return Building2;
  if (building.type === 'town_hall') return Landmark;
  if (building.type === 'bank') return Landmark;
  if (building.type === 'auction_house') return Gavel;
  if (building.type === 'stock_broker') return TrendingUp;
  if (building.category === 'utility') return Zap;
  if (building.category === 'resource') return Hammer;
  if (building.category === 'mint') return Crown;
  if (building.category === 'leisure') return Sparkles;
  return Building2;
}

export default function PlotDetailsModal() {
  const {
    selectedPlot,
    setActiveModal,
    claimPlot,
    claimTownHallTaxes,
    collectIncome,
    upgradePlot,
    issueMint,
    refreshPlots,
    setSelectedPlot,
    wallet,
    network,
    user,
    addToast,
    watchJob
  } = useGame();

  const [claiming, setClaiming] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [claimingTaxes, setClaimingTaxes] = useState(false);
  const [buildingStructure, setBuildingStructure] = useState('');
  const [repairing, setRepairing] = useState(false);
  const [fortifying, setFortifying] = useState(false);

  const [mintWeight, setMintWeight] = useState('10');
  const [mintPurity, setMintPurity] = useState('0.999');
  const [minting, setMinting] = useState(false);

  const building = selectedPlot?.building;
  const nft = selectedPlot?.nftState;

  useEffect(() => {
    if (building?.metal) setMintPurity('0.999');
  }, [building?.metal]);

  // Live confirmation progress for a deed that is still minting.
  const [jobInfo, setJobInfo] = useState(null);
  const activeJobId = selectedPlot?.pendingJobId || (nft?.stage === 'pending' ? nft.jobId : null);

  useEffect(() => {
    if (!activeJobId) {
      setJobInfo(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${activeJobId}`, {
          headers: { Authorization: `Bearer ${user?.token || ''}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (alive) /* autoRefreshOnDone */ if (!data.job && nft.stage === 'pending' && typeof onRefreshPlot === 'function') onRefreshPlot(plot.id); setJobInfo(data.job || null);
      } catch { /* keep the last known progress */ }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [activeJobId, user?.token]);

  if (!selectedPlot) return null;

  const rarityColor = RARITY_COLORS[selectedPlot.rarityKey] || '#94a3b8';
  const isOwner = !!user?.username && [selectedPlot.owner, selectedPlot.controller].some(name => String(name || '').replace(/^@/, '').toLowerCase() === user.username.toLowerCase());
  const accrued = Number(building?.stats?.accruedIncome) || 0;
  const maxLevel = 10;
  const upgradeCost = selectedPlot.price * 0.4 * (building?.level || 1);
  const isIncomeProperty = building && building.incomePerHour > 0 && building.type !== 'town_hall';
  const isMint = building?.category === 'mint';
  const builtStructureCount = (selectedPlot.structures || []).filter(structure => structure.type !== 'peasant_lodge').length;
  const availableBuildingSlots = Math.max(0, Number(building?.level || 1) - builtStructureCount);

  const handleClaim = async () => {
    try {
      setClaiming(true);
      await claimPlot(selectedPlot.id);
    } catch (err) {
      // toast handled in context
    } finally {
      setClaiming(false);
    }
  };

  const handleCollect = async () => {
    try {
      setCollecting(true);
      await collectIncome(selectedPlot.id);
    } catch (err) {
      // toast handled in context
    } finally {
      setCollecting(false);
    }
  };

  const handleUpgrade = async () => {
    try {
      setUpgrading(true);
      await upgradePlot(selectedPlot.id);
    } catch (err) {
      // toast handled in context
    } finally {
      setUpgrading(false);
    }
  };

  const handleClaimTaxes = async () => {
    try {
      setClaimingTaxes(true);
      await claimTownHallTaxes(selectedPlot.id);
    } catch (err) {
      // toast handled in context
    } finally {
      setClaimingTaxes(false);
    }
  };

  const handleMint = async () => {
    try {
      const weight = parseFloat(mintWeight);
      if (!weight || weight <= 0) return addToast('Enter a valid coin weight', 'error');
      setMinting(true);
      await issueMint({
        metal: building.metal,
        weightGrams: weight,
        purity: parseFloat(mintPurity),
        mintPlotId: selectedPlot.id
      });
    } catch (err) {
      // toast handled in context
    } finally {
      setMinting(false);
    }
  };

  const handlePredecimalMint = async (event) => {
    event.preventDefault();
    if (minting) return;
    setMinting(true);
    try {
      const amountNum = Number(event.currentTarget.amt.value || 1);
      const response = await fetch('/api/mint/predecimal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(user?.token ? { Authorization: `Bearer ${user.token}` } : {}) },
        body: JSON.stringify({ amountNum, mintPlotId: selectedPlot?.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Mint failed');
      addToast('Coin strike submitted. The collection updates after chain confirmation.', 'info');
      const job = await watchJob(data.job?.id);
      if (job?.status === 'confirmed') addToast('Coin strike confirmed. Your coins are in the Coin Vault.', 'success');
      await refreshPlots();
    } catch (error) {
      addToast(error.message || 'Mint failed', 'error');
    } finally {
      setMinting(false);
    }
  };

  const handleBuildStructure = async (structureType) => {
    setBuildingStructure(structureType);
    try {
      const response = await fetch(`/api/plots/${selectedPlot.id}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user?.token || ''}` },
        body: JSON.stringify({ structureType })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Construction failed');
      setSelectedPlot(data.plot);
      await refreshPlots();
      addToast(`${data.plot.structures.at(-1).name} built`, 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setBuildingStructure('');
    }
  };

  const handleRepair = async () => {
    setRepairing(true);
    try {
      const response = await fetch(`/api/plots/${encodeURIComponent(selectedPlot.id)}/repair`, { method: 'POST', headers: { Authorization: `Bearer ${user?.token || ''}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Repair failed');
      setSelectedPlot(data.plot); await refreshPlots(); addToast('Plot repaired using settlement resources.', 'success');
    } catch (err) { addToast(err.message, 'error'); } finally { setRepairing(false); }
  };

  const handleFortify = async () => {
    setFortifying(true);
    try {
      const response = await fetch(`/api/plots/${encodeURIComponent(selectedPlot.id)}/fortify`, { method: 'POST', headers: { Authorization: `Bearer ${user?.token || ''}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Fortification failed');
      setSelectedPlot(data.plot); await refreshPlots(); addToast('Fortifications strengthened.', 'success');
    } catch (err) { addToast(err.message, 'error'); } finally { setFortifying(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop animate-fadeIn">
      <div className="game-modal-panel w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="game-modal-header relative p-6">
          <div className="flex items-start justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-orange-400 bg-orange-950/60 border border-orange-800/60 px-2 py-0.5 rounded">
                  {selectedPlot.label || selectedPlot.id}
                </span>
                <span
                  className="text-[10px] font-mono font-bold uppercase px-2 py-0.5 rounded-full border"
                  style={{ color: rarityColor, borderColor: `${rarityColor}80`, backgroundColor: `${rarityColor}1a` }}
                >
                  {selectedPlot.rarityName || 'Common'} · {formatNum(selectedPlot.price)} NUM
                </span>
                <span className="text-xs text-slate-400 flex items-center">
                  <MapPin className="w-3 h-3 mr-1 text-slate-500" />
                  {selectedPlot.region}
                </span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1.5 truncate">{selectedPlot.name}</h2>
            </div>
            <button
              onClick={() => setActiveModal(null)}
              className="game-modal-close"
              aria-label="Close plot details"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {selectedPlot.health != null && <div className="p-3 rounded-xl bg-slate-900 border border-slate-800"><div className="flex justify-between text-xs"><span className="text-slate-300">{selectedPlot.isCastle ? 'Castle integrity' : 'Plot health'} · Fortification {selectedPlot.fortificationLevel || 0}/5</span><b>{selectedPlot.health}/{selectedPlot.maxHealth || (selectedPlot.isCastle ? 1000 : 100)}</b></div><div className="h-2 mt-2 rounded bg-slate-800"><div className="h-full rounded bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, 100 * selectedPlot.health / (selectedPlot.maxHealth || 100)))}%` }} /></div>{selectedPlot.siege && <p className="mt-2 text-[10px] text-red-300">Under siege by @{selectedPlot.siege.attacker}</p>}{isOwner && <div className="mt-2 flex flex-wrap gap-2">{selectedPlot.health < selectedPlot.maxHealth && <button disabled={repairing} onClick={handleRepair} className="px-3 py-1.5 rounded bg-slate-800 text-[10px] disabled:opacity-40">{repairing ? 'Repairing…' : 'Repair · 10 wood + 2 iron'}</button>}{Number(selectedPlot.fortificationLevel||0)<5&&<button disabled={fortifying} onClick={handleFortify} className="px-3 py-1.5 rounded bg-slate-800 text-[10px] disabled:opacity-40">{fortifying?'Fortifying…':`Fortify · ${20*(Number(selectedPlot.fortificationLevel||0)+1)} wood + ${5*(Number(selectedPlot.fortificationLevel||0)+1)} iron`}</button>}</div>}</div>}

          {/* Unclaimed plot */}
          {!selectedPlot.isClaimed && (
            <div className="space-y-5">
              <div className="p-4 rounded-xl bg-orange-950/20 border border-orange-500/30 flex items-start space-x-3">
                <Sparkles className="w-6 h-6 text-orange-400 shrink-0 mt-0.5 animate-pulse" />
                <div>
                  <h4 className="font-bold text-white text-sm">Survey & Claim This {selectedPlot.rarityName} Plot</h4>
                  <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                    Claiming registers the deed to <strong>@{user?.username || 'you'}</strong>, gives you a Peasant Lodge and this plot’s resource deposits, and starts a small NUM income stream.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
                  <span className="text-[10px] text-slate-400 block uppercase font-mono">Price</span>
                  <span className="text-lg font-black font-mono text-orange-400">{formatNum(selectedPlot.price)}</span>
                  <span className="text-[10px] text-slate-500 block">NUM</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
                  <span className="text-[10px] text-slate-400 block uppercase font-mono">Est. Income</span>
                  <span className="text-lg font-black font-mono text-emerald-400">
                    {formatIncome(selectedPlot.price / 1200)}
                  </span>
                  <span className="text-[10px] text-slate-500 block">NUM / hour</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center col-span-2 sm:col-span-1">
                  <span className="text-[10px] text-slate-400 block uppercase font-mono">Your Wallet</span>
                  <span className="text-lg font-black font-mono text-white">{formatNum(wallet?.balance)}</span>
                  <span className="text-[10px] text-slate-500 block">NUM</span>
                  {(wallet?.pendingBalance || 0) > 0 && (
                    <span className="text-[10px] text-amber-400 block">+{formatNum(wallet.pendingBalance)} pending</span>
                  )}
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-2">
                <div className="flex items-center gap-3">
                  <GameSprite sprite={buildingSprite({ type: 'peasant_lodge' })} className="game-art--small" />
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-mono">
                    This plot starts with a Peasant Lodge
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(selectedPlot.resourceDeposits || {}).filter(([, amount]) => Number(amount) > 0).map(([resource, amount]) => (
                    <span key={resource} className="px-2.5 py-1 rounded-lg bg-slate-800/70 border border-slate-700 text-xs text-slate-200 capitalize">{resource} deposit · {Number(amount).toLocaleString()}</span>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500 font-mono pt-1">
                  The lodge earns a small income. Deposits are randomized when you buy the plot; build mines and workshops to develop them.
                </p>
              </div>

              <button
                onClick={handleClaim}
                disabled={claiming || !!selectedPlot.pendingJobId || (wallet?.balance || 0) < selectedPlot.price}
                className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 disabled:opacity-40 text-white font-black text-sm shadow-xl shadow-orange-600/20 transition-all flex items-center justify-center space-x-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>
                  {claiming || selectedPlot.pendingJobId
                    ? 'Minting Deed — awaiting 10 confirmations...'
                    : `Claim Deed for ${formatNum(selectedPlot.price)} NUM`}
                </span>
              </button>
              {(wallet?.balance || 0) < selectedPlot.price && (
                <p className="text-[11px] text-rose-400 font-mono text-center">
                  You need {formatNum(selectedPlot.price - (wallet?.balance || 0))} more NUM. Claim a
                  cheaper rarity, mine shares, or collect income from properties you already own.
                </p>
              )}
            </div>
          )}

          {/* Claimed plot */}
          {selectedPlot.isClaimed && building && (
            <div className="space-y-5">
              <div className="p-5 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-900/60 border border-slate-800">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    {buildingSprite(building)
                      ? <GameSprite sprite={buildingSprite(building)} />
                      : <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center shrink-0 border border-orange-300/40">
                          {React.createElement(categoryIcon(building), { className: 'w-6 h-6 text-white' })}
                        </div>}
                    <div className="min-w-0">
                      <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                        {building.category || 'property'} · Level {building.level}
                      </div>
                      <h3 className="text-lg font-bold text-white truncate">{building.name}</h3>
                      <p className="text-xs text-slate-400 mt-0.5">{building.description}</p>
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-cyan-300 shrink-0">
                    {selectedPlot.owner}
                  </span>
                </div>

                {building.type === 'peasant_lodge' && (
                  <button
                    onClick={() => setActiveModal('resources')}
                    className="mt-4 w-full py-2.5 rounded-xl bg-emerald-900/70 hover:bg-emerald-800 border border-emerald-700/60 text-emerald-100 text-xs font-bold"
                  >
                    Open Plot Resources & Metal Mint
                  </button>
                )}

                {isIncomeProperty && (
                  <>
                    <div className="grid grid-cols-2 gap-3 mt-4">
                      <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                        <span className="text-[10px] text-slate-400 block uppercase font-mono">Income Rate</span>
                        <span className="text-xl font-black font-mono text-emerald-400">
                          {formatIncome(building.incomePerHour)}
                        </span>
                        <span className="text-[10px] text-slate-500 block">NUM / hour</span>
                      </div>
                      <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                        <span className="text-[10px] text-slate-400 block uppercase font-mono">Uncollected</span>
                        <span className="text-xl font-black font-mono text-orange-400">
                          {formatIncome(accrued)}
                        </span>
                        <span className="text-[10px] text-slate-500 block">NUM (caps at 24h)</span>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-col sm:flex-row gap-2">
                      <button
                        onClick={handleCollect}
                        disabled={collecting || accrued <= 0.0001 || !isOwner}
                        className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 text-white text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                      >
                        <Coins className="w-4 h-4" />
                        {collecting
                          ? 'Collecting...'
                          : building.variableYield
                            ? 'Collect (roll 2d6)'
                            : `Collect ${formatIncome(accrued)} NUM`}
                      </button>
                      <button
                        onClick={handleUpgrade}
                        disabled={upgrading || !isOwner || building.level >= maxLevel || (wallet?.balance || 0) < upgradeCost}
                        className="flex-1 py-2.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-40 text-white text-xs font-bold transition-all flex items-center justify-center gap-1.5"
                      >
                        <TrendingUp className="w-4 h-4 text-emerald-400" />
                        {building.level >= maxLevel
                          ? 'Max Level'
                          : upgrading
                            ? 'Upgrading...'
                            : `Upgrade L${building.level + 1} · ${formatNum(upgradeCost)} NUM`}
                      </button>
                    </div>
                    <div className="mt-2 text-[10px] text-slate-500 font-mono flex justify-between">
                      <span>+25% income per level · L5 Motte-and-Bailey · L10 Castle</span>
                      <span>Collected all-time: {formatIncome(building.stats?.totalIncomeCollected)} NUM</span>
                    </div>
                  </>
                )}

                {building.type === 'peasant_lodge' && (
                  <div className="mt-4 p-4 rounded-xl bg-emerald-950/15 border border-emerald-500/25 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div><h4 className="text-sm font-bold text-emerald-200">Settlement & Resources</h4><p className="text-[10px] text-slate-400">Settlement level {building.level} · {availableBuildingSlots} open building slot(s)</p></div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(selectedPlot.stockpile || {}).map(([resource, amount]) => <span key={resource} className="px-2 py-1 rounded bg-slate-950/70 border border-slate-800 text-[10px] text-slate-300 capitalize">{resource}: {Number(amount || 0).toFixed(1)}</span>)}
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2">{(selectedPlot.structures || []).map((structure, index) => <div key={`${structure.type}-${index}`} className="game-modal-card rounded-lg p-2 flex items-center gap-2 text-xs text-slate-200"><GameSprite sprite={buildingSprite(structure)} className="game-art--small" /><span>{structure.name} {structure.resource ? <span className="block text-emerald-300">Extracts {structure.resource} at {structure.outputPerHour}/h</span> : ''}</span></div>)}</div>
                    {isOwner && <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {Object.entries(selectedPlot.resourceDeposits || {}).filter(([, amount]) => Number(amount) > 0).map(([resource]) => {
                        const type = resource === 'wood' ? 'woodcutter' : `${resource}_mine`;
                        const names = { wood: 'Woodcutter Camp', iron: 'Iron Mine', tin: 'Tin Mine', copper: 'Copper Mine', silver: 'Silver Mine', gold: 'Gold Mine' };
                        return <button key={resource} disabled={buildingStructure === type || availableBuildingSlots === 0} onClick={() => handleBuildStructure(type)} className="p-2 rounded-lg border border-slate-700 bg-slate-950 hover:border-emerald-500/50 disabled:opacity-40 text-left flex items-center gap-2"><GameSprite sprite={buildingSprite({ type })} className="game-art--small" /><span><span className="block text-[11px] font-bold text-white">{buildingStructure === type ? 'Building…' : names[resource] || resource}</span><span className="block text-[9px] text-slate-500">Uses {resource === 'gold' || resource === 'silver' ? 'wood + iron' : 'wood'}</span></span></button>;
                      })}
                    </div>}
                    {availableBuildingSlots === 0 && <p className="text-[10px] text-amber-300">Upgrade the lodge to unlock another building slot.</p>}
                  </div>
                )}

                {/* Town hall treasury */}
                {building.type === 'town_hall' && (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
                      <span className="text-[10px] text-slate-400 block uppercase font-mono">Treasury</span>
                      <span className="text-xl font-black font-mono text-amber-400">
                        {formatNum(building.stats?.treasuryBalance)}
                      </span>
                      <span className="text-[10px] text-slate-500 block">NUM</span>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col justify-between">
                      <span className="text-[10px] text-slate-400 block uppercase font-mono">Municipal Taxes</span>
                      <button
                        onClick={handleClaimTaxes}
                        disabled={claimingTaxes || (building.stats?.treasuryBalance || 0) <= 0}
                        className="mt-1 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 disabled:opacity-40 text-[11px] font-bold"
                      >
                        {claimingTaxes ? 'Harvesting...' : 'Claim Taxes'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Institutional stats */}
                {(building.type === 'bank' || building.type === 'auction_house' || building.type === 'stock_broker') && (
                  <div className="mt-4 p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs font-mono text-slate-300 space-y-1.5">
                    <div className="flex justify-between"><span className="text-slate-500">Institution</span><span>{building.type.replace('_', ' ')}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Level</span><span>{building.level}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Status</span><span className="text-emerald-400">Operational</span></div>
                  </div>
                )}
              </div>

              {/* Mint panel (admin only) */}
              {isMint && (
                <div className="p-5 rounded-2xl bg-slate-900/90 border border-amber-600/40 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Crown className="w-5 h-5 text-amber-400" />
                      <span className="font-bold text-white text-sm">Coin Mint · {building.metal?.toUpperCase()}</span>
                    </div>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                      user?.role === 'admin'
                        ? 'text-emerald-400 border-emerald-700 bg-emerald-950/50'
                        : 'text-rose-400 border-rose-800 bg-rose-950/40'
                    }`}>
                      {user?.role === 'admin' ? 'ADMIN AUTHORIZED' : 'ADMIN ONLY'}
                    </span>
                  </div>

                  {user?.role === 'admin' ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="text-xs text-slate-400 space-y-1 block">
                          <span>Coin weight (grams)</span>
                          <input
                            type="number"
                            min="0.1"
                            step="0.1"
                            value={mintWeight}
                            onChange={(e) => setMintWeight(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-amber-500"
                          />
                        </label>
                        <label className="text-xs text-slate-400 space-y-1 block">
                          <span>Purity (0.5 – 0.9999)</span>
                          <input
                            type="number"
                            min="0.5"
                            max="0.9999"
                            step="0.0001"
                            value={mintPurity}
                            onChange={(e) => setMintPurity(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-amber-500"
                          />
                        </label>
                      </div>
                      <div className="flex justify-between text-[11px] font-mono text-slate-400">
                        <span>Minting fee:</span>
                        <span className="text-amber-300">
                          {(Number(mintWeight || 0) * (building.metal === 'gold' ? 1.25 : 0.08)).toFixed(2)} NUM
                        </span>
                      </div>
                      <button
                        onClick={handleMint}
                        disabled={minting || !(Number(mintWeight) > 0)}
                        className="w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-600 to-yellow-600 hover:from-amber-500 hover:to-yellow-500 disabled:opacity-40 text-black text-xs font-black transition-all flex items-center justify-center gap-2"
                      >
                        <Crown className="w-4 h-4" />
                        {minting ? 'Striking coin...' : `Strike ${building.metal} coin`}
                      </button>
                      <p className="text-[10px] text-slate-500 font-mono">
                        Seigniorage is paid to the mint owner. Minting requires an administrator.
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400">
                      Only an administrator can operate this mint. Owners still earn seigniorage
                      whenever coins are struck here.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Deed asset card (Numista on-chain NFT) */}
          {selectedPlot.isClaimed && nft && (
            <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <div className="flex items-center space-x-2">
                  <ShieldCheck className="w-5 h-5 text-orange-400" />
                  <span className="font-bold text-white text-sm">Deed Asset</span>
                </div>
                <span className="text-xs font-mono text-slate-400 truncate max-w-[55%]" title={nft.assetId}>
                  {nft.assetId}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-amber-950/25 border border-amber-500/30 flex items-center justify-between text-xs font-mono">
                <span className="text-amber-300 font-semibold">Crown Treasury Fund</span>
                <span className="text-amber-200">
                  {network?.crownEstateFund?.available
                    ? ` NUM`
                    : '0.0000 NUM'}
                  <span className="ml-2 text-[10px] text-slate-400">
                    (+{(network?.crownEstateBlockReward ?? 0.25).toFixed(2)}/block)
                  </span>
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">Registry</span>
                    <span className="flex items-center text-emerald-400 text-[11px] font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Active
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Ownership is tracked by username. Immutable deed metadata is content-addressed.
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-200">Numista Asset</span>
                    <span className={`flex items-center text-[11px] font-semibold ${
                      nft.stage === 'onchain' ? 'text-emerald-400' :
                      nft.stage === 'pending' ? 'text-amber-400' :
                      nft.stage === 'failed' ? 'text-rose-400' : 'text-slate-400'
                    }`}>
                      {nft.stage === 'onchain' ? (
                        <><CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Block #{nft.blockHeight}</>
                      ) : nft.stage === 'pending' ? (
                        <><Clock className="w-3.5 h-3.5 mr-1" /> Confirming</>
                      ) : nft.stage === 'failed' ? (
                        <><Clock className="w-3.5 h-3.5 mr-1" /> Reverted</>
                      ) : (
                        <><Clock className="w-3.5 h-3.5 mr-1" /> Not minted</>
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Collectible asset (max supply 1) minted with a 32-byte metadata hash.
                  </p>
                </div>
              </div>

              {nft.stage === 'pending' && (
                <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/50 text-[11px] text-amber-300 font-mono">
                  {jobInfo
                    ? `${jobInfo.confirmations}/${jobInfo.requiredConfirmations || network?.confirmationsRequired || 10} confirmations · step ${jobInfo.confirmedSteps}/${jobInfo.totalSteps}`
                    : `Waiting for ${network?.confirmationsRequired || 10} confirmations…`}
                  <span className="block text-amber-400/80 mt-1">
                    The deed is reserved until then; if the chain rejects the mint, the claim is reverted automatically.
                  </span>
                </div>
              )}

              {nft.metadataHash && (
                <div className="p-3 rounded-lg bg-black/60 border border-slate-800 font-mono text-[11px] text-slate-400 break-all">
                  <span className="text-slate-500">metadata_hash </span>{nft.metadataHash}
                </div>
              )}

              {nft.txHash && (
                <div className="p-3 rounded-lg bg-black/60 border border-slate-800 font-mono text-[11px] text-emerald-300 break-all select-all">
                  <span className="text-slate-500">tx </span>{nft.txHash}
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-amber-950/20 border border-amber-500/30 space-y-2"><div className="flex items-center justify-between"><span className="text-xs font-bold text-amber-300">Royal Mint · Pre-1920 Pre-Decimal (1 NUM = £1 / 20s)</span></div><p className="text-[11px] text-slate-400">Strike NUM into a weighted random assortment of pre-1920 British coins (Gold Guineas 21s, Sovereigns 20s, Half Sovereigns 10s, Crowns 5s, Half Crowns, Florins, Shillings, Sixpences & Threepences).</p><form onSubmit={handlePredecimalMint} className="flex gap-2"><input name="amt" type="number" step="0.05" min="0.05" defaultValue="1" className="w-28 px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs font-mono text-white" /><button type="submit" disabled={minting} className="flex-1 py-1.5 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-bold">{minting ? "Waiting for chain?" : "Strike Pre-1920 Coinage"}</button></form></div>
              {nft.stage === 'legacy_simulated' && (
                <p className="text-[10px] text-slate-500 font-mono">
                  This early demo deed predates on-chain asset minting and is not a real chain NFT.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
