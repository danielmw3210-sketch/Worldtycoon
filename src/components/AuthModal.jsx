import React, { useState } from 'react';
import { useGame } from '../context/GameContext';

export default function AuthModal({ onLoginSuccess }) {
  const { setUser, setActiveModal, addToast } = useGame();
  const [tab, setTab] = useState('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e?.preventDefault();
    if (!identifier.trim()) return addToast('Enter your Sb... / UGN... address or @username', 'error');
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
      const authObj = { username: data.username, displayHandle: data.displayHandle || 'unknown', role: data.role, token: data.token, address: data.address };
      localStorage.setItem('goldnumista_user', JSON.stringify(authObj));
      setUser(authObj);
      addToast('Signed in to ' + (data.address ? data.address.slice(0, 12) + '...' : data.username), 'success');
      setActiveModal(null); if (onLoginSuccess) onLoginSuccess();
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
      setReceipt(data);
      const authObj = { username: data.username, displayHandle: data.displayHandle || 'unknown', role: data.role, token: data.token, address: data.address };
      localStorage.setItem('goldnumista_user', JSON.stringify(authObj));
      setUser(authObj);
      addToast('On-chain address created! Copy and save your Sb... / UGN... address.', 'success');
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (<div className='fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md'><div className='bg-[#161d2a] border border-slate-700 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden'><div className='p-5 bg-gradient-to-br from-orange-950/70 via-slate-900 to-[#161d2a] border-b border-slate-800 text-center'><div className='text-xs font-mono uppercase text-orange-400 font-bold'>Numista Blockchain Identity</div><h2 className='text-xl font-black text-white'>Goldnumista Wallet Auth</h2></div><div className='p-5 space-y-4'>{!receipt&&(<div className='grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800'><button type='button' onClick={()=>setTab('login')} className={'py-2 rounded-lg text-xs font-bold '+(tab==='login'?'bg-orange-600 text-white':'text-slate-400')}>Sign In</button><button type='button' onClick={()=>setTab('register')} className={'py-2 rounded-lg text-xs font-bold '+(tab==='register'?'bg-amber-600 text-white':'text-slate-400')}>New Account</button></div>)}{receipt?(<div className='p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/40 space-y-3'><div className='text-xs font-bold text-emerald-400'>On-Chain Identity Minted (@{receipt.username})</div><div className='text-[11px] font-mono text-white break-all bg-slate-950 p-2 rounded border border-slate-800'>Address: {receipt.address}</div><div className='text-[11px] font-mono text-amber-300 break-all bg-slate-950 p-2 rounded border border-amber-500/40'>Secret Password: {receipt.secretPassword}</div><div className='text-[10px] font-mono text-cyan-300 break-all'>Tx Hash: {receipt.txHash}</div><label className='flex items-center gap-2 text-xs text-slate-200 cursor-pointer'><input type='checkbox' checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>I have copied &amp; saved my secret hash password</label><div className='flex gap-2'><button type='button' onClick={()=>{navigator.clipboard.writeText([receipt.address,receipt.secretPassword,receipt.txHash].join(String.fromCharCode(10)));addToast('Copied!','success');}} className='flex-1 py-2 rounded-xl bg-slate-800 text-white text-xs font-bold'>Copy All</button><button type='button' disabled={!accepted} onClick={()=>{setActiveModal(null);onLoginSuccess?.();}} className='flex-1 py-2 rounded-xl bg-emerald-600 disabled:opacity-40 text-white text-xs font-bold'>I Accept &amp; Enter</button></div></div>):tab==='login'?(<form onSubmit={handleLogin} className='space-y-3'><input type='text' value={identifier} onChange={e=>setIdentifier(e.target.value)} placeholder='UGN... address or @username' className='w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white'/><input type='password' value={password} onChange={e=>setPassword(e.target.value)} placeholder='Secret transaction hash password' className='w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-xs font-mono text-white'/><button disabled={loading} type='submit' className='w-full py-2.5 rounded-xl bg-orange-600 text-white text-xs font-bold'>{loading?'Verifying...':'Sign In'}</button></form>):(<form onSubmit={handleRegister} className='space-y-3'><p className='text-xs text-slate-300'>No password needed — a secret 64-character transaction hash password will be generated directly on the Numista blockchain when your account is minted.</p><button disabled={loading} type='submit' className='w-full py-2.5 rounded-xl bg-amber-600 text-white text-xs font-bold'>{loading?'Minting on Blockchain...':'Generate Blockchain Account'}</button></form>)}</div></div></div>);}