import React from 'react';
import { ShieldCheck } from 'lucide-react';

interface AppFooterProps {
  userEmail?: string | null;
}

export const AppFooter: React.FC<AppFooterProps> = ({ userEmail }) => {
  return (
    <footer className="max-w-5xl mx-auto px-6 py-8 text-center relative z-10 select-none">
      <div className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200/90 rounded-full text-[11px] font-bold text-slate-700 shadow-xs">
        <ShieldCheck size={14} className="text-emerald-600" />
        <span>Elite Hospital • Contract Verification & Pricelist Engine</span>
      </div>
      {userEmail && (
        <p className="mt-3 text-[11px] text-slate-500 font-medium">
          Session Authenticated: <span className="font-mono text-teal-800">{userEmail}</span>
        </p>
      )}
    </footer>
  );
};
