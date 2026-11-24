import React, { createContext, useContext, useState, useEffect, useRef } from 'react';

const GameContext = createContext(null);

export function GameProvider({ children }) {
  // Auth & User State
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('goldnumista_user');
      return saved ? JSON.parse(saved) : null;
    } catch (e) {
      return null;
    }
  });

  // Game & Map State
  const [plots, setPlots] = useState([]);
  const [selectedPlot, setSelectedPlot] = useState(null);
  const [activeRegion, setActiveRegion] = useState('ALL');
  const [loading, setLoading] = useState(true);

  // Map Tile Style (CARTO Dark, OSM Standard, Esri Satellite)
  const [mapStyle, setMapStyle] = useState(() => {
    return localStorage.getItem('goldnumista_map_style') || 'osm_streets';
  });

  // User & in-game NUM asset state (native-coin receive data loads in WalletStatus)
  const [wallet, setWallet] = useState({
    balance: 0,
    unlockedBalance: 0,
    pendingBalance: 0,
    lockedBalance: 0,
    totalBalance: 0,
    recentTransfers: []
  });

  // Network State
  const [network, setNetwork] = useState({
    height: 0,
    difficulty: 0,
    ticker: "NUM",
    claimPrice: 50,
    online: false,
    daemonAddress: "http://127.0.0.1:48081",
    confirmationsRequired: 10,
    chain: null,
    crownEstateFund: null,
    syncStatus: { synchronized: false, height: 0, targetHeight: 0, syncPercentage: 0 }
  });

  // Active Modals: 'plot_details' | 'bank' | 'auction' | 'stock' | 'miner' | 'buy_crypto' | 'town_hall' | 'sync_settings' | 'auth' | 'account' | 'wallet_details'
  const [activeModal, setActiveModal] = useState(null);
  const [modalData, setModalData] = useState(null);

  // In-Browser Mining Engine State (OFF BY DEFAULT)
  const [isMining, setIsMining] = useState(false);
  const [miningMode, setMiningMode] = useState('pplns');
  const [threads, setThreads] = useState(Math.min(4, navigator.hardwareConcurrency || 2));
  const [hashrate, setHashrate] = useState(0);
  const [totalHashes, setTotalHashes] = useState(0);
  const [sharesSubmitted, setSharesSubmitted] = useState(0);
  const [minedSessionNum, setMinedSessionNum] = useState(0);
  const workersRef = useRef([]);

  // Toast feedback
  const [toasts, setToasts] = useState([]);

  const sessionHeaders = (headers = {}) => ({
    ...headers,
    Authorization: `Bearer ${user?.token || ''}`
  });

  const addToast = (message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4500);
  };

  // Auth Functions
  const login = async (username, password) => {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Login failed');
  }

  const authUser = {
    username: data.username,
    role: data.role || 'user',
    token: data.token || ''
  };

  console.log('LOGIN RESPONSE:', data);
  console.log('AUTH USER:', authUser);

  setUser(authUser);

  localStorage.setItem(
    'goldnumista_user',
    JSON.stringify(authUser)
  );

  if (authUser.token) {
    await refreshWallet(authUser.username, authUser.token);
  }

  return authUser;
};

const register = async (username, password) => {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Registration failed');
  }

  const authUser = {
    username: data.username,
    role: data.role || 'user',
    token: data.token || ''
  };

  console.log('REGISTER RESPONSE:', data);
  console.log('AUTH USER:', authUser);

  setUser(authUser);

  localStorage.setItem(
    'goldnumista_user',
    JSON.stringify(authUser)
  );

  if (authUser.token) {
    await refreshWallet(authUser.username, authUser.token);
  }

  return authUser;
};

  const logout = () => {
    stopMining();
    setUser(null);
    setWallet({ balance: 0, unlockedBalance: 0, pendingBalance: 0, lockedBalance: 0, totalBalance: 0, recentTransfers: [] });
    localStorage.removeItem('goldnumista_user');
    addToast('Logged out of Goldnumista', 'info');
  };

  // Refresh Plots
  const refreshPlots = async () => {
    try {
      const res = await fetch('/api/plots');
      if (res.ok) {
        const data = await res.json();
        setPlots(data.plots || []);
      }
    } catch (err) {
      console.error("Failed to fetch plots:", err);
    }
  };

  // Refresh Wallet
  const refreshWallet = async (username, token = user?.token) => {
    try {
      const currentUsername = username || user?.username;
      if (!currentUsername || !token) return;
      const res = await fetch(`/api/wallet?username=${encodeURIComponent(currentUsername)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setWallet(data);
      }
    } catch (err) {
      console.error("Failed to fetch wallet:", err);
    }
  };

  // Refresh Blockchain Network Info (public route; admin-only details stay out)
  const refreshNetwork = async () => {
    try {
      const netRes = await fetch('/api/network');
      if (netRes.ok) {
        const data = await netRes.json();
        setNetwork({
          ...data.network,
          ...data.config,
          chain: data.chain || null,
          crownEstateFund: data.crownEstateFund || null,
          daemonAddress: data.network?.daemonAddress || "http://127.0.0.1:48081",
          details: null
        });
      }
    } catch (err) {
      console.error("Failed to fetch network:", err);
    }
  };

  // Fetch current user's account and deeds
  const fetchAccount = async (username) => {
    const target = username || user?.username;
    if (!target) return null;
    const res = await fetch(`/api/account?username=${encodeURIComponent(target)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load account');
    }
    return res.json();
  };

  // Backfill role for sessions saved before roles existed
  useEffect(() => {
    if (!user?.username || user.role) return;
    let cancelled = false;
    fetch(`/api/auth/me?username=${encodeURIComponent(user.username)}`, { headers: sessionHeaders() })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled || !data?.role) return;
        const next = { ...user, role: data.role };
        setUser(next);
        localStorage.setItem('goldnumista_user', JSON.stringify(next));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    Promise.all([refreshPlots(), refreshWallet(), refreshNetwork()]).finally(() => {
      setLoading(false);
    });

    const interval = setInterval(() => {
      refreshPlots();
      refreshWallet();
      refreshNetwork();
    }, 7000);

    return () => clearInterval(interval);
  }, [user]);

  // Sync selected plot if plots change
  useEffect(() => {
    if (selectedPlot) {
      const updated = plots.find(p => p.id === selectedPlot.id);
      if (updated) setSelectedPlot(updated);
    }
  }, [plots]);

  // In-Browser Mining Lifecycle (Explicitly user-activated)
  const startMining = async () => {
    try {
      const res = await fetch('/api/mining/job?username=' + encodeURIComponent(user?.username||'') + '&mode=' + miningMode);
      const job = await res.json();

      stopMiningWorkers();

      const newWorkers = [];
      for (let i = 0; i < threads; i++) {
        const worker = new Worker(new URL('../workers/miner.worker.js', import.meta.url), { type: 'module' });
        
        worker.onmessage = async (e) => {
          const { type, hashes, hashrate: workerHashrate, nonce, hash, jobId } = e.data;
          
          if (type === 'HASH_STATS') {
            setTotalHashes(prev => prev + hashes);
            setHashrate(workerHashrate * threads);
          } else if (type === 'SHARE_FOUND') {
            try {
              const subRes = await fetch('/api/mining/submit', {
                method: 'POST',
                headers: sessionHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                  minerId: `browser-worker-thread-${i}`,
                  jobId,
                  nonce,
                  hash,
                  username: user?.username || "danie"
                })
              });
              if (subRes.ok) {
                const subData = await subRes.json();
                if (subData.accepted) {
                  setSharesSubmitted(prev => prev + 1);
                  setMinedSessionNum(prev => +(prev + subData.reward).toFixed(4));
                  addToast(`Mining share accepted — NUM mints after 10 confirmations`, 'success');
                  refreshWallet();
                  if (subData.newJob) {
                    worker.postMessage({ type: 'UPDATE_JOB', job: subData.newJob });
                  }
                }
              }
            } catch (err) {
              console.error("Failed to submit share:", err);
            }
          }
        };

        worker.postMessage({ type: 'START', job });
        newWorkers.push(worker);
      }

      workersRef.current = newWorkers;
      setIsMining(true);
      addToast(`In-browser miner started with ${threads} CPU threads!`, 'info');
    } catch (err) {
      addToast(`Mining failed to start: ${err.message}`, 'error');
    }
  };

  const stopMiningWorkers = () => {
    workersRef.current.forEach(w => {
      w.postMessage({ type: 'STOP' });
      w.terminate();
    });
    workersRef.current = [];
    setHashrate(0);
  };

  const stopMining = () => {
    stopMiningWorkers();
    setIsMining(false);
    addToast("Browser miner stopped", 'info');
  };

  // Poll an on-chain job until it settles. Mints confirm after N blocks; on
  // failure the server restores the pre-transaction state.
  const watchJob = async (jobId) => {
    if (!jobId) return null;
    const terminal = new Set(['confirmed', 'reverted', 'failed', 'revert_failed']);
    for (let i = 0; i < 1200; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        if (!res.ok) continue;
        const { job } = await res.json();
        if (!job) continue;
        if (terminal.has(job.status)) {
          if (job.status === 'confirmed') {
            addToast(`On-chain settlement complete (${job.requiredConfirmations} confirmations)`, 'success');
          } else {
            addToast(`Transaction ${job.status}: ${job.failure || 'reverted'}`, 'error');
          }
          refreshPlots();
          refreshWallet();
          return job;
        }
      } catch { /* keep polling */ }
    }
    return null;
  };

  // Claim Plot Action (registers the deed to a USERNAME; wallet stays private)
  const claimPlot = async (plotId) => {
    try {
      const res = await fetch(`/api/plots/${plotId}/claim`, {
        method: 'POST',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username: user?.username || "danie" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Claim failed");

      addToast(data.message || `Claim submitted for ${plotId}`, 'success');
      await refreshPlots();
      await refreshWallet();
      watchJob(data.job?.id);
      return data;
    } catch (err) {
      addToast(err.message, 'error');
      throw err;
    }
  };

  // Claim Town Hall Taxes
  const claimTownHallTaxes = async (plotId) => {
    try {
      const res = await fetch(`/api/plots/${plotId}/town-hall/claim-taxes`, {
        method: 'POST',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username: user?.username || "danie" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to claim taxes");

      addToast(`${data.claimedAmount} NUM tax dividend submitted to the blockchain`, 'info');
      await refreshPlots();
      await refreshWallet();
      watchJob(data.job?.id);
      return data;
    } catch (err) {
      addToast(err.message, 'error');
      throw err;
    }
  };

  // Collect accrued rental / utility income from an owned property
  const collectIncome = async (plotId) => {
    try {
      const res = await fetch(`/api/plots/${plotId}/collect-income`, {
        method: 'POST',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username: user?.username || "danie" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to collect income");

      const bonus = data.multiplier && data.multiplier !== 1
        ? ` (dice ×${data.multiplier})`
        : '';
      addToast(`${data.amount.toLocaleString()} NUM${bonus} submitted as a Crown reserve transfer`, 'info');
      await refreshPlots();
      await refreshWallet();
      watchJob(data.job?.id);
      return data;
    } catch (err) {
      addToast(err.message, 'error');
      throw err;
    }
  };

  // Upgrade an income property one level (max 5)
  const upgradePlot = async (plotId) => {
    try {
      const res = await fetch(`/api/plots/${plotId}/upgrade`, {
        method: 'POST',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ username: user?.username || "danie" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upgrade failed");

      addToast(`Upgrade to level ${data.level} submitted — payment confirms in ${data.job?.requiredConfirmations || 10} blocks`, 'success');
      await refreshPlots();
      await refreshWallet();
      watchJob(data.job?.id);
      return data;
    } catch (err) {
      addToast(err.message, 'error');
      throw err;
    }
  };

  // Admin only: strike a gold/silver coin at a mint plot
  const issueMint = async ({ metal, weightGrams, purity, mintPlotId }) => {
    try {
      const res = await fetch('/api/mint/issue', {
        method: 'POST',
        headers: sessionHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          metal,
          weightGrams,
          purity,
          mintPlotId,
          username: user?.username || "danie"
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Minting failed");

      addToast(`Minting fee submitted on-chain; ${data.coin.id} is pending confirmation`, 'info');
      await refreshPlots();
      await refreshWallet();
      watchJob(data.job?.id);
      return data;
    } catch (err) {
      addToast(err.message, 'error');
      throw err;
    }
  };

  return (
    <GameContext.Provider
      value={{
        user,
        login,
        register,
        logout,
        plots,
        selectedPlot,
        setSelectedPlot,
        activeRegion,
        setActiveRegion,
        mapStyle,
        setMapStyle,
        wallet,
        network,
        loading,
        refreshPlots,
        refreshWallet,
        refreshNetwork,
        fetchAccount,
        claimPlot,
        claimTownHallTaxes,
        collectIncome,
        upgradePlot,
        issueMint,
        // Modals
        activeModal,
        setActiveModal,
        modalData,
        setModalData,
        // Mining (Off by default)
        isMining, miningMode, setMiningMode,
        threads,
        setThreads,
        hashrate,
        totalHashes,
        sharesSubmitted,
        minedSessionNum,
        startMining,
        stopMining,
        // Toasts
        toasts,
        addToast
      }}
    >
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  return useContext(GameContext);
}
