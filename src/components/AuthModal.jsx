import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import { 
  ShieldCheck, 
  Key, 
  User, 
  Lock, 
  Coins, 
  Sparkles, 
  ArrowRight, 
  Eye, 
  EyeOff 
} from 'lucide-react';

export default function AuthModal({ onLoginSuccess }) {
  const { login, register, addToast } = useGame();

  const [tab, setTab] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e?.preventDefault();
    if (!username) return addToast('Please enter your username', 'error');

    try {
      setLoading(true);
      await login(username, password || 'password123');
      addToast(`Welcome back, @${username}!`, 'success');
      if (onLoginSuccess) onLoginSuccess();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e?.preventDefault();
    if (!username || username.length < 3) {
      return addToast('Username must be at least 3 characters', 'error');
    }

    try {
      setLoading(true);
      await register(username, password || 'password123');
      addToast(`Account created for @${username}!`, 'success');
      if (onLoginSuccess) onLoginSuccess();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-slate-700 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        
        {/* Banner */}
        <div className="p-6 bg-gradient-to-br from-orange-950/70 via-slate-900 to-[#161d2a] border-b border-slate-800 text-center relative">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-orange-600 to-amber-500 mx-auto flex items-center justify-center shadow-xl shadow-orange-500/20 border border-orange-400/40 mb-3">
            <Coins className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-2xl font-black font-mono tracking-wider text-white">
            GOLD<span className="text-orange-500">NUMISTA</span>
          </h2>
          <p className="text-xs text-slate-400 font-mono mt-1">
            Numista Coin Monero Fork • UK Economic Land Registry
          </p>

          {/* Tab Selector */}
          <div className="flex rounded-xl bg-slate-950 p-1 mt-5 border border-slate-800">
            <button
              onClick={() => setTab('login')}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                tab === 'login' ? 'bg-orange-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => setTab('register')}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                tab === 'register' ? 'bg-orange-600 text-white shadow-md' : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account & Wallet
            </button>
          </div>
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-4">

          {tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1 font-mono">Username:</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    placeholder="e.g. danie"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1 font-mono">Password:</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              {/* Quick Demo Login Option */}
              <div className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs flex items-center justify-between">
                <span className="text-slate-400 font-mono">Developer Account:</span>
                <button
                  type="button"
                  onClick={() => { setUsername('danie'); setPassword('password123'); }}
                  className="text-orange-400 hover:underline font-mono font-bold"
                >
                  Fill @danie
                </button>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold text-sm shadow-xl shadow-orange-600/30 transition-all flex items-center justify-center space-x-2"
              >
                <span>{loading ? 'Authenticating...' : 'Sign In to Game'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label className="text-xs text-slate-400 block mb-1 font-mono">Choose Username:</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    placeholder="e.g. SovereignBaron"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-orange-500"
                  />
                </div>
                <span className="text-[10px] text-slate-500 font-mono mt-1 block">
                  Open your wallet after signing up to get your unique Numista receive address.
                </span>
              </div>

              <div>
                <label className="text-xs text-slate-400 block mb-1 font-mono">Password (Optional):</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    placeholder="Create a password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-10 pr-4 py-2.5 text-sm font-mono text-white focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-sm shadow-xl shadow-emerald-700/20 transition-all flex items-center justify-center space-x-2"
              >
                <span>{loading ? 'Creating Account...' : 'Create Account'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

        </div>

      </div>
    </div>
  );
}
