import React from 'react';
import { User } from 'firebase/auth';
import { LogOut, RotateCcw, Sparkles } from 'lucide-react';
import { isGeminiConfigured } from '../../services/aiMatchService';

interface AppHeaderProps {
  user: User;
  onReset: () => void;
  onLogout: () => void;
  onOpenAiSettings: () => void;
  aiKeyVersion?: number; // Used to trigger re-renders when key is updated
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  user,
  onReset,
  onLogout,
  onOpenAiSettings,
}) => {
  const hasAiKey = isGeminiConfigured();

  return (
    <header className="relative z-40 px-4 sm:px-6 py-4 md:py-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-sm">
        {/* Hospital Branding */}
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 flex items-center justify-center rounded-xl bg-slate-50 border border-slate-100 p-1.5 shrink-0">
            <img
              src="/elite_logo.png"
              alt="Elite Hospital Logo"
              width={40}
              height={40}
              className="w-10 h-10 object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2 leading-none">
              <h1 className="font-extrabold text-xl text-slate-900 tracking-tight font-display">
                Elite Pricelist Explorer
              </h1>
              <span className="text-xs font-black text-teal-700 bg-teal-50 border border-teal-200/60 px-2 py-0.5 rounded-full">
                v2.5
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-semibold mt-1">
              By Dr. Mohanad El Ma'moun • Corporate & Insurance Portal
            </p>
          </div>
        </div>

        {/* User Identity, AI Key Indicator & Global Controls */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* AI Settings Trigger */}
          <button
            type="button"
            onClick={onOpenAiSettings}
            className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 border cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none ${
              hasAiKey
                ? 'bg-amber-50/90 border-amber-300 text-amber-900 hover:bg-amber-100 shadow-2xs'
                : 'bg-rose-50 border-rose-300 text-rose-800 hover:bg-rose-100 animate-pulse'
            }`}
            title="Configure Gemini AI Key for custom procedure matching"
            aria-label="Configure Gemini AI Key"
          >
            <Sparkles size={13} className={hasAiKey ? 'text-amber-600' : 'text-rose-600'} />
            <span className="text-[11px]">{hasAiKey ? 'Gemini AI: Active' : 'Set Gemini Key'}</span>
          </button>

          <div className="flex items-center gap-2.5 bg-slate-50 border border-slate-200/80 rounded-full pl-2 pr-3 py-1.5 text-sm">
            {user.photoURL ? (
              <img
                src={user.photoURL}
                alt={user.displayName || 'User Avatar'}
                width={30}
                height={30}
                className="w-7 h-7 rounded-full border border-slate-200 object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-teal-700 font-bold text-white flex items-center justify-center text-xs shadow-sm">
                {user.email ? user.email.slice(0, 1).toUpperCase() : 'M'}
              </div>
            )}
            <span className="text-xs font-semibold text-slate-700 tracking-tight max-w-[140px] truncate">
              {user.email}
            </span>
            <div className="h-4 w-px bg-slate-200" />
            <button
              onClick={onReset}
              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-white rounded-full transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none"
              title="Reset Search and Selection"
              aria-label="Reset all search parameters"
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={onLogout}
              className="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-white rounded-full transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none"
              title="Sign Out"
              aria-label="Sign out of application"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
