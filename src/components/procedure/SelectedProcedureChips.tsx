import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Sparkles } from 'lucide-react';
import { SelectedProcedure } from '../../types';

interface SelectedProcedureChipsProps {
  procedures: SelectedProcedure[];
  onRemove: (id: string) => void;
}

export const SelectedProcedureChips: React.FC<SelectedProcedureChipsProps> = ({
  procedures,
  onRemove,
}) => {
  if (procedures.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      <AnimatePresence>
        {procedures.map((p) => (
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            key={p.id}
            className="inline-flex items-center gap-2.5 bg-slate-100/90 border border-slate-200/90 text-slate-800 rounded-xl px-3.5 py-1.5 shadow-2xs hover:border-slate-300 transition-colors"
          >
            <div className="flex flex-col text-left">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-900 font-bold">{p.name}</span>
                {p.isCustom && (
                  <span
                    className="inline-flex items-center text-[9px] font-black text-amber-700 bg-amber-50 border border-amber-200/80 px-1.5 py-0.2 rounded-md"
                    title="Custom unstandardized term (AI search enabled)"
                  >
                    <Sparkles size={9} className="mr-0.5" />
                    AI
                  </span>
                )}
              </div>
              {p.arabic && (
                <span className="text-[10px] text-teal-800 font-semibold block" dir="rtl">
                  {p.arabic}
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={() => onRemove(p.id)}
              className="p-1 rounded-full text-slate-400 hover:text-rose-600 hover:bg-slate-200 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:outline-none"
              aria-label={`Remove procedure ${p.name}`}
              title={`Remove ${p.name}`}
            >
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
