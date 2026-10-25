import React, { useState, useEffect, useMemo } from 'react';
import {
  Inbox,
  FileCheck2,
  CheckCircle2,
  Clock,
  AlertCircle,
  Pause,
  Play,
  Building2,
  Download,
  Copy,
  Check,
  RefreshCw,
} from 'lucide-react';
import { InpatientApprovalRecord, AutomationSettings, CompanyInfo, CompanyConfigRecord } from '../../types';
import {
  subscribeToApprovals,
  subscribeToAutomationSettings,
  subscribeToCompanyConfigs,
  setAutomationPaused,
  triggerManualApprovalsSync,
} from '../../services/approvalsFirebaseService';
import { ApprovalsTable } from './ApprovalsTable';
import { ContractorManager } from './ContractorManager';

interface ApprovalsHubProps {
  userEmail?: string;
  catalogCompanies?: CompanyInfo[];
}

export function resolveApprovalContractorAndOfficer(
  approval: InpatientApprovalRecord,
  companies: CompanyConfigRecord[]
): { contractor: string; officer: string; priceListYear?: string } {
  const rawQuery = (approval.contractorNormalized || approval.contractorRaw || '').trim();
  if (!rawQuery || rawQuery === 'غير محدد') {
    return {
      contractor: approval.contractorNormalized || approval.contractorRaw || 'غير محدد',
      officer: approval.contractorOfficer || 'غير محدد',
      priceListYear: approval.priceListYear,
    };
  }

  const queryNorm = rawQuery.toLowerCase();

  const match = companies.find((c) => {
    if (c.name.trim().toLowerCase() === queryNorm) return true;
    if (c.aliases && c.aliases.some((a) => a.trim().toLowerCase() === queryNorm)) return true;
    if (c.id && c.id.toLowerCase() === queryNorm) return true;
    return false;
  });

  if (match) {
    return {
      contractor: match.name,
      officer: match.contractorOfficer || 'غير محدد',
      priceListYear: match.priceListYear,
    };
  }

  return {
    contractor: approval.contractorNormalized || approval.contractorRaw || 'غير محدد',
    officer: approval.contractorOfficer || 'غير محدد',
    priceListYear: approval.priceListYear,
  };
}

export const ApprovalsHub: React.FC<ApprovalsHubProps> = ({
  userEmail,
  catalogCompanies,
}) => {
  const [activeTab, setActiveTab] = useState<'feed' | 'contractors'>('feed');
  const [dateFilter, setDateFilter] = useState<string>('30days');

  const [approvals, setApprovals] = useState<InpatientApprovalRecord[]>([]);
  const [companyConfigs, setCompanyConfigs] = useState<CompanyConfigRecord[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(true);
  const [automationSettings, setAutomationSettings] = useState<AutomationSettings>({
    isPaused: false,
    pollingIntervalSeconds: 120,
  });
  const [isTogglingPause, setIsTogglingPause] = useState(false);
  const [reportCopied, setReportCopied] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Prevent button from being permanently locked if a background sync crashed or timed out (> 2 minutes ago)
  const isSyncActive = useMemo(() => {
    if (isSyncing) return true;
    if (!automationSettings.isSyncing) return false;
    const lastRun = automationSettings.lastRunAt;
    if (!lastRun) return true;
    const lastRunTime = lastRun.toDate ? lastRun.toDate().getTime() : new Date(lastRun).getTime();
    return Date.now() - lastRunTime < 120000;
  }, [isSyncing, automationSettings.isSyncing, automationSettings.lastRunAt]);

  const handleManualSync = async () => {
    try {
      setIsSyncing(true);
      setSyncMessage(null);
      const res = await triggerManualApprovalsSync();
      setSyncMessage(res.message || 'Sync complete!');
      setTimeout(() => setSyncMessage(null), 4000);
    } catch (err: any) {
      console.error('Manual sync failed:', err);
      setSyncMessage('Sync request failed');
      setTimeout(() => setSyncMessage(null), 4000);
    } finally {
      setTimeout(() => setIsSyncing(false), 1200);
    }
  };

  // Subscribe to real-time approvals and company configs from Firestore
  useEffect(() => {
    const unsubApprovals = subscribeToApprovals((data) => {
      setApprovals(data);
      setLoadingApprovals(false);
    });

    const unsubSettings = subscribeToAutomationSettings((settings) => {
      setAutomationSettings(settings);
    });

    const unsubCompanies = subscribeToCompanyConfigs((configs) => {
      if (configs && configs.length > 0) {
        setCompanyConfigs(configs);
      }
    });

    // Background auto-sync heartbeat every 15 minutes while app is active
    const autoSyncInterval = setInterval(() => {
      triggerManualApprovalsSync().catch(() => {});
    }, 15 * 60 * 1000);

    return () => {
      unsubApprovals();
      unsubSettings();
      unsubCompanies();
      clearInterval(autoSyncInterval);
    };
  }, []);

  const handleTogglePause = async () => {
    try {
      setIsTogglingPause(true);
      const nextState = !automationSettings.isPaused;
      await setAutomationPaused(nextState, userEmail);
    } catch (err) {
      console.error('Failed to toggle automation state:', err);
    } finally {
      setIsTogglingPause(false);
    }
  };

  // Helper to safely parse dates from Date, Firestore Timestamp, or ISO string
  const toJsDate = (val: any): Date => {
    if (!val) return new Date();
    if (val instanceof Date) return val;
    if (typeof val.toDate === 'function') return val.toDate();
    if (val.seconds) return new Date(val.seconds * 1000);
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
  };

  // Compute metrics based on dateFilter within the 30-day window
  const filteredApprovals = approvals.filter((a) => {
    if (!a.receivedAt) return false;
    const date = toJsDate(a.receivedAt);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateStr = date.toISOString().split('T')[0];

    if (dateFilter === 'today') {
      return date >= startOfToday;
    } else if (dateFilter === 'yesterday') {
      const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
      return date >= startOfYesterday && date < startOfToday;
    } else if (dateFilter === '7days') {
      const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
      return date >= sevenDaysAgo;
    } else if (dateFilter === '30days' || dateFilter === 'all') {
      const thirtyDaysAgo = new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000);
      return date >= thirtyDaysAgo;
    } else if (dateFilter.includes('-')) {
      return dateStr === dateFilter;
    }
    return true;
  });

  const totalCount = filteredApprovals.length;
  const pendingApprovalCount = filteredApprovals.filter(
    (a) => !a.hasExistingApproval && !a.isRefused && a.status !== 'answered'
  ).length;
  const approvedReplyCount = filteredApprovals.filter(
    (a) => Boolean(a.hasExistingApproval) && !a.isRefused
  ).length;
  const refusedCount = filteredApprovals.filter(
    (a) => Boolean(a.isRefused)
  ).length;
  const answeredCount = filteredApprovals.filter((a) => a.status === 'answered').length;
  const draftedCount = filteredApprovals.filter((a) => a.status === 'draft_created').length;

  const handleCopyDailyReport = async () => {
    const dateLabel =
      dateFilter === 'today'
        ? 'Today'
        : dateFilter === 'yesterday'
        ? 'Yesterday'
        : dateFilter === '7days'
        ? 'Last 7 Days'
        : dateFilter === '30days' || dateFilter === 'all'
        ? 'Last 30 Days (Rolling History)'
        : dateFilter;

    const reportText = `📋 Elite Hospital - Inpatient Approvals Report (${dateLabel})
───────────────────────────────
• Total Received: ${totalCount}
• ⏳ Pending Approval: ${pendingApprovalCount}
• ✅ Approved Replies ("لا مانع" / "Approved"): ${approvedReplyCount}
• ❌ Refused / Not Covered (غير مغطى / مرفوض): ${refusedCount}
• ✉️ Answered (Sent): ${answeredCount}
• ✍️ Drafted in Outlook: ${draftedCount}

Breakdown by Contractor & Officer:
${(Object.entries(
  filteredApprovals.reduce((acc, a) => {
    const res = resolveApprovalContractorAndOfficer(a, companyConfigs);
    const key = `${res.contractor} (سيلز: ${res.officer})`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {} as Record<string, number>)
) as [string, number][])
  .sort((a, b) => b[1] - a[1])
  .map(([c, count]) => `  - ${c}: ${count}`)
  .join('\n')}

Breakdown by Officer (سيلز):
${(Object.entries(
  filteredApprovals.reduce((acc, a) => {
    const res = resolveApprovalContractorAndOfficer(a, companyConfigs);
    const officer = res.officer;
    acc[officer] = (acc[officer] || 0) + 1;
    return acc;
  }, {} as Record<string, number>)
) as [string, number][])
  .sort((a, b) => b[1] - a[1])
  .map(([o, count]) => `  - ${o}: ${count} طلبات`)
  .join('\n')}
───────────────────────────────
Generated via Elite Corporate Approvals Hub • 30-Day Rolling Active`;

    try {
      await navigator.clipboard.writeText(reportText);
      setReportCopied(true);
      setTimeout(() => setReportCopied(false), 2500);
    } catch (err) {
      console.error('Failed to copy report:', err);
    }
  };

  return (
    <div className="space-y-6 text-left w-full mx-auto">
      {/* Top Banner: Status, Pause Switch & Navigation Tabs */}
      <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Sub-Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100/80 rounded-xl border border-slate-200/60">
          <button
            onClick={() => setActiveTab('feed')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'feed'
                ? 'bg-white text-teal-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Inbox size={15} />
            <span>Approvals Feed & Reports</span>
            {pendingApprovalCount > 0 && (
              <span className="w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-black flex items-center justify-center">
                {pendingApprovalCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('contractors')}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
              activeTab === 'contractors'
                ? 'bg-white text-teal-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Building2 size={15} />
            <span>Contractors & Officers</span>
          </button>
        </div>

        {/* Global Pause / Resume Switch */}
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
              automationSettings.isPaused
                ? 'bg-amber-50 border-amber-300 text-amber-900'
                : 'bg-emerald-50 border-emerald-300 text-emerald-900'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                automationSettings.isPaused
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
              }`}
            />
            <span>{automationSettings.isPaused ? 'Automation: PAUSED' : 'Automation: RUNNING'}</span>
          </div>

          <button
            onClick={handleTogglePause}
            disabled={isTogglingPause}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer active:scale-98 shadow-xs border ${
              automationSettings.isPaused
                ? 'bg-teal-700 hover:bg-teal-800 text-white border-teal-800'
                : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300'
            }`}
            title={automationSettings.isPaused ? 'Resume monitoring InApprovals' : 'Pause automation'}
          >
            {automationSettings.isPaused ? (
              <>
                <Play size={13} className="fill-current" />
                <span>Resume</span>
              </>
            ) : (
              <>
                <Pause size={13} className="fill-current" />
                <span>Pause</span>
              </>
            )}
          </button>

          {/* Manual Sync Button */}
          <button
            onClick={handleManualSync}
            disabled={isSyncActive}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer active:scale-98 shadow-xs border ${
              isSyncActive
                ? 'bg-teal-50 border-teal-300 text-teal-800'
                : 'bg-white hover:bg-slate-50 text-slate-700 border-slate-300'
            }`}
            title="Scan Outlook / Exchange InApprovals folder immediately"
          >
            <RefreshCw size={13} className={isSyncActive ? 'animate-spin text-teal-700' : 'text-slate-500'} />
            <span>{isSyncActive ? 'Syncing...' : 'Sync Emails Now'}</span>
          </button>
        </div>
      </div>

      {/* Live Syncing / Polling Indicator */}
      {isSyncActive && (
        <div className="px-4 py-2.5 bg-teal-50 border border-teal-300/90 rounded-2xl text-xs font-bold text-teal-950 flex items-center justify-between shadow-2xs animate-pulse">
          <div className="flex items-center gap-2">
            <RefreshCw size={14} className="animate-spin text-teal-700 shrink-0" />
            <span>جاري فحص وتحديث الموافقات مع البريد الإلكتروني (Outlook / Exchange)...</span>
          </div>
          <span className="text-[11px] text-teal-800 font-semibold bg-teal-100 px-2 py-0.5 rounded-full">Sync Active</span>
        </div>
      )}

      {/* Sync Status Banner */}
      {syncMessage && (
        <div className="px-4 py-2.5 bg-emerald-50 border border-emerald-300/80 rounded-2xl text-xs font-bold text-emerald-950 flex items-center justify-between shadow-2xs animate-in fade-in">
          <span>✓ {syncMessage}</span>
          <button onClick={() => setSyncMessage(null)} className="text-emerald-700 hover:text-emerald-950 cursor-pointer">
            ✕
          </button>
        </div>
      )}

      {/* KPI Stats Cards (Visible when on feed tab) */}
      {activeTab === 'feed' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
          {/* Total Received */}
          <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-bold uppercase tracking-wider">Total Received</span>
              <div className="w-7 h-7 rounded-lg bg-teal-50 text-teal-800 flex items-center justify-center">
                <Inbox size={14} />
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-black text-slate-900 font-display">
              {totalCount}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              30-Day Window: {dateFilter === 'today' ? 'Today' : dateFilter === 'yesterday' ? 'Yesterday' : dateFilter === '7days' ? 'Last 7 Days' : dateFilter === '30days' || dateFilter === 'all' ? 'Full 30 Days' : dateFilter}
            </p>
          </div>

          {/* Pending Approval */}
          <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-bold uppercase tracking-wider">Pending Approval</span>
              <div className="w-7 h-7 rounded-lg bg-amber-50 text-amber-800 flex items-center justify-center">
                <Clock size={14} />
              </div>
            </div>
            <div className={`text-2xl sm:text-3xl font-black font-display ${
              pendingApprovalCount > 0 ? 'text-amber-600' : 'text-slate-900'
            }`}>
              {pendingApprovalCount}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Pending insurance reply
            </p>
          </div>

          {/* Approved Replies ("لا مانع" / "Approved") */}
          <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-bold uppercase tracking-wider">Approved Replies</span>
              <div className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-800 flex items-center justify-center">
                <CheckCircle2 size={14} />
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-black text-emerald-700 font-display">
              {approvedReplyCount}
            </div>
            <p className="text-[11px] text-emerald-600 font-medium mt-1">
              Confirmed (لا مانع / Approved)
            </p>
          </div>

          {/* Refused / Not Covered */}
          <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-bold uppercase tracking-wider">Refused / Not Covered</span>
              <div className="w-7 h-7 rounded-lg bg-rose-50 text-rose-800 flex items-center justify-center">
                <AlertCircle size={14} />
              </div>
            </div>
            <div className={`text-2xl sm:text-3xl font-black font-display ${
              refusedCount > 0 ? 'text-rose-600' : 'text-slate-900'
            }`}>
              {refusedCount}
            </div>
            <p className="text-[11px] text-rose-600 font-medium mt-1">
              Refused (غير مغطى / مرفوض)
            </p>
          </div>

          {/* Answered / Sent */}
          <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-xs font-bold uppercase tracking-wider">Answered (Sent)</span>
              <div className="w-7 h-7 rounded-lg bg-teal-50 text-teal-800 flex items-center justify-center">
                <Check size={14} />
              </div>
            </div>
            <div className="text-2xl sm:text-3xl font-black text-teal-800 font-display">
              {answeredCount}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              {draftedCount} drafts prepared
            </p>
          </div>
        </div>
      )}

      {/* Main View Router */}
      {activeTab === 'feed' ? (
        <div className="space-y-4">
          {/* Quick Handover Export Button */}
          <div className="flex justify-end">
            <button
              onClick={handleCopyDailyReport}
              className="text-xs font-bold text-slate-600 hover:text-slate-900 bg-white/95 border border-slate-200 px-3.5 py-1.5 rounded-xl shadow-2xs hover:bg-slate-50 flex items-center gap-1.5 transition-all cursor-pointer"
            >
              {reportCopied ? (
                <>
                  <Check size={13} className="text-emerald-600" />
                  <span className="text-emerald-700">Copied Shift Report!</span>
                </>
              ) : (
                <>
                  <Copy size={13} />
                  <span>Copy Daily Handover Report</span>
                </>
              )}
            </button>
          </div>

          <ApprovalsTable
            approvals={approvals}
            loading={loadingApprovals}
            selectedDateFilter={dateFilter}
            onDateFilterChange={setDateFilter}
            companyConfigs={companyConfigs}
          />
        </div>
      ) : (
        <ContractorManager
          userEmail={userEmail}
          catalogCompanies={catalogCompanies}
        />
      )}
    </div>
  );
};
