import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Building2, X, Search, Check } from 'lucide-react';
import { CompanyInfo } from '../../types';
import { normalizeArabic } from '../../lib/arabic-normalizer';

interface ContractorSelectorProps {
  companies: CompanyInfo[];
  selectedCompany: CompanyInfo | null;
  onSelectCompany: (company: CompanyInfo | null) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ContractorSelector: React.FC<ContractorSelectorProps> = ({
  companies,
  selectedCompany,
  onSelectCompany,
  searchTerm,
  onSearchChange,
  isOpen,
  onOpenChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onOpenChange]);

  const filteredCompanies = companies
    .filter((c) => {
      const query = normalizeArabic(searchTerm);
      if (!query) return true;
      const nameMatch = normalizeArabic(c.name).includes(query);
      const officerMatch = normalizeArabic(c.responsiblePerson || c.contractorOfficer || '').includes(query);
      const aliasMatch = c.aliases && c.aliases.some((a) => normalizeArabic(a).includes(query));
      return nameMatch || officerMatch || Boolean(aliasMatch);
    })
    .slice(0, 50);

  return (
    <div ref={containerRef} className="relative w-full md:w-72 shrink-0">
      <label htmlFor="contractor-search-input" className="sr-only">
        Search Contractor Company
      </label>

      {selectedCompany ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-center justify-between gap-2.5 bg-teal-800 text-white pl-3.5 pr-2 py-2 rounded-xl shadow-xs border border-teal-700 min-h-[44px]"
        >
          <div className="flex flex-col text-left overflow-hidden">
            <span className="text-[10px] font-bold text-teal-200 uppercase tracking-wider">
              Active Contractor
            </span>
            <span className="text-xs font-bold truncate max-w-[150px]">
              {selectedCompany.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="bg-teal-700 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-md">
              {selectedCompany.discount}% OFF
            </span>
            <button
              onClick={() => onSelectCompany(null)}
              className="p-1 rounded-full text-teal-200 hover:text-white hover:bg-teal-700 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
              title="Remove selected contractor"
              aria-label={`Remove contractor ${selectedCompany.name}`}
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      ) : (
        <div className="relative">
          <input
            id="contractor-search-input"
            type="text"
            role="combobox"
            aria-expanded={isOpen}
            aria-controls="contractor-listbox"
            aria-autocomplete="list"
            value={searchTerm}
            onChange={(e) => {
              onSearchChange(e.target.value);
              onOpenChange(true);
            }}
            onFocus={() => onOpenChange(true)}
            placeholder="Search contractor company…"
            className="w-full bg-slate-50 hover:bg-white focus:bg-white border border-slate-300 focus:border-teal-600 rounded-xl pl-9 pr-8 py-2.5 text-xs font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/20 transition-all min-h-[44px]"
          />
          <Building2
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            size={16}
            aria-hidden="true"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => {
                onSearchChange('');
                onOpenChange(false);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 rounded-full"
              aria-label="Clear company search text"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Dropdown listbox */}
      <AnimatePresence>
        {isOpen && !selectedCompany && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            id="contractor-listbox"
            role="listbox"
            className="absolute right-0 top-full z-50 w-full md:w-80 mt-1.5 bg-white border border-slate-200 rounded-2xl shadow-xl max-h-64 overflow-y-auto p-1.5"
          >
            {filteredCompanies.length > 0 ? (
              <>
                <div className="px-3 py-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
                  <span>Contractors Found</span>
                  <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded-full text-[10px]">
                    {filteredCompanies.length}
                  </span>
                </div>
                {filteredCompanies.map((company, idx) => (
                  <button
                    key={company.id || idx}
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      onSelectCompany(company);
                      onOpenChange(false);
                      onSearchChange('');
                    }}
                    className="w-full text-left px-3.5 py-2 hover:bg-slate-50 rounded-xl flex items-center justify-between group transition-colors cursor-pointer border border-transparent hover:border-slate-100 min-h-[44px]"
                  >
                    <div className="flex flex-col text-left overflow-hidden max-w-[190px]">
                      <span className="font-bold text-xs text-slate-800 truncate">
                        {company.name}
                      </span>
                      {(company.responsiblePerson || company.contractorOfficer) && (
                        <span className="text-[10px] text-teal-800 font-medium truncate">
                          سيلز: {company.responsiblePerson || company.contractorOfficer}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-[10px] bg-teal-50 text-teal-700 border border-teal-200/60 px-1.5 py-0.5 rounded font-extrabold">
                        {company.discount}% OFF
                      </span>
                      <span className="text-[10px] font-semibold text-slate-400">
                        {company.priceListYear}
                      </span>
                    </div>
                  </button>
                ))}
              </>
            ) : (
              <div className="px-4 py-6 text-center text-xs font-semibold text-slate-400">
                No matching contractor contracts found
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
