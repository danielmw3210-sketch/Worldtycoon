import React from 'react';
import { useGame } from '../context/GameContext';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';

export default function TransactionToast() {
  const { toasts } = useGame();

  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col space-y-2 pointer-events-none max-w-sm w-full">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`pointer-events-auto p-3.5 rounded-xl border shadow-2xl backdrop-blur-md flex items-center space-x-2.5 transition-all animate-bounceIn ${
            toast.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/80 text-emerald-200'
              : toast.type === 'error'
                ? 'bg-rose-950/90 border-rose-500/80 text-rose-200'
                : 'bg-slate-900/90 border-orange-500/80 text-slate-200'
          }`}
        >
          {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
          {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />}
          {toast.type === 'info' && <Info className="w-5 h-5 text-orange-400 shrink-0" />}
          
          <div className="text-xs font-medium leading-snug">
            {toast.message}
          </div>
        </div>
      ))}
    </div>
  );
}
