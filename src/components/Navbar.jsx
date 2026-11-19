import React from 'react';
import { useGame } from '../context/GameContext';
import { 
  Pickaxe, 
  CreditCard, 
  Building2, 
  Landmark, 
  Gavel, 
  TrendingUp, 
  ShieldCheck, 
  Coins, 
  Cpu, 
  MapPin, 
  Layers, 
  Radio, 
  User, 
  LogOut 
} from 'lucide-react';

export default function Navbar() {
  const { 
    user, 
    logout, 
    wallet, 
    network, 
    setActiveModal, 
    isMining, 
    hashrate 
  } = useGame();

  return (
    <header className="sticky top-0 z-40 bg-[#0f141c]/95 backdrop-blur-md border-b border-[#222d3d] px-4 py-2.5 transition-all">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        
        {/* Brand & Blockchain Sync Status */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shadow-lg shadow-orange-500/20 border border-orange-400/30">
            <Coins className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-extrabold tracking-wider text-lg text-white font-mono">
                TOWN<span className="text-orange-500">FORGE</span>
              </span>
              <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full bg-orange-950/80 border border-orange-600/50 text-orange-400 font-mono">
                Numista XMR Fork
              </span>
            </div>
            
            {/* Blockchain Node Sync Status Pill */}
            <div className="flex items-center space-x-3 text-xs text-slate-400 font-mono mt-0.5">
              <button
                onClick={() => setActiveModal('sync_settings')}
                className="flex items-center hover:text-cyan-400 transition-colors"
                title="Click to view online blockchain synchronization"
              >
                <Radio className="w-3 h-3 mr-1 text-cyan-400 animate-pulse" />
                <span className="text-emerald-400 font-semibold">Synced Block #{network.height || 115}</span>
              </button>
              <span className="text-slate-600">|</span>
              <span
                className="text-amber-400 flex items-center"
                title={network.crownEstateFund?.error || 'Live balance from the Crown Estate watch-only wallet'}
              >
                <Landmark className="w-3 h-3 mr-1" />
                Crown Estate Fund: {network.crownEstateFund?.available
                  ? `${Number(network.crownEstateFund.balance).toFixed(12)} NUM`
                  : 'unavailable'}
                <span className="ml-1 text-[10px] text-slate-400">
                  +{(network.crownEstateBlockReward ?? 0.0005).toFixed(4)}/block
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Action Shortcuts */}
        <nav className="flex items-center space-x-1.5 sm:space-x-2">
          
          {/* In-Browser Miner Button: Explicitly shows OFF / ON */}
          <button
            onClick={() => setActiveModal('miner')}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg font-medium text-xs sm:text-sm border transition-all ${
              isMining 
                ? 'bg-orange-500/20 border-orange-500 text-orange-400 shadow-lg shadow-orange-500/20 animate-pulse' 
                : 'bg-[#161d2a] hover:bg-[#1f293b] border-slate-700 text-slate-300'
            }`}
          >
            <Pickaxe className={`w-4 h-4 ${isMining ? 'text-orange-400 animate-spin' : 'text-slate-400'}`} />
            <span>Miner: <strong className={isMining ? "text-orange-400" : "text-slate-400"}>{isMining ? "ACTIVE" : "OFF"}</strong></span>
            {isMining && (
              <span className="bg-orange-500 text-black text-[10px] font-bold px-1.5 py-0.2 rounded font-mono">
                {hashrate} H/s
              </span>
            )}
          </button>

          {/* Buy Crypto Button */}
          <button
            onClick={() => setActiveModal(user ? 'buy_crypto' : 'auth')}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg font-semibold text-xs sm:text-sm bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-md shadow-emerald-700/20 border border-emerald-400/30 transition-all transform active:scale-95"
          >
            <CreditCard className="w-4 h-4" />
            <span>Deposit NUM</span>
          </button>

          {/* Bank Vault Shortcut */}
          <button
            onClick={() => setActiveModal('bank')}
            className="hidden md:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#161d2a] hover:bg-[#1e2738] border border-slate-800 text-slate-300 transition-colors"
          >
            <Landmark className="w-3.5 h-3.5 text-emerald-400" />
            <span>Bank (9.2% APY)</span>
          </button>

          {/* Auction Saleroom Shortcut */}
          <button
            onClick={() => setActiveModal('auction')}
            className="hidden md:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#161d2a] hover:bg-[#1e2738] border border-slate-800 text-slate-300 transition-colors"
          >
            <Gavel className="w-3.5 h-3.5 text-purple-400" />
            <span>Auctions</span>
          </button>

          {/* Stock Broker Shortcut */}
          <button
            onClick={() => setActiveModal('stock')}
            className="hidden lg:flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#161d2a] hover:bg-[#1e2738] border border-slate-800 text-slate-300 transition-colors"
          >
            <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
            <span>Stocks</span>
          </button>

          {/* Account & Deeds */}
          {user && (
            <button
              onClick={() => setActiveModal('account')}
              className="flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#161d2a] hover:bg-[#1e2738] border border-slate-800 text-slate-300 transition-colors"
              title="View your account and deeds"
            >
              <MapPin className="w-3.5 h-3.5 text-orange-400" />
              <span>My Deeds</span>
            </button>
          )}
        </nav>

        {/* User Identity & Private Wallet */}
        <div className="flex items-center space-x-2">
          {user ? (
            <div className="flex items-center space-x-2 bg-[#161d2a] border border-slate-800 px-3 py-1.5 rounded-xl shadow-inner">
              <button
                onClick={() => setActiveModal('wallet_details')}
                className="text-right hover:opacity-80 transition-opacity"
                title="Click to view private wallet & transfer funds"
              >
                <div className="text-xs text-orange-400 font-mono flex items-center justify-end space-x-1 font-bold">
                  <span>Wallet · @{user.username}</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                </div>
                <div className="text-sm font-bold font-mono text-white flex items-center space-x-1">
                  <span>{wallet.balance.toFixed(2)}</span>
                  <span className="text-[11px] text-orange-400 font-normal">NUM</span>
                </div>
              </button>
              
              <button
                onClick={logout}
                title="Log Out"
                className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-rose-950 text-slate-400 hover:text-rose-400 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setActiveModal('auth')}
              className="px-3.5 py-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-bold text-xs flex items-center space-x-1.5 shadow-md shadow-orange-600/30"
            >
              <User className="w-4 h-4" />
              <span>Log In / Sign Up</span>
            </button>
          )}
        </div>

      </div>
    </header>
  );
}
