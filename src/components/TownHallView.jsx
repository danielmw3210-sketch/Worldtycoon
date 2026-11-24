import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import { 
  Building2, 
  Coins, 
  Landmark, 
  Shield, 
  TrendingUp, 
  Award, 
  ArrowRight, 
  CheckCircle, 
  Zap, 
  Sparkles 
} from 'lucide-react';

export default function TownHallView() {
  const { 
    selectedPlot, 
    plots, 
    setSelectedPlot, 
    setActiveModal, 
    claimTownHallTaxes,
    user
  } = useGame();

  const [claiming, setClaiming] = useState(false);

  // Find a town hall plot if none selected
  const townHallPlot = (selectedPlot && selectedPlot.building?.type === 'town_hall')
    ? selectedPlot
    : plots.find(p => p.building?.type === 'town_hall') || plots[0];

  const building = townHallPlot?.building;
  const stats = building?.stats || {};
  const isOwner = !!townHallPlot?.owner && townHallPlot.owner.replace(/^@/, '').toLowerCase() === (user?.username || '').toLowerCase();

  const handleClaimTaxes = async () => {
    try {
      setClaiming(true);
      await claimTownHallTaxes(townHallPlot.id);
    } catch (err) {
      // Handled in context toast
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-amber-500/40 w-full max-w-3xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-amber-950/60 via-slate-900 to-[#161d2a] border-b border-amber-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-amber-600 to-yellow-400 flex items-center justify-center text-black font-extrabold shadow-lg shadow-amber-500/30 border border-yellow-200">
              <Building2 className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-amber-400 bg-amber-950 border border-amber-700/60 px-2 py-0.5 rounded">
                  Municipal Government Citadel
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {townHallPlot?.id} • {townHallPlot?.region}
                </span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1">{building?.name || 'District Town Hall'}</h2>
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
        <div className="p-6 overflow-y-auto space-y-6">

          {/* District Selector Tabs if multiple town halls */}
          <div className="flex items-center space-x-2 overflow-x-auto pb-1">
            {plots.filter(p => p.building?.type === 'town_hall').map(th => (
              <button
                key={th.id}
                onClick={() => setSelectedPlot(th)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors flex items-center space-x-1.5 ${
                  townHallPlot?.id === th.id
                    ? 'bg-amber-500 text-black font-bold shadow-md shadow-amber-500/20'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <span>{th.region.split(' ')[0]} Town Hall</span>
              </button>
            ))}
          </div>

          {/* Treasury Vault Card */}
          <div className="p-6 rounded-2xl bg-gradient-to-br from-amber-950/40 via-slate-900 to-slate-900 border border-amber-500/30 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-6 opacity-10 pointer-events-none">
              <Landmark className="w-36 h-36 text-amber-300" />
            </div>

            <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-6">
              
              {/* Current Treasury Balance */}
              <div className="md:col-span-2 space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center space-x-1.5 font-mono">
                  <Coins className="w-4 h-4" />
                  <span>District Municipal Treasury Balance</span>
                </span>
                <div className="text-4xl sm:text-5xl font-black font-mono text-white tracking-tight flex items-baseline space-x-2">
                  <span>{(stats.treasuryBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  <span className="text-xl text-amber-400 font-bold">NUM</span>
                </div>
                <p className="text-xs text-slate-300 max-w-lg leading-relaxed pt-1">
                  Levies a mandatory 3.5% municipal transaction tax on regional auction settlements, stock broker equities trading, land deed claims, and mining pool payouts within a {stats.jurisdictionRadiusKm || 25}km radius.
                </p>
              </div>

              {/* Claim Action */}
              <div className="flex flex-col justify-center items-start md:items-end">
                <button
                  onClick={handleClaimTaxes}
                  disabled={claiming || (stats.treasuryBalance || 0) <= 0}
                  className="w-full md:w-auto px-6 py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 disabled:opacity-40 text-black font-black text-sm shadow-xl shadow-amber-500/20 transition-all flex items-center justify-center space-x-2 active:scale-95"
                >
                  <Coins className="w-5 h-5 text-black" />
                  <span>{claiming ? 'Harvesting Treasury...' : 'Claim Municipal Taxes'}</span>
                </button>
                <span className="text-[11px] text-slate-400 mt-2 font-mono text-right">
                  Mints to your on-chain balance after 10 confirmations
                </span>
              </div>

            </div>
          </div>

          {/* Taxation & Territory Analytics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-xs text-slate-400 block">Territorial Tax Rate</span>
              <span className="text-2xl font-black font-mono text-amber-400 mt-1 block">
                {((stats.taxRate || 0.035) * 100).toFixed(1)}%
              </span>
              <span className="text-[11px] text-slate-500 mt-1 block">Fixed regional sovereign rate</span>
            </div>
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-xs text-slate-400 block">All-Time Taxes Collected</span>
              <span className="text-2xl font-black font-mono text-white mt-1 block">
                {(stats.totalTaxesCollected || 0).toLocaleString()} <span className="text-xs text-slate-400 font-normal">NUM</span>
              </span>
              <span className="text-[11px] text-emerald-400 mt-1 block font-mono">+12.4% this week</span>
            </div>
            <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800">
              <span className="text-xs text-slate-400 block">Subsidies Paid to Citizens</span>
              <span className="text-2xl font-black font-mono text-amber-300 mt-1 block">
                {(stats.subsidiesDistributed || 0).toLocaleString()} <span className="text-xs text-slate-400 font-normal">NUM</span>
              </span>
              <span className="text-[11px] text-slate-500 mt-1 block">Public civic reinvestment</span>
            </div>
          </div>

          {/* Civic Ordinances & Policy Upgrades */}
          <div className="p-5 rounded-xl bg-slate-900/50 border border-slate-800 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono flex items-center space-x-2">
              <Shield className="w-4 h-4 text-amber-400" />
              <span>District Civic Upgrades & Goldnumista Ordinances</span>
            </h4>
            <div className="space-y-2">
              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">Automated Cross-Parish Tax Clearing</div>
                  <div className="text-[11px] text-slate-400">Mints municipal tax receipts to the district treasury</div>
                </div>
                <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-700 text-[10px] font-mono">ACTIVE</span>
              </div>
              <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-700/60 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white">Merchant Guild Tax Relief (Tier 2)</div>
                  <div className="text-[11px] text-slate-400">0.5% discount for verified Stock Broker trade volumes</div>
                </div>
                <span className="px-2 py-0.5 rounded bg-amber-950 text-amber-400 border border-amber-700 text-[10px] font-mono">ENACTED</span>
              </div>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
