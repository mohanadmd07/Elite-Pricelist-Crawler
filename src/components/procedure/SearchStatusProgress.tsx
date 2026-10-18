import React from 'react';
import { motion } from 'motion/react';
import { Loader2, Sparkles, Database } from 'lucide-react';
import { SearchStatus } from '../../types';

interface SearchStatusProgressProps {
  status: SearchStatus;
}

export const SearchStatusProgress: React.FC<SearchStatusProgressProps> = ({ status }) => {
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs text-left space-y-3.5"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-teal-50 border border-teal-200/70 text-teal-700 flex items-center justify-center shrink-0">
            {status.stage === 'local' ? (
              <Database size={18} className="text-teal-700 animate-pulse" />
            ) : (
              <Sparkles size={18} className="text-amber-600 animate-pulse" />
            )}
          </div>
          <div>
            <h4 className="text-xs font-black text-slate-900 uppercase tracking-wider">
              {status.stage === 'local'
                ? 'Scanning Hospital Pricelists…'
                : 'Extending Search via Semantic AI…'}
            </h4>
            <p className="text-[11px] text-slate-500 font-medium">
              {status.stage === 'local'
                ? 'Searching preloaded 2023–2025 cash tables & contractor catalog…'
                : 'Analyzing complex terms with Google Gemini flash model…'}
            </p>
          </div>
        </div>

        {status.stage === 'ai' && (
          <span className="text-[10px] bg-amber-50 border border-amber-200 text-amber-800 px-2.5 py-1 rounded-full font-bold uppercase tracking-wider self-start sm:self-auto flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" />
            AI Semantic Matcher
          </span>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs font-bold text-slate-600">
          <div className="flex items-center gap-1.5">
            <span className="text-teal-800 font-extrabold">{status.foundCount}</span>
            <span className="font-medium text-slate-500">found directly</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-amber-700 font-extrabold">{status.pendingCount}</span>
            <span className="font-medium text-slate-500">pending resolution</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200/70 p-0.5">
          <motion.div
            className="h-full rounded-full bg-teal-600 transition-all duration-300"
            initial={{ width: '10%' }}
            animate={{
              width:
                status.stage === 'local'
                  ? '45%'
                  : status.stage === 'ai'
                  ? '80%'
                  : '100%',
            }}
          />
        </div>
      </div>
    </motion.section>
  );
};
