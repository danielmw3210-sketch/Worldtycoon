import React, { useState } from 'react';
import { useGame } from '../context/GameContext';
import GameSprite from './GameSprite';
import { buildingSprite, itemSprite } from './sprites';

export default function AuthModal({ onLoginSuccess }) {
  const { setUser, setActiveModal, addToast } = useGame();
  const [tab, setTab] = useState('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [pendingAuth, setPendingAuth] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e?.preventDefault();
    const id = identifier.trim();
    const pw = password.trim();
    if (!id) return addToast('Enter your address or @username', 'error');
    if (!pw) return addToast('Enter your secret password (64-char hash shown at registration)', 'error');
    try {
      setLoading(true);
      // Try wallet-login (blockchain identity) first, fall back to legacy login
      const res = await fetch('/api/auth/wallet-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: id, password: pw })
      });
      const data = await res.json();
      if (!res.ok) {
        // Fallback: try legacy username+password login (for older accounts)
        const res2 = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: id.replace(/^@/, ''), password: pw })
        });
        const data2 = await res2.json();
        if (!res2.ok) throw new Error(data.error || data2.error || 'Login failed');
        const authObj = { username: data2.username, displayHandle: data2.username, role: data2.role || 'user', token: data2.token, address: null };
        localStorage.setItem('goldnumista_user', JSON.stringify(authObj));
        setUser(authObj);
        addToast('Signed in as @' + data2.username, 'success');
        setActiveModal(null);
        if (onLoginSuccess) onLoginSuccess();
        return;
      }
      const authObj = {
        username: data.username,
        displayHandle: data.displayHandle || data.username,
        role: data.role || 'user',
        token: data.token,
        address: data.address
      };
      localStorage.setItem('goldnumista_user', JSON.stringify(authObj));
      setUser(authObj);
      addToast('Signed in as @' + (data.displayHandle || data.username), 'success');
      setActiveModal(null);
      if (onLoginSuccess) onLoginSuccess();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e?.preventDefault();
    try {
      setLoading(true);
      const res = await fetch('/api/auth/wallet-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Registration failed');
      const authObj = {
        username: data.username,
        displayHandle: data.displayHandle || data.username,
        role: data.role || 'user',
        token: data.token,
        address: data.address
      };
      setAccepted(false);
      setPendingAuth(authObj);
      setReceipt(data);
      addToast(
        data.simulated
          ? 'Simulation account created. Save your secret password before continuing.'
          : 'Blockchain identity created! Save your secret password before continuing.',
        'success'
      );
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const copyAll = () => {
    if (!receipt) return;
    const text = [
      '=== WORLDTYCOON BLOCKCHAIN IDENTITY ===',
      'Username: ' + receipt.username,
      ...(receipt.address ? ['Address:  ' + receipt.address] : []),
      'Secret:   ' + receipt.secretPassword,
      receipt.txHash ? ('Tx Hash:  ' + receipt.txHash) : '',
      receipt.simulated ? 'Mode:     Simulated only; no real blockchain identity was created.' : '',
      '',
      'KEEP THIS SAFE — it is your login password.',
      'You CANNOT recover it if lost.'
    ].filter(Boolean).join('\n');
    navigator.clipboard.writeText(text).then(() => addToast('Copied to clipboard!', 'success')).catch(() => {});
  };

  const enterGame = () => {
    if (!accepted || !pendingAuth) return;
    localStorage.setItem('goldnumista_user', JSON.stringify(pendingAuth));
    setUser(pendingAuth);
    setActiveModal(null);
    onLoginSuccess?.();
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center p-4 game-modal-backdrop'>
      <div className='game-modal-panel w-full max-w-md rounded-2xl overflow-y-auto'>
        {/* Header */}
        <div className='game-modal-header p-5 text-center'>
          <div className='flex justify-center gap-2 mb-3'>
            <GameSprite sprite={buildingSprite({ type: 'peasant_lodge' })} className='game-art--small' />
            <GameSprite sprite={buildingSprite({ type: 'castle_keep' })} className='game-art--small' />
            <GameSprite sprite={itemSprite('knight')} className='game-art--small' />
          </div>
          <div className='text-xs font-mono uppercase text-orange-400 font-bold tracking-widest'>
            {receipt?.simulated ? 'Worldtycoon Simulation Account' : 'Numista Blockchain Identity'}
          </div>
          <h2 className='text-xl font-black text-white mt-1'>Worldtycoon</h2>
          <p className='text-xs text-slate-400 mt-1'>
            {receipt?.simulated
              ? 'A local test identity for exploring Worldtycoon'
              : 'A wallet-backed identity secured by the Numista blockchain'}
          </p>
        </div>

        <div className='p-5 space-y-4'>
          {/* Receipt view — shown after successful registration */}
          {receipt ? (
            <div className='space-y-3'>
              <div className='p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/50'>
                <div className='text-xs font-bold text-emerald-400 mb-2'>
                  {receipt.simulated ? 'Simulation Account · No real chain transaction' : '✅ Identity Minted On-Chain'}
                </div>
                <div className='space-y-2'>
                  <div>
                    <div className='text-[10px] text-slate-400 uppercase font-bold'>Username</div>
                    <div className='text-sm font-mono text-white'>@{receipt.username}</div>
                  </div>
                  {receipt.address && <div>
                    <div className='text-[10px] text-slate-400 uppercase font-bold'>Wallet Address</div>
                    <div className='text-[11px] font-mono text-cyan-300 break-all bg-slate-950/60 p-2 rounded border border-slate-700'>{receipt.address}</div>
                  </div>}
                  {receipt.simulated && (
                    <p className='text-xs text-amber-200'>
                      This local test account has no real wallet address or on-chain identity. Its game activity is simulated.
                    </p>
                  )}
                  <div>
                    <div className='text-[10px] text-slate-400 uppercase font-bold'>⚠️ Secret Login Password (Save This!)</div>
                    <div className='text-[11px] font-mono text-amber-300 break-all bg-slate-950/80 p-2 rounded border border-amber-600/50 select-all'>{receipt.secretPassword}</div>
                  </div>
                  {receipt.txHash && (
                    <div>
                      <div className='text-[10px] text-slate-400 uppercase font-bold'>Registration Tx Hash</div>
                      <div className='text-[10px] font-mono text-slate-300 break-all'>{receipt.txHash}</div>
                    </div>
                  )}
                </div>
              </div>

              <div className='p-3 rounded-xl bg-red-950/30 border border-red-500/40'>
                <p className='text-xs text-red-300 font-semibold'>⚠️ Your secret password is your ONLY way to sign in. It is NOT stored on our servers after you leave this page. If you lose it, your account cannot be recovered.</p>
              </div>

              <label className='flex items-center gap-2 text-xs text-slate-200 cursor-pointer'>
                <input type='checkbox' checked={accepted} onChange={e => setAccepted(e.target.checked)} className='w-4 h-4' />
                I have saved my secret password and registration details
              </label>

              <div className='flex gap-2'>
                <button
                  type='button'
                  onClick={copyAll}
                  className='flex-1 py-2.5 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition-colors'
                >
                  📋 Copy All Details
                </button>
                <button
                  type='button'
                  disabled={!accepted || !pendingAuth}
                  onClick={enterGame}
                  className='flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold transition-colors'
                >
                  Enter Game →
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Tab switcher */}
              <div className='grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800'>
                <button
                  type='button'
                  onClick={() => setTab('login')}
                  className={'py-2 rounded-lg text-xs font-bold transition-colors ' + (tab === 'login' ? 'bg-orange-600 text-white' : 'text-slate-400 hover:text-white')}
                >
                  Sign In
                </button>
                <button
                  type='button'
                  onClick={() => setTab('register')}
                  className={'py-2 rounded-lg text-xs font-bold transition-colors ' + (tab === 'register' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white')}
                >
                  New Account
                </button>
              </div>

              {tab === 'login' ? (
                <form onSubmit={handleLogin} className='space-y-3'>
                  <div>
                    <label className='text-xs text-slate-400 block mb-1'>Address or @username</label>
                    <input
                      type='text'
                      value={identifier}
                      onChange={e => setIdentifier(e.target.value)}
                      placeholder='S... wallet address or @username'
                      className='w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 focus:border-orange-500 text-xs font-mono text-white outline-none transition-colors'
                    />
                  </div>
                  <div>
                    <label className='text-xs text-slate-400 block mb-1'>Secret password (64-char hash)</label>
                    <input
                      type='password'
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder='Your 64-character secret shown at registration'
                      className='w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-700 focus:border-orange-500 text-xs font-mono text-white outline-none transition-colors'
                    />
                  </div>
                  <button
                    disabled={loading}
                    type='submit'
                    className='w-full py-2.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-bold transition-colors'
                  >
                    {loading ? '⏳ Verifying on blockchain...' : '🔑 Sign In'}
                  </button>
                  <p className='text-[10px] text-slate-500 text-center'>Your secret is verified against the Numista blockchain — no server password storage.</p>
                </form>
              ) : (
                <form onSubmit={handleRegister} className='space-y-3'>
                  <div className='p-3 rounded-xl bg-slate-800/60 border border-slate-700 space-y-2'>
                    <p className='text-xs text-slate-300 font-semibold'>How it works:</p>
                    <ul className='text-xs text-slate-400 space-y-1 list-disc list-inside'>
                      <li>Live mode creates a wallet-backed identity; simulation mode creates a local test account</li>
                      <li>You receive a unique 64-character secret hash as your password</li>
                      <li>Your username is generated for the active network mode</li>
                      <li>No email, phone, or personal data needed</li>
                    </ul>
                  </div>
                  <button
                    disabled={loading}
                    type='submit'
                    className='w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-bold transition-colors'
                  >
                    {loading ? 'Creating Account...' : 'Create Account'}
                  </button>
                  <p className='text-[10px] text-slate-500 text-center'>Live registration requires wallet-RPC; simulation mode uses local test identities.</p>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
