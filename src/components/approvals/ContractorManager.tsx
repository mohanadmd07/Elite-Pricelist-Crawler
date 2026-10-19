import React, { useState, useEffect } from 'react';
import {
  Building2,
  Search,
  Plus,
  Save,
  Check,
  Trash2,
  RotateCcw,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { CompanyConfigRecord, CompanyInfo } from '../../types';
import {
  subscribeToCompanyConfigs,
  saveCompanyConfig,
  deleteCompanyConfig,
  seedInitialCompaniesIfEmpty,
} from '../../services/approvalsFirebaseService';
import { AddCompanyModal } from './AddCompanyModal';

interface ContractorManagerProps {
  userEmail?: string;
  catalogCompanies?: CompanyInfo[];
}

const PRICELIST_YEARS = [
  { value: '2025', label: 'Elite Hospital 2025' },
  { value: '2024', label: 'Elite Hospital 2024' },
  { value: '2023', label: 'Elite Hospital 2023' },
  { value: 'Cash', label: 'Cash Pricelist' },
];

export const ContractorManager: React.FC<ContractorManagerProps> = ({
  userEmail,
  catalogCompanies = [],
}) => {
  const [companies, setCompanies] = useState<CompanyConfigRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Local draft edits: key is docId, value is modified fields
  const [edits, setEdits] = useState<Record<string, { priceListYear?: string; contractorOfficer?: string }>>({});
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [savedSuccessIds, setSavedSuccessIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubscribe = subscribeToCompanyConfigs((data) => {
      setCompanies(data);
      setLoading(false);

      // If empty, automatically seed from the existing loaded catalog
      if (data.length === 0 && catalogCompanies.length > 0) {
        seedInitialCompaniesIfEmpty(catalogCompanies);
      }
    });

    return () => unsubscribe();
  }, [catalogCompanies]);

  const handleFieldChange = (
    id: string,
    field: 'priceListYear' | 'contractorOfficer',
    value: string
  ) => {
    setEdits((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: value,
      },
    }));
  };

  const handleSaveRow = async (company: CompanyConfigRecord) => {
    const edit = edits[company.id];
    if (!edit) return;

    try {
      setSavingIds((prev) => ({ ...prev, [company.id]: true }));

      await saveCompanyConfig(
        {
          id: company.id,
          name: company.name,
          aliases: company.aliases || [company.name],
          priceListYear: edit.priceListYear !== undefined ? edit.priceListYear : company.priceListYear,
          contractorOfficer: edit.contractorOfficer !== undefined ? edit.contractorOfficer : company.contractorOfficer,
          discountPercentage: company.discountPercentage || 0,
        },
        userEmail
      );

      // Clean local edit buffer for this row
      setEdits((prev) => {
        const next = { ...prev };
        delete next[company.id];
        return next;
      });

      // Show temporary green check
      setSavedSuccessIds((prev) => ({ ...prev, [company.id]: true }));
      setTimeout(() => {
        setSavedSuccessIds((prev) => {
          const next = { ...prev };
          delete next[company.id];
          return next;
        });
      }, 2500);
    } catch (err) {
      console.error('Failed to save company config:', err);
      alert('Failed to save to database. Please check your connection.');
    } finally {
      setSavingIds((prev) => ({ ...prev, [company.id]: false }));
    }
  };

  const handleDelete = async (company: CompanyConfigRecord) => {
    const confirmed = window.confirm(`Are you sure you want to remove "${company.name}" from database?`);
    if (!confirmed) return;

    try {
      await deleteCompanyConfig(company.id);
    } catch (err) {
      console.error('Failed to delete company:', err);
    }
  };

  const filteredCompanies = companies.filter((c) => {
    const term = search.toLowerCase().trim();
    if (!term) return true;
    return (
      c.name.toLowerCase().includes(term) ||
      (c.contractorOfficer && c.contractorOfficer.toLowerCase().includes(term)) ||
      (c.aliases && c.aliases.some((a) => a.toLowerCase().includes(term))) ||
      (c.priceListYear && c.priceListYear.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-4 text-left">
      {/* Search & Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contractor, officer, or alias..."
            dir="auto"
            className="w-full pl-9 pr-4 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-medium text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsAddModalOpen(true)}
            className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-98"
          >
            <Plus size={15} />
            <span>Add New Company</span>
          </button>
        </div>
      </div>

      {/* Main Companies Table */}
      <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-teal-700" />
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Contractor Mappings ({filteredCompanies.length} Companies)
            </h3>
          </div>
          <span className="text-[11px] text-slate-500 font-medium">
            Changes persist directly to Firebase & apply to incoming emails in real time
          </span>
        </div>

        {loading ? (
          <div className="p-12 text-center text-slate-400 text-xs font-medium">
            Loading contractor mappings from Firebase...
          </div>
        ) : filteredCompanies.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs font-medium space-y-2">
            <p>No companies found matching your search.</p>
            {catalogCompanies.length > 0 && (
              <button
                onClick={() => seedInitialCompaniesIfEmpty(catalogCompanies)}
                className="inline-flex items-center gap-1.5 text-xs text-teal-700 font-bold hover:underline"
              >
                <RotateCcw size={13} />
                Sync all from catalog ({catalogCompanies.length} contractors)
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50/30">
                  <th className="py-3 px-5">Contractor / Company</th>
                  <th className="py-3 px-4 w-56">Active Pricelist</th>
                  <th className="py-3 px-4 w-64">Contractor Officer (سيلز)</th>
                  <th className="py-3 px-3 text-center w-24">Discount</th>
                  <th className="py-3 px-4 text-right w-28">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredCompanies.map((company) => {
                  const localEdit = edits[company.id] || {};
                  const currentYear =
                    localEdit.priceListYear !== undefined
                      ? localEdit.priceListYear
                      : company.priceListYear || '2025';
                  const currentOfficer =
                    localEdit.contractorOfficer !== undefined
                      ? localEdit.contractorOfficer
                      : company.contractorOfficer || '';
                  const isModified =
                    (localEdit.priceListYear !== undefined && localEdit.priceListYear !== company.priceListYear) ||
                    (localEdit.contractorOfficer !== undefined && localEdit.contractorOfficer !== company.contractorOfficer);
                  const isSaving = savingIds[company.id];
                  const isSavedSuccess = savedSuccessIds[company.id];

                  return (
                    <tr
                      key={company.id}
                      className={`hover:bg-slate-50/70 transition-colors ${
                        isModified ? 'bg-amber-50/30' : ''
                      }`}
                    >
                      {/* Company Name & Aliases */}
                      <td className="py-3 px-5">
                        <div className="font-bold text-slate-900" dir="auto">
                          {company.name}
                        </div>
                        {company.aliases && company.aliases.length > 1 && (
                          <div className="text-[10px] text-slate-400 truncate max-w-xs mt-0.5" dir="auto">
                            Aliases: {company.aliases.filter((a) => a !== company.name).join(', ')}
                          </div>
                        )}
                      </td>

                      {/* Pricelist Dropdown */}
                      <td className="py-2.5 px-4">
                        <select
                          value={currentYear}
                          onChange={(e) => handleFieldChange(company.id, 'priceListYear', e.target.value)}
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all cursor-pointer shadow-2xs"
                        >
                          {PRICELIST_YEARS.map((y) => (
                            <option key={y.value} value={y.value}>
                              {y.label}
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Contractor Officer Text Input */}
                      <td className="py-2.5 px-4">
                        <input
                          type="text"
                          value={currentOfficer}
                          onChange={(e) => handleFieldChange(company.id, 'contractorOfficer', e.target.value)}
                          placeholder="Officer name in Arabic"
                          dir="auto"
                          className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all shadow-2xs"
                        />
                      </td>

                      {/* Discount % */}
                      <td className="py-3 px-3 text-center">
                        <span className="font-bold text-slate-700">
                          {company.discountPercentage ? `${company.discountPercentage}%` : '0%'}
                        </span>
                      </td>

                      {/* Action Buttons */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {isSavedSuccess ? (
                            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-200">
                              <Check size={13} /> Saved
                            </span>
                          ) : isModified ? (
                            <button
                              onClick={() => handleSaveRow(company)}
                              disabled={isSaving}
                              className="px-2.5 py-1 bg-teal-700 hover:bg-teal-800 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 shadow-xs transition-all cursor-pointer active:scale-95"
                              title="Save changes to Firebase"
                            >
                              <Save size={12} />
                              <span>{isSaving ? '...' : 'Save'}</span>
                            </button>
                          ) : (
                            <span className="text-[10px] text-slate-300 font-semibold px-2">Synced</span>
                          )}

                          <button
                            onClick={() => handleDelete(company)}
                            className="p-1 text-slate-300 hover:text-rose-600 rounded-md transition-colors cursor-pointer"
                            title="Delete contractor"
                            aria-label={`Delete ${company.name}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add New Company Modal */}
      <AddCompanyModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        userEmail={userEmail}
      />
    </div>
  );
};
