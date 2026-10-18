import React from 'react';
import { User } from 'firebase/auth';
import { LogOut, RotateCcw } from 'lucide-react';

interface AppHeaderProps {
  user: User;
  onReset: () => void;
  onLogout: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({ user, onReset, onLogout }) => {
  return (
    <header className="relative z-40 px-4 sm:px-6 py-4 md:py-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-sm">
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

        {/* User Identity & Global Controls */}
        <div className="flex items-center gap-3 bg-slate-50 border border-slate-200/80 rounded-full pl-2 pr-3 py-1.5 text-sm">
          {user.photoURL ? (
            <img
              src={user.photoURL}
              alt={user.displayName || 'User Avatar'}
              width={32}
              height={32}
              className="w-8 h-8 rounded-full border border-slate-200"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-teal-700 font-bold text-white flex items-center justify-center text-xs shadow-sm">
              {user.email ? user.email.slice(0, 1).toUpperCase() : 'M'}
            </div>
          )}
          <span className="text-xs font-semibold text-slate-700 tracking-tight max-w-[170px] truncate">
            {user.email}
          </span>
          <div className="h-4 w-px bg-slate-200" />
          <button
            onClick={onReset}
            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-white rounded-full transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none"
            title="Reset Search and Selection"
            aria-label="Reset all search parameters"
          >
            <RotateCcw size={15} />
          </button>
          <button
            onClick={onLogout}
            className="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-white rounded-full transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none"
            title="Sign Out"
            aria-label="Sign out of application"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </header>
  );
};
