import React, { useEffect, useState } from 'react';
import { useGame } from '../context/GameContext';
import {
  ShieldCheck,
  CreditCard,
  Copy,
  ArrowDownLeft,
  ArrowUpRight,
  Send,
  Server,
  Clock
} from 'lucide-react';

export default function WalletStatus() {
  const { wallet, network, user, setActiveModal, refreshWallet, addToast } = useGame();

  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'send'
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [receiveInfo, setReceiveInfo] = useState(null);
  const [receiveError, setReceiveError] = useState('');
  const [copiedAddress, setCopiedAddress] = useState(false);

  useEffect(() => {
    if (!user?.username) return undefined;
    let cancelled = false;

    const refreshReceiveInfo = async () => {
      try {
        const res = await fetch(`/api/wallet/receive?username=${encodeURIComponent(user.username)}`, {
          headers: { Authorization: `Bearer ${user.token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Unable to load receive address');
        if (!cancelled) {
          setReceiveInfo(data);
          setReceiveError('');
        }
      } catch (err) {
        if (!cancelled) setReceiveError(err.message);
      }
    };

    refreshReceiveInfo();
    const interval = setInterval(refreshReceiveInfo, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.username]);

  const copyReceiveAddress = async () => {
    try {
      await navigator.clipboard.writeText(receiveInfo.address);
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    } catch (err) {
      addToast(`Could not copy address: ${err.message}`, 'error');
    }
  };

  const handleSend = async () => {
    const val = parseFloat(amount);
    const to = recipient.replace(/^@/, '').trim().toLowerCase();
    if (!val || val <= 0) return addToast('Enter a valid transfer amount', 'error');
    if (!to) return addToast('Enter a recipient username', 'error');

    try {
      setSending(true);
      const res = await fetch('/api/wallet/transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-numista-user': user?.username || ''
        },
        body: JSON.stringify({ toUsername: to, amount: val })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      addToast(`${val} NUM to @${to} queued — confirms after ${data.job?.requiredConfirmations || 10} blocks`, 'success');
      setRecipient('');
      setAmount('');
      setActiveTab('overview');
      await refreshWallet();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const balance = wallet?.balance ?? 0;
  const pending = wallet?.pendingBalance ?? 0;
  const locked = wallet?.lockedBalance ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="bg-[#161d2a] border border-slate-700 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-slate-900 to-[#161d2a] border-b border-slate-800 flex items-start justify-between">
          <div className="flex items-center space-x-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center text-white shadow-lg border border-orange-300">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-[10px] font-mono uppercase font-bold text-orange-400 bg-orange-950 border border-orange-700/60 px-2 py-0.5 rounded">
                  Numista Chain Wallet
                </span>
                <span className={`text-xs font-mono flex items-center ${network?.chain?.ready ? 'text-emerald-400' : 'text-amber-400'}`}>
                  <span className={`w-2 h-2 rounded-full mr-1 ${network?.chain?.ready ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`}></span>
                  {network?.chain?.mode || 'offline'}
                </span>
              </div>
              <h2 className="text-xl font-bold text-white mt-1">@{user?.username || 'guest'}'s Balance</h2>
            </div>
          </div>
          <button
            onClick={() => setActiveModal(null)}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-slate-800 transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="px-6 pt-4 flex space-x-2 border-b border-slate-800 bg-slate-900/40">
          {[
            { id: 'overview', label: 'Wallet Overview' },
            { id: 'send', label: 'Send NUM' }
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`pb-3 text-xs font-bold transition-all border-b-2 px-3 ${
                activeTab === t.id
                  ? 'border-orange-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5">

          {activeTab === 'overview' && (
            <>
              {/* Balance Card */}
              <div className="p-5 rounded-2xl bg-gradient-to-br from-orange-950/20 via-slate-900 to-slate-900 border border-slate-800 flex items-center justify-between">
                <div>
                  <span className="text-xs text-slate-400 block font-mono">Available Balance</span>
                  <div className="text-3xl font-black font-mono text-orange-400 mt-1">
                    {balance.toFixed(4)} <span className="text-sm text-slate-400 font-normal">NUM</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[11px] font-mono">
                    {pending > 0 && (
                      <span className="text-amber-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> +{pending.toFixed(4)} pending
                      </span>
                    )}
                    {locked > 0 && <span className="text-slate-400">{locked.toFixed(4)} locked</span>}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="text-right">
                    <span className="text-xs text-slate-400 block font-mono">Chain Height</span>
                    <span className="text-sm font-bold text-white font-mono mt-1 block">
                      #{network?.height || 0}
                    </span>
                  </div>
                  <button
                    onClick={() => setActiveModal('buy_crypto')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold transition-colors"
                  >
                    <CreditCard className="w-3.5 h-3.5" />
                    Deposit NUM
                  </button>
                </div>
              </div>

              {/* Chain telemetry */}
              <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs font-mono space-y-1.5">
                <div className="flex justify-between text-slate-400">
                  <span className="flex items-center">
                    <Server className="w-3.5 h-3.5 mr-1.5 text-emerald-400" />
                    Chain mode:
                  </span>
                  <span className="text-emerald-400 font-bold">{network?.chain?.mode || 'unknown'}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Settlement depth:</span>
                  <span className="text-white">{network?.confirmationsRequired || 10} confirmations</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Ownership:</span>
                  <span className="text-white">@{user?.username || '—'}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Node:</span>
                  <span className="text-white">{network?.daemonAddress || '—'} · {network?.online ? 'online' : 'offline'}</span>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 space-y-3">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
                    Receive native NUM
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    This account-specific Numista address receives native coin through the blockchain. In-game NUM asset transfers still use your username.
                  </p>
                </div>
                {receiveError ? (
                  <div className="text-xs text-amber-300">{receiveError}</div>
                ) : receiveInfo ? (
                  <>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-200 break-all select-all">
                        {receiveInfo.address}
                      </code>
                      <button
                        onClick={copyReceiveAddress}
                        className="shrink-0 p-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200"
                        aria-label="Copy receive address"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                    {copiedAddress && <div className="text-[10px] text-emerald-400">Address copied</div>}
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-slate-400">Address balance</span>
                      <span className="text-white">{Number(receiveInfo.balance).toFixed(4)} NUM</span>
                    </div>
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-slate-400">Unlocked / pending</span>
                      <span className="text-slate-200">
                        {Number(receiveInfo.unlockedBalance).toFixed(4)} / {Number(receiveInfo.pendingBalance).toFixed(4)} NUM
                      </span>
                    </div>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {(receiveInfo.incomingTransfers || []).map(transfer => (
                        <div key={transfer.txHash} className="flex justify-between gap-2 text-[10px] font-mono text-slate-400">
                          <span className="truncate">{transfer.txHash}</span>
                          <span className="shrink-0 text-emerald-300">
                            +{Number(transfer.amount).toFixed(4)} · {transfer.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-500">Creating your receive address…</div>
                )}
              </div>

              {/* Transfers History */}
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono block">
                  Recent Ledger Transactions
                </span>

                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {(wallet?.recentTransfers || []).length === 0 ? (
                    <div className="text-xs text-slate-500 italic p-4 text-center">
                      No recent transfers recorded. Mine or buy NUM to begin.
                    </div>
                  ) : (
                    wallet.recentTransfers.map((tx, idx) => (
                      <div
                        key={tx.id || idx}
                        className="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center space-x-2.5 min-w-0">
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                            tx.amount >= 0 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-rose-950 text-rose-400 border border-rose-800'
                          }`}>
                            {tx.amount >= 0 ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-200 truncate">{tx.description}</div>
                            <div className="text-[10px] text-slate-500 font-mono truncate max-w-[200px]">
                              {tx.txHash ? `TX: ${tx.txHash}` : tx.status ? `Status: ${tx.status}` : 'Local ledger entry'}
                            </div>
                          </div>
                        </div>
                        <div className={`font-mono font-bold text-sm shrink-0 ${
                          tx.amount >= 0 ? 'text-emerald-400' : 'text-slate-200'
                        }`}>
                          {tx.amount >= 0 ? `+${Number(tx.amount).toFixed(4)}` : Number(tx.amount).toFixed(4)} NUM
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          {/* Send Transfer Tab */}
          {activeTab === 'send' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">Recipient Username:</label>
                  <input
                    type="text"
                    placeholder="@mercantile"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 font-mono text-xs text-white focus:outline-none focus:border-orange-500"
                  />
                  <p className="text-[10px] text-slate-500 font-mono mt-1">
                    In-game NUM transfers settle by username and do not need a recipient address.
                  </p>
                </div>

                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>Amount (NUM):</span>
                    <span className="font-mono">Available: {balance.toFixed(4)} NUM</span>
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 font-mono text-base text-white focus:outline-none focus:border-orange-500"
                    />
                    <button
                      onClick={() => setAmount(balance.toString())}
                      className="absolute right-3 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded bg-slate-800 text-[10px] font-mono text-orange-400"
                    >
                      MAX
                    </button>
                  </div>
                </div>
              </div>

              <button
                onClick={handleSend}
                disabled={sending || !amount || !recipient || balance <= 0}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 disabled:opacity-40 text-white font-bold text-xs shadow-xl shadow-orange-700/20 transition-all flex items-center justify-center space-x-2"
              >
                <Send className="w-4 h-4" />
                <span>{sending ? 'Broadcasting Transfer...' : `Send ${amount || 0} NUM`}</span>
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
