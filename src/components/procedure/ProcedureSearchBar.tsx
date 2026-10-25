import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Loader2, Plus } from 'lucide-react';
import { StandardProcedure } from '../../types';
import { normalizeArabic, normalizeText } from '../../lib/arabic-normalizer';

interface ProcedureSearchBarProps {
  input: string;
  onInputChange: (val: string) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  standardProcedures: StandardProcedure[];
  onSelectProcedure: (proc: StandardProcedure) => void;
  onAddCustom: (name: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  loading: boolean;
  canSubmit: boolean;
}

export const ProcedureSearchBar: React.FC<ProcedureSearchBarProps> = ({
  input,
  onInputChange,
  isOpen,
  onOpenChange,
  standardProcedures,
  onSelectProcedure,
  onAddCustom,
  onSubmit,
  loading,
  canSubmit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onOpenChange]);

  const filteredProcedures = standardProcedures
    .filter((p) => {
      if (!input.trim()) return false;
      const qNorm = normalizeText(input);
      const qAra = normalizeArabic(input);
      if (!qNorm && !qAra) return false;

      const pEng = normalizeText(p.english);
      const pAra = normalizeArabic(p.arabic);

      if (qNorm && pEng.includes(qNorm)) return true;
      if (qAra && pAra.includes(qAra)) return true;

      // Multi-token overlap matching (e.g. out of order words or compound terms)
      const qTokens = qNorm.split(/\s+/).filter((t) => t.length >= 2);
      if (qTokens.length >= 2) {
        const pTokens = new Set(pEng.split(/\s+/));
        if (qTokens.every((t) => pTokens.has(t) || pEng.includes(t))) return true;
      }

      const qAraTokens = qAra.split(/\s+/).filter((t) => t.length >= 2);
      if (qAraTokens.length >= 2) {
        const pAraTokens = new Set(pAra.split(/\s+/));
        if (qAraTokens.every((t) => pAraTokens.has(t) || pAra.includes(t))) return true;
      }

      return false;
    })
    .slice(0, 40);

  return (
    <div ref={containerRef} className="relative z-30">
      <form onSubmit={onSubmit}>
        <label htmlFor="procedure-search-input" className="sr-only">
          Search Medical Procedure
        </label>
        <div className="flex items-center bg-white border-2 border-slate-200 focus-within:border-teal-600 rounded-2xl px-4 py-1.5 shadow-xs focus-within:ring-4 focus-within:ring-teal-600/10 transition-all gap-3">
          <Search className="text-teal-700 shrink-0" size={20} aria-hidden="true" />
          <input
            id="procedure-search-input"
            type="text"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls="procedure-autocomplete-listbox"
            aria-autocomplete="list"
            value={input}
            onChange={(e) => {
              onInputChange(e.target.value);
              onOpenChange(true);
            }}
            onFocus={() => onOpenChange(true)}
            placeholder="Search procedure in English or Arabic (e.g., Blood Test, قياس, غسيل)…"
            className="w-full bg-transparent border-none text-slate-900 text-sm md:text-base focus:outline-none font-semibold placeholder:text-slate-400 min-h-[44px]"
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim() && !e.shiftKey) {
                // If there's an exact match or user pressed enter on custom term
                e.preventDefault();
                onAddCustom(input);
              }
            }}
          />

          {input.trim() && (
            <button
              type="button"
              onClick={() => onAddCustom(input)}
              className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 rounded-xl text-xs font-bold transition-all active:scale-95 cursor-pointer shrink-0 min-h-[38px] flex items-center gap-1"
              aria-label={`Add ${input} as custom extraction`}
            >
              <Plus size={14} />
              <span>Add Custom</span>
            </button>
          )}

          <button
            type="submit"
            disabled={loading || !canSubmit}
            className="bg-teal-700 hover:bg-teal-800 text-white px-5 py-2.5 rounded-xl font-bold transition-all flex items-center gap-2 shadow-xs hover:shadow-sm disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none disabled:cursor-not-allowed text-xs md:text-sm uppercase tracking-wider shrink-0 min-h-[42px] cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none"
            aria-label="Extract and search prices for selected procedures"
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin text-white" size={16} />
                <span>Searching…</span>
              </>
            ) : (
              <span>Extract</span>
            )}
          </button>
        </div>

        {/* Autocomplete Dropdown */}
        <AnimatePresence>
          {isOpen && input.trim().length >= 1 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              id="procedure-autocomplete-listbox"
              role="listbox"
              className="absolute z-50 w-full mt-2 bg-white border border-slate-200 rounded-2xl shadow-xl max-h-64 overflow-y-auto p-1.5 text-left"
            >
              {filteredProcedures.length > 0 ? (
                <>
                  <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
                    <span>Standard Catalog Procedures</span>
                    <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full text-[10px]">
                      {filteredProcedures.length} options
                    </span>
                  </div>
                  {filteredProcedures.map((proc, idx) => (
                    <button
                      key={idx}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => onSelectProcedure(proc)}
                      className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 rounded-xl flex items-center justify-between group transition-colors mb-1 last:mb-0 cursor-pointer border border-transparent hover:border-slate-100 min-h-[44px]"
                    >
                      <span className="font-bold text-xs text-slate-800">
                        {proc.english}
                      </span>
                      <span className="font-bold text-xs text-teal-800" dir="rtl">
                        {proc.arabic}
                      </span>
                    </button>
                  ))}
                </>
              ) : (
                <div className="px-4 py-6 text-center">
                  <p className="text-xs font-semibold text-slate-400">
                    No matching standard procedures found
                  </p>
                  <button
                    type="button"
                    onClick={() => onAddCustom(input)}
                    className="mt-3 px-4 py-2 bg-teal-50 hover:bg-teal-100 text-teal-800 rounded-xl font-bold text-xs inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Plus size={14} />
                    <span>Add "{input}" as custom term</span>
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </form>
    </div>
  );
};
