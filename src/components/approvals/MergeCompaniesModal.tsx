import React, { useState, useEffect } from 'react';
import { X, Layers, Check, Building, User, Calendar, Percent, AlertCircle } from 'lucide-react';
import { CompanyConfigRecord } from '../../types';
import { mergeCompanies } from '../../services/approvalsFirebaseService';

interface MergeCompaniesModalProps {
  isOpen: boolean;
  selectedCompanies: CompanyConfigRecord[];
  onClose: () => void;
  onMerged?: () => void;
  userEmail?: string;
}

const PRICELIST_YEARS = [
  { value: '2026', label: 'Elite Hospital 2026 (Active / Cash)' },
  { value: '2025', label: 'Elite Hospital 2025' },
  { value: '2024', label: 'Elite Hospital 2024' },
  { value: '2023', label: 'Elite Hospital 2023' },
  { value: 'Cash', label: 'Cash Pricelist (2026)' },
];

export const MergeCompaniesModal: React.FC<MergeCompaniesModalProps> = ({
  isOpen,
  selectedCompanies,
  onClose,
  onMerged,
  userEmail,
}) => {
  const [targetId, setTargetId] = useState<string>('');
  const [targetName, setTargetName] = useState<string>('');
  const [priceListYear, setPriceListYear] = useState<string>('2026');
  const [contractorOfficer, setContractorOfficer] = useState<string>('');
  const [discountPercentage, setDiscountPercentage] = useState<number>(0);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize form when selectedCompanies change
  useEffect(() => {
    if (selectedCompanies && selectedCompanies.length > 0) {
      // Pick first company with an officer defined or the first item
      const best = selectedCompanies.find((c) => c.contractorOfficer && c.contractorOfficer !== 'غير محدد') || selectedCompanies[0];
      setTargetId(best.id);
      setTargetName(best.name);
      setPriceListYear(best.priceListYear || '2026');
      setContractorOfficer(best.contractorOfficer && best.contractorOfficer !== 'غير محدد' ? best.contractorOfficer : '');
      setDiscountPercentage(best.discountPercentage || 0);
      setError(null);
    }
  }, [selectedCompanies, isOpen]);

  if (!isOpen || selectedCompanies.length < 2) return null;

  const handleSelectMaster = (comp: CompanyConfigRecord) => {
    setTargetId(comp.id);
    setTargetName(comp.name);
    if (comp.priceListYear) setPriceListYear(comp.priceListYear);
    if (comp.contractorOfficer && comp.contractorOfficer !== 'غير محدد') {
      setContractorOfficer(comp.contractorOfficer);
    }
    if (comp.discountPercentage !== undefined) {
      setDiscountPercentage(comp.discountPercentage);
    }
  };

  const handleConfirmMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetName.trim()) {
      setError('Target company name is required.');
      return;
    }

    try {
      setIsMerging(true);
      setError(null);

      await mergeCompanies({
        targetId: targetId || selectedCompanies[0].id,
        targetName: targetName.trim(),
        priceListYear,
        contractorOfficer: contractorOfficer.trim() || 'غير محدد',
        discountPercentage,
        sourceCompanies: selectedCompanies,
        userEmail,
      });

      onMerged?.();
      onClose();
    } catch (err: any) {
      console.error('Merge error:', err);
      setError(err?.message || 'Failed to merge companies. Please try again.');
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] text-left"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-200/60 text-teal-800 flex items-center justify-center">
              <Layers size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 font-display">
                Merge Companies ({selectedCompanies.length})
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                Combine duplicates and unify aliases under one primary contractor
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            aria-label="Close dialog"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleConfirmMerge} className="p-6 space-y-5 overflow-y-auto">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-center gap-2">
              <AlertCircle size={14} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Master Selection Radio Pills */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              Choose Primary Template / Name:
            </label>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {selectedCompanies.map((c) => (
                <div
                  key={c.id}
                  onClick={() => handleSelectMaster(c)}
                  className={`flex items-center justify-between p-2.5 rounded-xl border cursor-pointer text-xs transition-all ${
                    targetId === c.id
                      ? 'bg-teal-50/80 border-teal-500 text-teal-950 font-bold shadow-2xs'
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <input
                      type="radio"
                      name="masterCompany"
                      checked={targetId === c.id}
                      onChange={() => handleSelectMaster(c)}
                      className="text-teal-600 focus:ring-teal-500"
                    />
                    <span className="truncate" dir="auto">{c.name}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500 shrink-0">
                    <span>{c.priceListYear || '2026'}</span>
                    <span>• {c.contractorOfficer || 'غير محدد'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Unified Details Form */}
          <div className="space-y-3.5 pt-2 border-t border-slate-100">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                <Building size={13} className="text-slate-400" />
                <span>Primary Target Name</span>
              </label>
              <input
                type="text"
                value={targetName}
                onChange={(e) => setTargetName(e.target.value)}
                placeholder="e.g. خالده للبترول"
                dir="auto"
                required
                className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-bold text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                  <Calendar size={13} className="text-slate-400" />
                  <span>Pricelist</span>
                </label>
                <select
                  value={priceListYear}
                  onChange={(e) => setPriceListYear(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all cursor-pointer"
                >
                  {PRICELIST_YEARS.map((y) => (
                    <option key={y.value} value={y.value}>
                      {y.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                  <User size={13} className="text-slate-400" />
                  <span>Contractor Officer</span>
                </label>
                <input
                  type="text"
                  value={contractorOfficer}
                  onChange={(e) => setContractorOfficer(e.target.value)}
                  placeholder="e.g. محمد ابو الوفا"
                  dir="auto"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1.5">
                <Percent size={13} className="text-slate-400" />
                <span>Discount %</span>
              </label>
              <input
                type="number"
                min="0"
                max="100"
                value={discountPercentage}
                onChange={(e) => setDiscountPercentage(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-semibold text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
              />
            </div>
          </div>

          <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl text-[11px] text-amber-900 leading-relaxed">
            <strong>Merging Note:</strong> All names and aliases from the {selectedCompanies.length} selected contractors will be merged into <strong>"{targetName}"</strong>. Future incoming emails matching any of these names will resolve automatically to this contractor and officer.
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-xl text-xs font-bold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isMerging}
              className="px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-98"
            >
              {isMerging ? (
                <span>Merging...</span>
              ) : (
                <>
                  <Check size={14} />
                  <span>Confirm & Merge</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
