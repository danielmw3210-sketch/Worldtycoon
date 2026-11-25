import React, { useState } from 'react';
import { useGame } from '../context/GameContext';

export default function AuthModal({ onLoginSuccess }) {
  const { setUser, addToast } = useGame();
  const [tab, setTab] = useState('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [generatedAddress, setGeneratedAddress] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e?.preventDefault();
    if (!identifier.trim()) return addToast('Enter your Sb... address or @username', 'error');
    if (!password) return addToast('Enter your password', 'error');
    try {
      setLoading(true);
      const res = await fetch('/api/auth/wallet-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      const authObj = { username: data.username, role: data.role, token: data.token, address: data.address };
      localStorage.setItem('goldnumista_user', JSON.stringify(authObj));
      setUser(authObj);
      addToast('Signed in to ' + (data.address ? data.address.slice(0, 12) + '...' : data.username), 'success');
      if (onLoginSuccess) onLoginSuccess();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e?.preventDefault();
    if (!password || password.length < 4) return addToast('Password must be at least 4 characters', 'error');
    try {
      setLoading(true);
      const res = await fetch('/api/auth/wallet-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      setGeneratedAddress(data.address || '');
      const authObj = { username: data.username, role: data.role, token: data.token, address: data.address };
      localStorage.setItem('goldnumista_user', JSON.stringify(authObj));
      setUser(authObj);
      addToast('On-chain address created! Copy and save your Sb... address.', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md">
      <div className="bg-[#161d2a] border border-slate-700 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <div className="p-5 bg-gradient-to-br from-orange-950/70 via-slate-900 to-[#161d2a] border-b border-slate-800 text-center">
          <div className="text-xs font-mono uppercase tracking-wider text-orange-400 font-bold mb-1">Numista Blockchain Identity</div>
          <h2 className="text-xl font-black text-white">Goldnumista Wallet Auth</h2>
          <p className="text-xs text-slate-400 mt-1">Zero database · Verified directly against your on-chain Sb... address</p>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800">
            <button type="button" onClick={() => { setTab('login'); setGeneratedAddress(''); }} className={'py-2 rounded-lg text-xs font-bold ' + (tab === 'login' ? 'bg-orange-600 text-white' : 'text-slate-400')}>Sign In (Address)</button>
            <button type="button" onClick={() => { setTab('register'); setGeneratedAddress(''); }} className={'py-2 rounded-lg text-xs font-bold ' + (tab === 'register' ? 'bg-amber-600 text-white' : 'text-slate-400')}>New Address</button>
          </div>

          {generatedAddress ? (
            <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 space-y-3">
              <div className="text-xs font-bold text-emerald-400">Your New On-Chain Address Is Ready!</div>
              <p className="text-[11px] text-slate-300">Save this address—use it with your password to sign in anytime, or claim a @username inside your Account panel for minting.</p>
              <div className="font-mono text-[11px] text-white break-all bg-slate-950 p-2.5 rounded-lg border border-slate-800 select-all">{generatedAddress}</div>
              <div className="flex gap-2">
                <button type="button" onClick={() => { navigator.clipboard.writeText(generatedAddress); addToast('Address copied!', 'success'); }} className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold">Copy Address</button>
                <button type="button" onClick={() => { if (onLoginSuccess) onLoginSuccess(); }} className="flex-1 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">Enter Game</button>
              </div>
            </div>
          ) : tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-3">
              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Sb... Address or Claimed @Username</label>
                <input type="text" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="Sb... or @username" className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" />
              </div>
              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" />
              </div>
              <button disabled={loading} type="submit" className="w-full py-2.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold">{loading ? 'Verifying on-chain...' : 'Sign In via Blockchain'}</button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3">
              <p className="text-[11px] text-slate-400">Creates a brand-new isolated <span className="text-orange-300 font-mono">Sb...</span> deposit & minting address on the Numista blockchain secured by your password.</p>
              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1">Set Wallet Password (min 4 chars)</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Choose a strong password" className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white" />
              </div>
              <button disabled={loading} type="submit" className="w-full py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold">{loading ? 'Generating Sb... Address...' : 'Generate Blockchain Address'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}