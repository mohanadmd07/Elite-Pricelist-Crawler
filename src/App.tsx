/**
 * Elite Hospital Pricelist Explorer
 * Modular, humanized healthcare application for medical insurance & contractor price inquiries.
 * Refactored per /react-best-practices, /ui-ux-pro-max, /impeccable, and /supabase-postgres-best-practices.
 */

import React, { useState, useEffect } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { motion, AnimatePresence } from 'motion/react';
import {
  AlertCircle,
  Database,
  Tag,
  Loader2,
  Clock,
  Sparkles,
  Key,
  Trash2,
  X,
} from 'lucide-react';

import {
  ProcedureResult,
  CompanyInfo,
  StandardProcedure,
  SelectedProcedure,
  SearchStatus,
  UserSearchRecord,
} from './types';
import { auth, loginWithGoogle, logout, saveSearch, deleteSearch, clearRecentSearches, db } from './firebase';
import { useStandardProcedures } from './hooks/useStandardProcedures';
import { useCompaniesData } from './hooks/useCompaniesData';
import { searchAllProcedures } from './services/procedureService';
import { isGeminiConfigured } from './services/aiMatchService';

import { AppHeader } from './components/layout/AppHeader';
import { AppFooter } from './components/layout/AppFooter';
import { LoginView } from './components/auth/LoginView';
import { ContractorSelector } from './components/contractor/ContractorSelector';
import { ActiveContractBanner } from './components/contractor/ActiveContractBanner';
import { ProcedureSearchBar } from './components/procedure/ProcedureSearchBar';
import { SelectedProcedureChips } from './components/procedure/SelectedProcedureChips';
import { SearchStatusProgress } from './components/procedure/SearchStatusProgress';
import { ProcedureResultCard } from './components/procedure/ProcedureResultCard';
import { CopyableReportCard } from './components/report/CopyableReportCard';
import { OutlookTipsCard } from './components/report/OutlookTipsCard';
import { AiSettingsModal } from './components/modals/AiSettingsModal';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginError, setLoginError] = useState<string | null>(null);

  // AI Key modal state
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [aiKeyVersion, setAiKeyVersion] = useState(0);

  // Data catalogs
  const { standardProcedures } = useStandardProcedures();
  const { companies } = useCompaniesData();

  // Contractor selection
  const [selectedCompany, setSelectedCompany] = useState<CompanyInfo | null>(null);
  const [companySearch, setCompanySearch] = useState('');
  const [isCompanyDropdownOpen, setIsCompanyDropdownOpen] = useState(false);

  // Procedure search selection
  const [selectedProcedures, setSelectedProcedures] = useState<SelectedProcedure[]>([]);
  const [procedureInput, setProcedureInput] = useState('');
  const [isProcedureDropdownOpen, setIsProcedureDropdownOpen] = useState(false);
  const [aiSearchEnabled, setAiSearchEnabled] = useState(true);

  // Execution states
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ProcedureResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<UserSearchRecord[]>([]);
  const [fileStatus, setFileStatus] = useState<Record<string, boolean>>({});

  const [searchStatus, setSearchStatus] = useState<SearchStatus>({
    foundCount: 0,
    pendingCount: 0,
    isExtendingToAI: false,
    stage: 'idle',
  });

  const priceLists = [
    { name: 'Elite Hospital 2025', path: '/2025.pdf' },
    { name: 'Elite Hospital 2024', path: '/2024.pdf' },
    { name: 'Elite Hospital 2023', path: '/2023.pdf' },
  ];

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Real-time search history listener utilizing persistent multi-tab disk cache
  useEffect(() => {
    if (!user) {
      setRecentSearches([]);
      return;
    }

    const searchesRef = collection(db, 'users', user.uid, 'searches');
    const q = query(searchesRef, orderBy('timestamp', 'desc'), limit(8));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const searches: UserSearchRecord[] = snapshot.docs.map((docItem) => ({
          id: docItem.id,
          ...(docItem.data() as Omit<UserSearchRecord, 'id'>),
        }));
        setRecentSearches(searches);
      },
      (err) => {
        console.warn('History subscription error:', err);
      }
    );

    return () => unsubscribe();
  }, [user]);

  // Check PDF status on mount
  useEffect(() => {
    const checkFiles = async () => {
      const status: Record<string, boolean> = {};
      for (const list of priceLists) {
        try {
          const res = await fetch(list.path, { method: 'HEAD' });
          const contentType = res.headers.get('Content-Type');
          status[list.path] = res.ok && Boolean(contentType?.includes('application/pdf'));
        } catch {
          status[list.path] = false;
        }
      }
      setFileStatus(status);
    };
    checkFiles();
  }, []);

  const handleLoginClick = async () => {
    try {
      setLoginError(null);
      await loginWithGoogle();
    } catch (err: any) {
      console.error('Google login error:', err);
      setLoginError(err.message || String(err));
    }
  };

  const handleAddProcedure = (proc: StandardProcedure) => {
    if (selectedProcedures.some((p) => p.name.toLowerCase() === proc.english.toLowerCase())) {
      setProcedureInput('');
      setIsProcedureDropdownOpen(false);
      return;
    }

    setSelectedProcedures((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(2, 9),
        name: proc.english,
        arabic: proc.arabic,
        isCustom: false,
      },
    ]);
    setProcedureInput('');
    setIsProcedureDropdownOpen(false);
  };

  const handleAddCustomProcedure = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (selectedProcedures.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setProcedureInput('');
      setIsProcedureDropdownOpen(false);
      return;
    }

    setSelectedProcedures((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(2, 9),
        name: trimmed,
        isCustom: true,
      },
    ]);
    setProcedureInput('');
    setIsProcedureDropdownOpen(false);
  };

  const handleRemoveProcedure = (id: string) => {
    setSelectedProcedures((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedProcedures.length === 0 || !user) return;

    setLoading(true);
    setError(null);
    setResults([]);

    try {
      const activeYear = selectedCompany?.priceListYear;
      const combinedResults = await searchAllProcedures(
        selectedProcedures,
        activeYear,
        aiSearchEnabled,
        (progress) => setSearchStatus(progress)
      );

      setResults(combinedResults);

      // Log search history with enriched metadata for analytics and quick re-querying
      const queryText = selectedProcedures.map((p) => p.name).join(', ');
      saveSearch(user.uid, queryText, combinedResults.length, {
        companyName: selectedCompany?.name,
        priceListYear: activeYear,
        aiUsed: aiSearchEnabled,
      }).catch((err) =>
        console.warn('Failed to save search history:', err)
      );

      if (combinedResults.length === 0) {
        setError('No procedures matching your search items were found in the pricelists.');
      }
    } catch (err: any) {
      console.error('Search error:', err);
      const msg = err.message || 'An error occurred while executing the search.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setSelectedProcedures([]);
    setProcedureInput('');
    setSelectedCompany(null);
    setCompanySearch('');
    setResults([]);
    setError(null);
    setSearchStatus({
      foundCount: 0,
      pendingCount: 0,
      isExtendingToAI: false,
      stage: 'idle',
    });
  };

  if (authLoading) {
    return (
      <div className="min-h-screen relative flex items-center justify-center font-sans overflow-hidden">
        {/* Background Image: Stretched and Fitted per /impeccable */}
        <div
          className="fixed inset-0 w-full h-full pointer-events-none z-0 bg-no-repeat bg-cover bg-center"
          style={{
            backgroundImage: `url('/header_bg.webp'), url('/header_bg.png')`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundAttachment: 'fixed',
          }}
        />
        <div className="fixed inset-0 w-full h-full pointer-events-none z-0 bg-slate-900/20 backdrop-blur-[4px]" />

        <div className="relative z-10 flex flex-col items-center gap-4 bg-white/95 backdrop-blur-md border border-slate-200/90 p-8 rounded-3xl shadow-xl">
          <Loader2 className="animate-spin text-teal-700" size={40} />
          <p className="text-xs font-bold text-slate-700 tracking-wider font-display">
            Loading Elite Pricelist Explorer…
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView loginError={loginError} onLogin={handleLoginClick} />;
  }

  return (
    <div className="min-h-screen relative text-slate-900 font-sans antialiased selection:bg-teal-100 selection:text-teal-900 pb-16 overflow-x-hidden">
      {/* Background Image: Stretched and Fitted per /impeccable */}
      <div
        className="fixed inset-0 w-full h-full pointer-events-none z-0 bg-no-repeat bg-cover bg-center"
        style={{
          backgroundImage: `url('/header_bg.webp'), url('/header_bg.png')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundAttachment: 'fixed',
        }}
      />
      {/* Refined subtle overlay preserving contrast and readability */}
      <div className="fixed inset-0 w-full h-full pointer-events-none z-0 bg-slate-900/15 backdrop-blur-[3px]" />

      <AppHeader
        user={user}
        onReset={handleReset}
        onLogout={logout}
        onOpenAiSettings={() => setIsAiModalOpen(true)}
        aiKeyVersion={aiKeyVersion}
      />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-2 relative z-10">
        <div className="grid gap-6">
          {/* Section 1: Active Pricelists & Contractor Selection */}
          <section className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-6 shadow-sm relative z-20">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-full border border-slate-200 shadow-2xs self-start">
                <Database size={14} className="text-teal-700" />
                <span className="text-xs font-black uppercase tracking-wider text-slate-800">
                  Hospital Price Catalogs
                </span>
              </div>
              <div className="text-[10px] bg-slate-100 border border-slate-200 text-slate-700 px-3 py-1.5 rounded-full font-bold tracking-wider uppercase self-start">
                {companies.length} Corporate Contracts Active
              </div>
            </div>

            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {priceLists.map((list) => {
                  const isAvailable = fileStatus[list.path];
                  const isTargeted =
                    selectedCompany && list.name.includes(selectedCompany.priceListYear);
                  const isExcluded =
                    selectedCompany && !list.name.includes(selectedCompany.priceListYear);

                  return (
                    <div
                      key={list.path}
                      className={`px-3.5 py-2 border rounded-xl text-xs font-bold flex items-center gap-2 transition-all ${
                        isTargeted
                          ? 'bg-teal-50 border-teal-300 text-teal-900 ring-2 ring-teal-500/20'
                          : isExcluded
                          ? 'opacity-40 filter grayscale bg-slate-50 border-slate-200 text-slate-400'
                          : isAvailable === true
                          ? 'bg-slate-50 border-emerald-200 text-emerald-800'
                          : isAvailable === false
                          ? 'bg-rose-50 border-rose-200 text-rose-800'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                      }`}
                    >
                      <div
                        className={`w-2 h-2 rounded-full ${
                          isTargeted
                            ? 'bg-teal-600 shadow-[0_0_8px_rgba(13,148,136,0.6)]'
                            : isAvailable === true
                            ? 'bg-emerald-500'
                            : isAvailable === false
                            ? 'bg-rose-500'
                            : 'bg-slate-300'
                        }`}
                      />
                      <span className="text-xs tracking-tight">{list.name}</span>
                      {isAvailable === false && (
                        <span className="opacity-60 text-[10px] font-normal">(Missing PDF)</span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Contractor Selection Combobox */}
              <ContractorSelector
                companies={companies}
                selectedCompany={selectedCompany}
                onSelectCompany={(company) => {
                  setSelectedCompany(company);
                  setResults([]);
                }}
                searchTerm={companySearch}
                onSearchChange={setCompanySearch}
                isOpen={isCompanyDropdownOpen}
                onOpenChange={setIsCompanyDropdownOpen}
              />
            </div>

            {/* Active Contract Info Banner */}
            <AnimatePresence>
              {selectedCompany && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-4 overflow-hidden"
                >
                  <ActiveContractBanner company={selectedCompany} />
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* Section 2: Procedure Inquiries Card */}
          <section className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-6 sm:p-7 shadow-sm relative z-10 text-left">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-8 h-8 rounded-xl bg-teal-700 text-white flex items-center justify-center font-bold text-sm shadow-xs">
                2
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900 font-display">
                  Search & Match Procedures
                </h2>
                <p className="text-xs text-slate-500">
                  Select one or multiple medical procedures in Arabic or English to cross-reference contract rates.
                </p>
              </div>
            </div>

            {/* Selected Chips */}
            <SelectedProcedureChips
              procedures={selectedProcedures}
              onRemove={handleRemoveProcedure}
            />

            {/* Accessible Search Input */}
            <ProcedureSearchBar
              input={procedureInput}
              onInputChange={setProcedureInput}
              isOpen={isProcedureDropdownOpen}
              onOpenChange={setIsProcedureDropdownOpen}
              standardProcedures={standardProcedures}
              onSelectProcedure={handleAddProcedure}
              onAddCustom={handleAddCustomProcedure}
              onSubmit={handleSearch}
              loading={loading}
              canSubmit={selectedProcedures.length > 0}
            />

            {/* AI Toggle Option */}
            <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-600">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={aiSearchEnabled}
                  onChange={(e) => setAiSearchEnabled(e.target.checked)}
                  className="w-4 h-4 text-teal-700 focus:ring-teal-600 border-slate-300 rounded cursor-pointer"
                />
                <span className="font-semibold text-slate-700">
                  Enable AI Semantic Matching for custom terms (Google Gemini flash model)
                </span>
              </label>

              {selectedProcedures.some((p) => p.isCustom) && (
                <span className="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 self-start sm:self-auto">
                  <Sparkles size={11} />
                  AI search active for custom terms
                </span>
              )}
            </div>

            {/* Recent Searches */}
            <AnimatePresence>
              {recentSearches.length > 0 && results.length === 0 && !loading && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-6 border-t border-slate-100 pt-4"
                >
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      <Clock size={12} />
                      <span>Recent Procedure Inquiries</span>
                    </div>
                    {user && (
                      <button
                        type="button"
                        onClick={() => {
                          clearRecentSearches(user.uid);
                        }}
                        className="text-[11px] text-slate-400 hover:text-rose-600 transition-colors flex items-center gap-1 cursor-pointer font-medium focus-visible:outline-none"
                        title="Clear recent search inquiries"
                      >
                        <Trash2 size={11} />
                        <span>Clear history</span>
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {recentSearches.map((search) => (
                      <div
                        key={search.id}
                        className="group inline-flex items-center bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-full text-xs font-semibold text-slate-700 hover:text-slate-900 transition-all pl-3 pr-1.5 py-1 gap-1.5"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            const parts = search.query.split(', ');
                            const newProcs: SelectedProcedure[] = parts.map((name: string) => {
                              const match = standardProcedures.find(
                                (sp) => sp.english.toLowerCase() === name.toLowerCase()
                              );
                              return {
                                id: Math.random().toString(36).substring(2, 9),
                                name,
                                arabic: match?.arabic,
                                isCustom: !match,
                              };
                            });
                            setSelectedProcedures(newProcs);
                            if (search.companyName) {
                              const matchedComp = companies.find(
                                (c) => c.name.toLowerCase() === search.companyName?.toLowerCase()
                              );
                              if (matchedComp) setSelectedCompany(matchedComp);
                            }
                          }}
                          className="flex items-center gap-1.5 cursor-pointer text-left focus:outline-none"
                        >
                          <span className="truncate max-w-[200px] sm:max-w-[300px]">{search.query}</span>
                          {search.companyName && (
                            <span className="text-[10px] text-teal-800 bg-teal-50 border border-teal-200/80 px-1.5 py-0.2 rounded-md font-semibold truncate max-w-[120px]">
                              {search.companyName}
                            </span>
                          )}
                          <span className="text-[10px] bg-slate-200 text-slate-700 px-1.5 py-0.2 rounded-full font-bold">
                            {search.resultCount}
                          </span>
                        </button>

                        {user && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSearch(user.uid, search.id);
                            }}
                            className="text-slate-400 hover:text-rose-600 p-0.5 rounded-full hover:bg-slate-200/60 transition-colors cursor-pointer"
                            title="Remove inquiry from history"
                            aria-label={`Remove inquiry ${search.query}`}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* Section 3: Search Status Progress */}
          <AnimatePresence>
            {loading && <SearchStatusProgress status={searchStatus} />}
          </AnimatePresence>

          {/* Section 4: Results & Quotation Output */}
          <AnimatePresence>
            {(results.length > 0 || error) && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* Standard Copyable Arabic Quotation Report */}
                {selectedProcedures.length > 0 && (
                  <CopyableReportCard
                    results={results}
                    selectedCompany={selectedCompany}
                    selectedProcedures={selectedProcedures}
                  />
                )}

                {/* Outlook Operational Guide */}
                <OutlookTipsCard />

                {/* Error Banner */}
                {error && results.length === 0 && (
                  <div
                    className="bg-rose-50 border border-rose-200 rounded-2xl p-6 flex flex-col sm:flex-row items-start justify-between gap-4 text-rose-900 text-left shadow-xs"
                    role="alert"
                  >
                    <div className="flex items-start gap-3.5">
                      <AlertCircle className="shrink-0 mt-0.5 text-rose-600" size={20} />
                      <div>
                        <h4 className="text-sm font-bold">Procedure Search Notice</h4>
                        <p className="text-xs text-rose-800 leading-relaxed mt-1">{error}</p>
                      </div>
                    </div>

                    {error.toLowerCase().includes('gemini') && (
                      <button
                        type="button"
                        onClick={() => setIsAiModalOpen(true)}
                        className="px-4 py-2 bg-rose-700 hover:bg-rose-800 text-white rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 shadow-xs shrink-0 cursor-pointer"
                      >
                        <Key size={14} />
                        <span>Configure Gemini Key</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Results Listing Header */}
                {results.length > 0 && (
                  <div className="flex items-center justify-between px-2 pt-2">
                    <h3 className="text-xs font-black text-slate-700 uppercase tracking-wider">
                      Matched {results.length} Procedure{results.length > 1 ? 's' : ''}
                    </h3>
                    {selectedCompany && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                        <Tag size={12} />
                        {selectedCompany.discount}% Off Applied
                      </span>
                    )}
                  </div>
                )}

                {/* Individual Procedure Result Cards */}
                {results.map((result, idx) => (
                  <ProcedureResultCard
                    key={`${result.nameEnglish}-${idx}`}
                    result={result}
                    selectedCompany={selectedCompany}
                    index={idx}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      <AppFooter userEmail={user?.email} />

      {/* AI Key Settings Dialog */}
      <AiSettingsModal
        isOpen={isAiModalOpen}
        onClose={() => setIsAiModalOpen(false)}
        onKeyUpdated={() => setAiKeyVersion((v) => v + 1)}
      />
    </div>
  );
}
