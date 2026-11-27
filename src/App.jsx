import React from 'react';
import { useGame } from './context/GameContext';
import Navbar from './components/Navbar';
import MapView from './components/MapView';
import PlotDetailsModal from './components/PlotDetailsModal';
import TownHallView from './components/TownHallView';
import BankModal from './components/BankModal';
import AuctionHouseModal from './components/AuctionHouseModal';
import StockBrokerModal from './components/StockBrokerModal';
import BrowserMinerModal from './components/BrowserMinerModal';
import BuyCryptoModal from './components/BuyCryptoModal';
import WalletStatus from './components/WalletStatus';
import BlockchainSyncModal from './components/BlockchainSyncModal';
import BlockExplorerModal from './components/BlockExplorerModal';
import AuthModal from './components/AuthModal';
import AccountModal from './components/AccountModal';
import DeedsModal from './components/DeedsModal';
import PeerageModal from './components/PeerageModal';
import CastlesModal from './components/CastlesModal';
import CoinCollectionModal from './components/CoinCollectionModal';
import ArmyModal from './components/ArmyModal';
import SoldierModal from './components/SoldierModal';
import TransactionToast from './components/TransactionToast';

export default function App() {
  const { user, activeModal, setActiveModal, loading } = useGame();

  if (loading) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0b0e14] text-white">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center animate-spin shadow-2xl shadow-orange-500/50">
          <div className="w-8 h-8 rounded-lg bg-[#0b0e14]"></div>
        </div>
        <div className="mt-4 font-mono text-sm tracking-widest uppercase font-bold text-orange-400">
          Loading Goldnumista UK Land Registry...
        </div>
        <div className="text-xs text-slate-500 font-mono mt-1">Connecting to Numista Monero RPC Daemon</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#0b0e14]">
      {/* Top Header */}
      <Navbar />

      {/* Main Interactive Map & Gaming Floor */}
      <main className="flex-1 relative">
        <MapView />
      </main>

      {/* Auth Modal: Display if user not logged in or explicitly clicked */}
      {(!user || activeModal === 'auth') && (
        <AuthModal onLoginSuccess={() => setActiveModal(null)} />
      )}

      {/* Active Modals */}
      {activeModal === 'plot_details' && <PlotDetailsModal />}
      {activeModal === 'town_hall' && <TownHallView />}
      {activeModal === 'bank' && <BankModal />}
      {activeModal === 'auction' && <AuctionHouseModal />}
      {activeModal === 'stock' && <StockBrokerModal />}
      {activeModal === 'miner' && <BrowserMinerModal />}
      {activeModal === 'buy_crypto' && <BuyCryptoModal />}
      {activeModal === 'wallet_details' && <WalletStatus />}
      {activeModal === 'sync_settings' && <BlockchainSyncModal />}
      {activeModal === 'explorer' && <BlockExplorerModal />}
      {activeModal === 'account' && <AccountModal />}
      {activeModal === 'deeds' && <DeedsModal />}
      {activeModal === 'peerage' && <PeerageModal />}
      {activeModal === 'castles' && <CastlesModal />}
      {activeModal === 'coins' && <CoinCollectionModal />}
      {activeModal === 'army' && <ArmyModal />}
      {activeModal === 'soldiers' && <SoldierModal />}

      {/* Real-time Toasts */}
      <TransactionToast />
    </div>
  );
}
