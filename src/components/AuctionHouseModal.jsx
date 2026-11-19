import React, { useState, useEffect } from 'react';
import { useGame } from '../context/GameContext';
import { 
  Gavel, 
  Coins, 
  Clock, 
  Sparkles, 
  Tag, 
  User, 
  CheckCircle, 
  Flame 
} from 'lucide-react';

export default function AuctionHouseModal() {
  const { wallet, setActiveModal, refreshWallet, addToast } = useGame();

  const [auctions, setAuctions] = useState([]);
  const [selectedAuction, setSelectedAuction] = useState(null);
  const [bidAmount, setBidAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchAuctions = async () => {
    try {
      const res = await fetch('/api/auctions');
      if (res.ok) {
        const data = await res.json();
        setAuctions(data.auctions || []);
        if (!selectedAuction && data.auctions?.length > 0) {
          setSelectedAuction(data.auctions[0]);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchAuctions();
    const interval = setInterval(fetchAuctions, 5000);
    return () => clearInterval(interval);
  }, []);

  const handlePlaceBid = async (auctionId) => {
    const val = parseFloat(bidAmount);
    if (!val || val <= 0) return addToast('Enter a valid bid amount', 'error');
    if (selectedAuction && val <= selectedAuction.currentBid) {
      return addToast(`Bid must be greater than ${selectedAuction.currentBid} NUM`, 'error');
    }
    if (val > wallet.balance) return addToast('Insufficient wallet balance', 'error');

    try {
      setSubmitting(true);
      const res = await fetch(`/api/auctions/${auctionId}/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: val })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`Bid of ${val} NUM placed successfully! (Includes 3.5% Town Hall tax)`, 'success');
      setBidAmount('');
      await fetchAuctions();
      await refreshWallet();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-purple-500/40 w-full max-w-3xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-purple-950/60 via-slate-900 to-[#161d2a] border-b border-purple-500/30 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-purple-600 to-fuchsia-400 flex items-center justify-center text-white shadow-lg shadow-purple-500/30 border border-purple-200">
              <Gavel className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-purple-400 bg-purple-950 border border-purple-700/60 px-2 py-0.5 rounded">
                  Townforge Grand Saleroom
                </span>
                <span className="text-xs text-slate-400 font-mono">Mayfair & Clyde Clearing Protocol</span>
              </div>
              <h2 className="text-2xl font-black text-white mt-1">Sovereign Land & Relic Auction House</h2>
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
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            
            {/* Auction Listings List */}
            <div className="md:col-span-2 space-y-3">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono block">
                Active Bidding Lots ({auctions.length})
              </span>

              {auctions.map(auc => (
                <div
                  key={auc.id}
                  onClick={() => { setSelectedAuction(auc); setBidAmount((auc.currentBid + 5).toString()); }}
                  className={`p-4 rounded-xl border transition-all cursor-pointer ${
                    selectedAuction?.id === auc.id
                      ? 'bg-purple-950/30 border-purple-500 shadow-lg shadow-purple-950/40'
                      : 'bg-slate-900/70 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-[10px] font-mono font-bold text-purple-400 bg-purple-950 px-2 py-0.2 rounded border border-purple-800">
                          {auc.category}
                        </span>
                        <span className="text-[11px] text-slate-400 font-mono">Lot #{auc.id}</span>
                      </div>
                      <h4 className="font-bold text-white text-sm mt-1">{auc.title}</h4>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] text-slate-400 font-mono block">Current Bid</span>
                      <span className="text-base font-black font-mono text-purple-300">
                        {auc.currentBid.toFixed(2)} NUM
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center">
                      <Clock className="w-3.5 h-3.5 mr-1 text-slate-500" />
                      Closes in 48h
                    </span>
                    <span className="text-slate-400 font-mono">
                      {auc.bidsCount} Bids Placed
                    </span>
                    <span className="text-emerald-400 font-semibold font-mono">
                      Buyout: {auc.buyoutPrice} NUM
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Bidding Terminal Sidebar */}
            {selectedAuction && (
              <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center space-x-1.5 text-xs text-purple-400 font-mono font-bold uppercase">
                    <Flame className="w-3.5 h-3.5 text-purple-400" />
                    <span>Live Bid Slip</span>
                  </div>
                  <h3 className="font-bold text-white text-base mt-1">{selectedAuction.title}</h3>
                  <div className="text-xs text-slate-400 mt-1">Associated Plot: <span className="font-mono text-white">{selectedAuction.plotId}</span></div>

                  <div className="my-4 p-3 rounded-xl bg-slate-950 border border-slate-800">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Highest Bidder:</span>
                      <span className="font-mono text-slate-200">
                        {selectedAuction.highestBidder ? `${selectedAuction.highestBidder.slice(0, 6)}...${selectedAuction.highestBidder.slice(-4)}` : 'None'}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs text-slate-400 mt-2">
                      <span>Current Standing:</span>
                      <span className="font-bold font-mono text-purple-300 text-sm">
                        {selectedAuction.currentBid} NUM
                      </span>
                    </div>
                  </div>

                  {/* Bid Input */}
                  <div className="space-y-2">
                    <label className="text-xs text-slate-400 block">Your Counter-Bid (NUM):</label>
                    <input
                      type="number"
                      value={bidAmount}
                      onChange={(e) => setBidAmount(e.target.value)}
                      placeholder={(selectedAuction.currentBid + 5).toString()}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-base font-mono text-white focus:outline-none focus:border-purple-500"
                    />
                    <div className="flex justify-between text-[11px] text-slate-500 font-mono">
                      <span>Town Hall Tax (3.5%):</span>
                      <span>{bidAmount ? (parseFloat(bidAmount) * 0.035).toFixed(2) : '0.00'} NUM</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => handlePlaceBid(selectedAuction.id)}
                  disabled={submitting || !bidAmount || parseFloat(bidAmount) <= selectedAuction.currentBid}
                  className="w-full py-3 rounded-xl bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 disabled:opacity-40 text-white font-bold text-xs shadow-xl shadow-purple-700/20 transition-all flex items-center justify-center space-x-2"
                >
                  <Gavel className="w-4 h-4" />
                  <span>{submitting ? 'Submitting Bid...' : `Confirm Bid (${bidAmount || 0} NUM)`}</span>
                </button>
              </div>
            )}

          </div>

        </div>

      </div>
    </div>
  );
}
