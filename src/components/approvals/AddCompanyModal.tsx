import React, { useState } from 'react';
import { X, Building2, Plus, Check, AlertCircle } from 'lucide-react';
import { saveCompanyConfig } from '../../services/approvalsFirebaseService';

interface AddCompanyModalProps {
  isOpen: boolean;
  onClose: () => void;
  userEmail?: string;
  onSuccess?: () => void;
}

const PRICELIST_OPTIONS = [
  { label: 'Elite Hospital 2025 (Default)', value: '2025' },
  { label: 'Elite Hospital 2024', value: '2024' },
  { label: 'Elite Hospital 2023', value: '2023' },
  { label: 'Cash Pricelist', value: 'Cash' },
];

const SUGGESTED_OFFICERS = [
  'محمد ابو الوفا',
  'زياد',
  'نادين',
  'ديانا',
  'أحمد حمزة',
  'محمد جابر',
];

export const AddCompanyModal: React.FC<AddCompanyModalProps> = ({
  isOpen,
  onClose,
  userEmail,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [priceListYear, setPriceListYear] = useState('2025');
  const [contractorOfficer, setContractorOfficer] = useState('');
  const [discountPercentage, setDiscountPercentage] = useState('0');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please provide the official company name.');
      return;
    }
    if (!contractorOfficer.trim()) {
      setError('Please specify the responsible contractor officer.');
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      // Parse comma-separated aliases
      const aliasList = aliases
        .split(/[,،]+/)
        .map((a) => a.trim())
        .filter(Boolean);

      if (!aliasList.includes(name.trim())) {
        aliasList.unshift(name.trim());
      }

      await saveCompanyConfig(
        {
          name: name.trim(),
          aliases: aliasList,
          priceListYear,
          contractorOfficer: contractorOfficer.trim(),
          discountPercentage: Number(discountPercentage) || 0,
        },
        userEmail
      );

      setIsSaving(false);
      onSuccess?.();
      onClose();
    } catch (err: any) {
      console.error('Failed to add company:', err);
      setError(err.message || 'Error saving company to database');
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-lg overflow-hidden flex flex-col text-left"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-200/60 text-teal-800 flex items-center justify-center">
              <Building2 size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 font-display">
                Add New Company / Contractor
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                Map contractor to pricelist year & responsible officer
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

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
              <AlertCircle size={15} className="shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {/* Official Company Name */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              Official Company Name (Arabic or English) <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. شركة بترول بلاعيم"
              dir="auto"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-sm text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
            />
          </div>

          {/* Email / HIS Aliases */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Known Aliases / Variations in HIS Emails
            </label>
            <p className="text-[11px] text-slate-500 mb-1.5">
              Comma-separated names that appear in incoming approval subjects/bodies.
            </p>
            <input
              type="text"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="بتروبل, Petrobel, شركة بترول بلاعيم Main"
              dir="auto"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-sm text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
            />
          </div>

          {/* Pricelist Dropdown & Discount */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Contract Pricelist <span className="text-rose-500">*</span>
              </label>
              <select
                value={priceListYear}
                onChange={(e) => setPriceListYear(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-bold text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all cursor-pointer"
              >
                {PRICELIST_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                Contract Discount (%)
              </label>
              <input
                type="number"
                min="0"
                max="100"
                value={discountPercentage}
                onChange={(e) => setDiscountPercentage(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-sm text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
              />
            </div>
          </div>

          {/* Contractor Officer */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              Contractor Officer / Sales Rep (المسئول من قسم السيلز) <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={contractorOfficer}
              onChange={(e) => setContractorOfficer(e.target.value)}
              placeholder="e.g. محمد ابو الوفا"
              dir="auto"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-sm text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
            />
            {/* Quick Officer Suggestion Chips */}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-[10px] text-slate-400 font-medium">Quick select:</span>
              {SUGGESTED_OFFICERS.map((officer) => (
                <button
                  type="button"
                  key={officer}
                  onClick={() => setContractorOfficer(officer)}
                  className={`text-[10px] px-2 py-0.5 rounded-md border transition-all cursor-pointer ${
                    contractorOfficer === officer
                      ? 'bg-teal-700 text-white border-teal-700 font-bold'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200'
                  }`}
                >
                  {officer}
                </button>
              ))}
            </div>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-98"
            >
              {isSaving ? (
                <span>Saving...</span>
              ) : (
                <>
                  <Plus size={14} />
                  <span>Save to Firebase</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
