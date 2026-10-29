import React, { useState, useMemo } from 'react';
import {
  Search,
  Filter,
  Eye,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileCheck,
  Check,
  Building,
  User,
  ChevronRight,
  MessageSquare,
  MessageCircle,
  Send,
  Calendar,
  Sparkles,
  ShieldCheck,
  Coins,
  HelpCircle,
  XCircle,
  X,
  LayoutGrid,
  List,
} from 'lucide-react';
import { InpatientApprovalRecord, CompanyConfigRecord } from '../../types';
import { toggleApprovalStatus, triggerManualDraft, updateApprovalStatus } from '../../services/approvalsFirebaseService';
import { generateCmWhatsappMessageAsync } from '../../lib/whatsapp-generator';
import { buildDraftReplyFromRecord } from '../../lib/draftReplyBuilder';
import { stripSentFromSignatures } from '../../lib/arabic-normalizer';
import { ViewDraftModal } from './ViewDraftModal';
import { resolveApprovalContractorAndOfficer } from './ApprovalsHub';

function cleanDisplayText(text?: string | null): string {
  if (!text) return '';
  let str = text;
  for (let i = 0; i < 2; i++) {
    str = str
      .replace(/&#x0*d;/gi, ' ')
      .replace(/&#0*13;/gi, ' ')
      .replace(/&#x0*a;/gi, ' ')
      .replace(/&#0*10;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#0*39;/gi, "'")
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  }
  return str
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ApprovalsTableProps {
  approvals: InpatientApprovalRecord[];
  loading: boolean;
  selectedDateFilter: string;
  onDateFilterChange: (filter: string) => void;
  companyConfigs?: CompanyConfigRecord[];
}

export const ApprovalsTable: React.FC<ApprovalsTableProps> = ({
  approvals,
  loading,
  selectedDateFilter,
  onDateFilterChange,
  companyConfigs = [],
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    | 'all'
    | 'pending_approval'
    | 'approved_reply'
    | 'conditionally_approved'
    | 'pending_information'
    | 'refused'
    | 'answered'
    | 'draft_created'
  >('all');
  const [viewingApproval, setViewingApproval] = useState<InpatientApprovalRecord | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [draftingManualId, setDraftingManualId] = useState<string | null>(null);
  const [copiedWhatsappId, setCopiedWhatsappId] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');

  const handleMarkApproved = async (record: InpatientApprovalRecord) => {
    try {
      setUpdatingStatusId(record.id);
      await updateApprovalStatus(record.id, 'approved', 'تمت الموافقة واعتماد الحالة يدوياً بواسطة منسق التأمين');
    } catch (err) {
      console.error('Failed to mark as approved:', err);
    } finally {
      setUpdatingStatusId(null);
    }
  };

  const handleCancelApproval = async (record: InpatientApprovalRecord) => {
    if (!window.confirm(`هل أنت متأكد من إلغاء طلب الموافقة للمريض: ${record.patientName}؟`)) {
      return;
    }
    try {
      setUpdatingStatusId(record.id);
      await updateApprovalStatus(record.id, 'refused', 'تم إلغاء طلب الموافقة يدوياً');
    } catch (err) {
      console.error('Failed to cancel approval:', err);
    } finally {
      setUpdatingStatusId(null);
    }
  };

  const handleCopyWhatsapp = async (record: InpatientApprovalRecord) => {
    try {
      const msg = await generateCmWhatsappMessageAsync(record);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(msg);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = msg;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedWhatsappId(record.id);
      setTimeout(() => setCopiedWhatsappId(null), 2500);
    } catch (err) {
      console.error('Failed to copy CM WhatsApp message:', err);
    }
  };

  const handleToggleStatus = async (record: InpatientApprovalRecord) => {
    try {
      setTogglingId(record.id);
      await toggleApprovalStatus(record.id, record.status);
    } catch (err) {
      console.error('Failed to toggle status:', err);
    } finally {
      setTogglingId(null);
    }
  };

  const handleManualDraft = async (record: InpatientApprovalRecord) => {
    try {
      setDraftingManualId(record.id);
      const rawOfficer = record.contractorOfficer;
      const rawYear = record.priceListYear;
      let effectiveDraft = record.draftBody || record.suggestedDraftReply;
      const isStaleDraft =
        !effectiveDraft ||
        effectiveDraft === 'undefined' ||
        (rawOfficer && rawOfficer !== 'غير محدد' && !rawOfficer.includes('يتطلب تحديد') && !effectiveDraft.includes(rawOfficer.trim())) ||
        (rawYear && !effectiveDraft.includes(rawYear));

      if (isStaleDraft) {
        effectiveDraft = buildDraftReplyFromRecord(record);
      }

      await triggerManualDraft(record.id, {
        draftText: effectiveDraft,
        contractorOfficer: record.contractorOfficer,
        priceListYear: record.priceListYear,
      });
    } catch (err) {
      console.error('Failed to trigger manual draft:', err);
    } finally {
      setDraftingManualId(null);
    }
  };

  const toJsDate = (val: any): Date => {
    if (!val) return new Date();
    if (val instanceof Date) return val;
    if (typeof val.toDate === 'function') return val.toDate();
    if (val.seconds) return new Date(val.seconds * 1000);
    const d = new Date(val);
    return isNaN(d.getTime()) ? new Date() : d;
  };

  // Generate 30 rolling calendar days with request counts for day-by-day navigation
  const dayOptions = useMemo(() => {
    const result = [];
    const now = new Date();
    const countMap = new Map<string, number>();

    for (const a of approvals) {
      if (!a.receivedAt) continue;
      const d = toJsDate(a.receivedAt);
      const dateStr = d.toISOString().split('T')[0];
      countMap.set(dateStr, (countMap.get(dateStr) || 0) + 1);
    }

    for (let i = 0; i < 30; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      let label = '';
      if (i === 0) {
        label = `Today (${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`;
      } else if (i === 1) {
        label = `Yesterday (${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`;
      } else {
        label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      }
      const count = countMap.get(dateStr) || 0;
      result.push({ dateStr, label, count });
    }
    return result;
  }, [approvals]);

  // Filter approvals based on search, status, and 30-day date range
  const filteredApprovals = approvals.filter((a) => {
    // 1. Search term
    const term = searchTerm.toLowerCase().trim();
    if (term) {
      const res = resolveApprovalContractorAndOfficer(a, companyConfigs);
      const match =
        a.patientName?.toLowerCase().includes(term) ||
        a.mrn?.includes(term) ||
        res.contractor.toLowerCase().includes(term) ||
        res.officer.toLowerCase().includes(term) ||
        a.contractorNormalized?.toLowerCase().includes(term) ||
        a.contractorRaw?.toLowerCase().includes(term) ||
        a.contractorOfficer?.toLowerCase().includes(term) ||
        a.requestedServices?.some((s) => s.name.toLowerCase().includes(term));
      if (!match) return false;
    }

    // 2. Status filter
    if (statusFilter === 'pending_approval') {
      if (
        a.hasExistingApproval ||
        a.isRefused ||
        a.status === 'answered' ||
        a.status === 'approved' ||
        a.status === 'conditionally_approved'
      )
        return false;
    } else if (statusFilter === 'approved_reply') {
      if ((!a.hasExistingApproval && a.status !== 'approved') || a.isRefused || a.status === 'refused')
        return false;
    } else if (statusFilter === 'conditionally_approved') {
      if (a.status !== 'conditionally_approved' && a.status !== 'partially_approved') return false;
    } else if (statusFilter === 'pending_information') {
      if (a.status !== 'pending_information') return false;
    } else if (statusFilter === 'refused') {
      if (!a.isRefused && a.status !== 'refused') return false;
    } else if (statusFilter === 'answered') {
      if (a.status !== 'answered') return false;
    } else if (statusFilter === 'draft_created') {
      if (a.status !== 'draft_created') return false;
    }

    // 3. Date filter (strictly within 30-day rolling history)
    if (a.receivedAt) {
      const date = toJsDate(a.receivedAt);
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dateStr = date.toISOString().split('T')[0];

      if (selectedDateFilter === 'today') {
        if (date < startOfToday) return false;
      } else if (selectedDateFilter === 'yesterday') {
        const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
        if (date < startOfYesterday || date >= startOfToday) return false;
      } else if (selectedDateFilter === '7days') {
        const sevenDaysAgo = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
        if (date < sevenDaysAgo) return false;
      } else if (selectedDateFilter === '30days' || selectedDateFilter === 'all') {
        const thirtyDaysAgo = new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000);
        if (date < thirtyDaysAgo) return false;
      } else if (selectedDateFilter.includes('-')) {
        // Specific day YYYY-MM-DD
        if (dateStr !== selectedDateFilter) return false;
      }
    }

    return true;
  }).sort((a, b) => {
    const getEpoch = (val: any) => {
      if (!val) return 0;
      if (typeof val.toMillis === 'function') return val.toMillis();
      if (typeof val.toDate === 'function') return val.toDate().getTime();
      if (val.seconds) return val.seconds * 1000;
      const d = new Date(val).getTime();
      return isNaN(d) ? 0 : d;
    };
    return getEpoch(b.receivedAt) - getEpoch(a.receivedAt);
  });

  const formatTimestamp = (ts: any) => {
    if (!ts) return 'Just now';
    try {
      const d = toJsDate(ts);
      const isToday =
        d.toDateString() === new Date().toDateString();
      if (isToday) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      return '';
    }
  };

  return (
    <div className="space-y-4 text-left">
      {/* 30-Day Rolling History Notification Banner */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-xl bg-teal-50/70 border border-teal-200/80 text-xs text-teal-900">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-teal-700 shrink-0" />
          <span>
            <strong>30-Day Rolling History Active:</strong> Logs roll over automatically daily. Retaining the last 30 calendar days.
          </span>
        </div>
        <span className="text-[11px] font-semibold text-teal-800 bg-white/80 px-2 py-0.5 rounded-md border border-teal-200">
          Showing: {selectedDateFilter === 'today' ? 'Today' : selectedDateFilter === 'yesterday' ? 'Yesterday' : selectedDateFilter === '7days' ? 'Last 7 Days' : selectedDateFilter === '30days' || selectedDateFilter === 'all' ? 'Full 30 Days' : selectedDateFilter}
        </span>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl p-4 shadow-xs">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search patient, MRN, contractor, service..."
            dir="auto"
            className="w-full pl-9 pr-4 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-medium text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all"
          />
        </div>

        {/* Filters Group */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Date Pills */}
          <div className="flex items-center rounded-xl border border-slate-200 p-0.5 bg-slate-50/70 text-xs font-bold text-slate-600">
            <button
              onClick={() => onDateFilterChange('today')}
              className={`px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                selectedDateFilter === 'today'
                  ? 'bg-white text-teal-800 shadow-2xs font-extrabold'
                  : 'hover:text-slate-900'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => onDateFilterChange('yesterday')}
              className={`px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                selectedDateFilter === 'yesterday'
                  ? 'bg-white text-teal-800 shadow-2xs font-extrabold'
                  : 'hover:text-slate-900'
              }`}
            >
              Yesterday
            </button>
            <button
              onClick={() => onDateFilterChange('7days')}
              className={`px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                selectedDateFilter === '7days'
                  ? 'bg-white text-teal-800 shadow-2xs font-extrabold'
                  : 'hover:text-slate-900'
              }`}
            >
              7 Days
            </button>
            <button
              onClick={() => onDateFilterChange('30days')}
              className={`px-2.5 py-1.5 rounded-lg transition-all cursor-pointer ${
                selectedDateFilter === '30days' || selectedDateFilter === 'all'
                  ? 'bg-white text-teal-800 shadow-2xs font-extrabold'
                  : 'hover:text-slate-900'
              }`}
            >
              30 Days
            </button>
          </div>

          {/* Day-by-Day Selector for the 30-Day Window */}
          <div className="relative">
            <select
              value={selectedDateFilter.includes('-') ? selectedDateFilter : ''}
              onChange={(e) => onDateFilterChange(e.target.value || 'today')}
              className="pl-3 pr-7 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-bold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all cursor-pointer"
              title="Select a specific day within the 30-day window"
            >
              <option value="">📅 Pick Specific Day...</option>
              {dayOptions.map((opt) => (
                <option key={opt.dateStr} value={opt.dateStr}>
                  {opt.label} {opt.count > 0 ? `(${opt.count})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-3 py-2 rounded-xl border border-slate-200 bg-slate-50/50 text-xs font-bold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-600 transition-all cursor-pointer"
          >
            <option value="all">All Statuses (جميع الحالات)</option>
            <option value="approved_reply">✅ Approved (معتمد بالكامل)</option>
            <option value="conditionally_approved">🛡️ Conditionally Approved (موافقة مشروطة)</option>
            <option value="pending_information">❓ Info Requested (مطلوب استيفاء بيانات)</option>
            <option value="pending_approval">⏳ Pending Approval (قيد المتابعة)</option>
            <option value="refused">❌ Refused / Not Covered (غير مغطى / مرفوض)</option>
            <option value="answered">✉️ Answered (Sent)</option>
            <option value="draft_created">✍️ Draft Created</option>
          </select>
        </div>
      </div>

      {/* Main Approvals Table */}
      <div className="bg-white/95 backdrop-blur-md border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <FileCheck size={16} className="text-teal-700" />
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              Inpatient Approvals Feed ({filteredApprovals.length})
            </h3>
          </div>
          <div className="flex items-center gap-3">
            {/* View Mode Toggle */}
            <div className="flex items-center p-0.5 rounded-lg bg-slate-200/70 border border-slate-300/60 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`px-2.5 py-1 rounded-md font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  viewMode === 'table' ? 'bg-white text-teal-800 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
                title="Table View (عرض الجدول)"
              >
                <List size={13} />
                <span className="hidden sm:inline">Table</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('cards')}
                className={`px-2.5 py-1 rounded-md font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                  viewMode === 'cards' ? 'bg-white text-teal-800 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
                title="Cards View (عرض البطاقات)"
              >
                <LayoutGrid size={13} />
                <span className="hidden sm:inline">Cards</span>
              </button>
            </div>

            <span className="text-[11px] text-slate-400 hidden sm:inline">
              Source: Outlook / InApprovals Folder
            </span>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-slate-400 text-xs font-medium">
            Listening to live approvals from Firestore...
          </div>
        ) : filteredApprovals.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-xs font-medium space-y-1">
            <p>No approval emails match your selected filter.</p>
            <p className="text-[11px] text-slate-400">
              When an approval email arrives in Outlook, it appears here automatically.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table View (Guaranteed 100% width with zero horizontal scroll) */}
            <div className={`${viewMode === 'cards' ? 'hidden' : 'hidden lg:block'} overflow-hidden`}>
              <table className="w-full text-left border-collapse table-fixed">
                <colgroup>
                  <col style={{ width: '28%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '15%' }} />
                </colgroup>
                <thead>
                  <tr className="border-b border-slate-100 text-[11px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50/30">
                    <th className="py-3 px-4">Patient & MRN</th>
                    <th className="py-3 px-3">Contractor & Officer</th>
                    <th className="py-3 px-3">Requested Services</th>
                    <th className="py-3 px-2 text-center">Status</th>
                    <th className="py-3 px-2 text-right">Time</th>
                    <th className="py-3 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredApprovals.map((record) => {
                    const isAnswered = record.status === 'answered';
                    const isToggling = togglingId === record.id;
                    const allMatched = record.matchedProcedures?.every((m) => m.status === 'matched');

                    return (
                      <tr
                        key={record.id}
                        className={`hover:bg-slate-50/70 transition-colors ${
                          isAnswered ? 'bg-slate-50/40 opacity-80' : ''
                        }`}
                      >
                        {/* Patient Name & MRN */}
                        <td className="py-3 px-4 align-top">
                          <div className="font-extrabold text-slate-900 break-words" dir="auto">
                            {record.patientName}
                          </div>
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
                            <span>MRN: <strong className="text-slate-600">{record.mrn}</strong></span>
                            {record.bed && <span>• Bed: {record.bed}</span>}
                          </div>

                          {/* AI Executive Summary Banner */}
                          {record.aiThreadSummary && (
                            <div className="mt-2 p-2 rounded-xl bg-teal-50/80 border border-teal-200 text-xs text-slate-800 flex items-start gap-1.5 shadow-2xs">
                              <Sparkles size={13} className="text-teal-700 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1 mb-0.5">
                                  <span className="font-extrabold text-[10px] text-teal-800 uppercase tracking-wider">الملخص الذكي (AI Summary):</span>
                                </div>
                                <p className="text-[11px] font-medium text-slate-700 leading-relaxed break-words" dir="auto">
                                  {record.aiThreadSummary}
                                </p>
                              </div>
                            </div>
                          )}

                          {/* Refused / Not Covered Alert Banner */}
                          {record.isRefused && (
                            <div className="mt-2 p-2 rounded-xl bg-rose-50/95 border border-rose-300 text-xs text-rose-950 flex items-start gap-1.5 shadow-2xs">
                              <AlertCircle size={14} className="text-rose-600 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <span className="font-bold text-rose-800">رفض / غير مغطى:</span>{' '}
                                <span className="font-semibold text-rose-950 break-words" dir="auto">
                                  "{stripSentFromSignatures(record.refusalSnippet || 'غير مغطى')}"
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Existing Approval Reply Alert Banner */}
                          {record.hasExistingApproval && record.existingApprovalSnippet && !record.isRefused && (
                            <div className="mt-2 p-2 rounded-xl bg-emerald-50/90 border border-emerald-300 text-xs text-emerald-950 flex items-start gap-1.5 shadow-2xs">
                              <CheckCircle2 size={14} className="text-emerald-600 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <div>
                                  <span className="font-bold text-emerald-800">رد الموافقة المستلم:</span>{' '}
                                  <span className="font-semibold text-emerald-950 break-words" dir="auto">"{stripSentFromSignatures(record.existingApprovalSnippet)}"</span>
                                </div>
                                {record.creditLimitText && (
                                  <div className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-950 font-bold text-[11px] border border-emerald-300 shadow-2xs">
                                    <span>💰 الحد الأقصى للموافقة:</span>
                                    <span className="font-black text-emerald-950 underline decoration-emerald-500">{record.creditLimitText}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Discussion Replies Alert Banner */}
                          {record.hasReplies && !record.hasExistingApproval && !record.isRefused && record.replySnippet && record.replySnippet !== 'Thread has prior conversation/replies' && (
                            <div className="mt-2 p-2 rounded-xl bg-amber-50/90 border border-amber-300 text-xs text-amber-950 flex items-start gap-1.5 shadow-2xs">
                              <MessageSquare size={14} className="text-amber-600 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <span className="font-bold text-amber-800">يوجد ردود سابقة:</span>{' '}
                                <span className="italic font-medium text-amber-950 break-words" dir="auto">"{stripSentFromSignatures(record.replySnippet)}"</span>
                              </div>
                            </div>
                          )}
                        </td>

                        {/* Contractor & Officer */}
                        <td className="py-3 px-3 align-top">
                          {(() => {
                            const resolvedContractor = resolveApprovalContractorAndOfficer(record, companyConfigs);
                            return (
                              <>
                                <div className="flex items-center gap-1.5 font-bold text-slate-800 break-words" dir="auto">
                                  <Building size={12} className="text-slate-400 shrink-0" />
                                  <span>{resolvedContractor.contractor}</span>
                                </div>
                                <div className="flex items-center gap-1 text-[11px] text-slate-500 mt-0.5 flex-wrap">
                                  <User size={11} className="text-slate-400 shrink-0" />
                                  <span>سيلز: <strong className="text-slate-700">{resolvedContractor.officer}</strong></span>
                                  <span className="text-[10px] text-teal-700 bg-teal-50 px-1 rounded font-semibold">
                                    {resolvedContractor.priceListYear === 'Cash' ? '2026' : (resolvedContractor.priceListYear || record.priceListYear || '2026')}
                                  </span>
                                </div>
                              </>
                            );
                          })()}

                          {/* Financial Terms Badges */}
                          {((record.patientSharePercentage !== null && record.patientSharePercentage !== undefined) || record.approvedAmountLimit || record.coverageConditions) && (
                            <div className="flex flex-wrap items-center gap-1 mt-2">
                              {record.patientSharePercentage !== null && record.patientSharePercentage !== undefined && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-black bg-blue-50 text-blue-900 border border-blue-200">
                                  تحمل: {record.patientSharePercentage}%
                                </span>
                              )}
                              {record.approvedAmountLimit && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-black bg-emerald-50 text-emerald-900 border border-emerald-200">
                                  سقف: {record.approvedAmountLimit.toLocaleString()} ج.م
                                </span>
                              )}
                              {record.coverageConditions && (
                                <span
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-950 border border-amber-200 truncate max-w-[150px]"
                                  title={cleanDisplayText(record.coverageConditions)}
                                >
                                  {cleanDisplayText(record.coverageConditions)}
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Requested Services */}
                        <td className="py-3 px-3 align-top">
                          <div className="space-y-1">
                            {record.requestedServices?.map((srv, idx) => (
                              <div key={idx} className="flex items-start gap-1 text-[11px] leading-tight">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0 mt-1" />
                                <span className="text-slate-800 font-medium break-words">{srv.name}</span>
                              </div>
                            ))}
                          </div>
                          {allMatched ? (
                            <span className="inline-block mt-1 text-[10px] font-bold text-emerald-700">
                              ✓ All procedures matched
                            </span>
                          ) : (
                            <span className="inline-block mt-1 text-[10px] font-bold text-amber-700">
                              ⚠️ Has unlisted item
                            </span>
                          )}

                          {/* Two-Tier Classifier Pricing Breakdown */}
                          {record.pricedItemsJson && record.pricedItemsJson.length > 0 && (
                            <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
                              {record.pricedItemsJson.map((pi: any, pIdx: number) => (
                                <div key={pIdx} className="flex flex-wrap items-center justify-between gap-1 text-[10px] bg-slate-50 px-1.5 py-1 rounded border border-slate-200/80">
                                  <span className="font-semibold text-slate-700 truncate max-w-[120px]" title={pi.item_name_raw}>
                                    {pi.item_name_raw}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    {pi.price_source === 'CONTRACT' ? (
                                      <span className="px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-900 font-bold">
                                        {pi.line_total?.toLocaleString()} ج.م (تعاقد)
                                      </span>
                                    ) : pi.price_source === 'LIST_2026_PRICE_APPROVAL' ? (
                                      <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-950 font-bold border border-amber-300">
                                        {pi.line_total?.toLocaleString()} ج.م (موافقة سعرية)
                                      </span>
                                    ) : (
                                      <span className="px-1.5 py-0.2 rounded bg-rose-100 text-rose-900 font-bold">
                                        {pi.price_source}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>

                        {/* Status Badge */}
                        <td className="py-3 px-2 text-center align-top">
                          {isAnswered ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                              <Check size={11} className="text-emerald-600" />
                              Answered
                            </span>
                          ) : record.status === 'conditionally_approved' ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-50 text-teal-900 border border-teal-300 shadow-2xs">
                                <ShieldCheck size={11} className="text-teal-700" />
                                موافقة مشروطة
                              </span>
                              {record.approvedAmountLimit && (
                                <span className="text-[9px] font-bold text-teal-800 bg-teal-100 px-1.5 py-0.2 rounded">
                                  سقف: {record.approvedAmountLimit.toLocaleString()} ج.م
                                </span>
                              )}
                            </div>
                          ) : record.status === 'partially_approved' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-900 border border-indigo-300 shadow-2xs">
                              <ShieldCheck size={11} className="text-indigo-700" />
                              موافقة جزئية
                            </span>
                          ) : record.status === 'pending_information' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-50 text-sky-900 border border-sky-300 shadow-2xs">
                              <HelpCircle size={11} className="text-sky-700" />
                              استيفاء بيانات
                            </span>
                          ) : record.isRefused || record.status === 'refused' ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-800 border border-rose-300 shadow-2xs">
                              <AlertCircle size={11} className="text-rose-600" />
                              ملغي / مرفوض
                            </span>
                          ) : record.hasExistingApproval || record.status === 'approved' ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 shadow-2xs">
                                <CheckCircle2 size={11} className="text-emerald-600" />
                                معتمد بالكامل
                              </span>
                              {record.approvedAmountLimit && (
                                <span className="text-[9px] font-bold text-emerald-900 bg-emerald-100 px-1.5 py-0.2 rounded">
                                  💰 {record.approvedAmountLimit.toLocaleString()} ج.م
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300 shadow-2xs">
                              <Clock size={11} className="text-amber-600" />
                              Pending
                            </span>
                          )}

                          {/* Classifier Status & Price Approval Badges */}
                          {record.classifierStatus && (
                            <div className="mt-1.5 flex flex-col items-center gap-1">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-extrabold border ${
                                  record.classifierStatus === 'APPROVED'
                                    ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                                    : record.classifierStatus === 'PARTIAL'
                                    ? 'bg-indigo-50 text-indigo-900 border-indigo-300'
                                    : record.classifierStatus === 'REJECTED'
                                    ? 'bg-rose-50 text-rose-900 border-rose-300'
                                    : 'bg-amber-50 text-amber-900 border-amber-300'
                                }`}
                                title={`AI Classifier Verdict: ${record.classifierStatus}`}
                              >
                                <Sparkles size={9} />
                                {record.classifierStatus}
                              </span>
                              {record.priceApprovalRequired && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-100 text-amber-950 border border-amber-300">
                                  🏷️ موافقة سعرية ({record.priceApprovalTotal?.toLocaleString()} ج.م)
                                </span>
                              )}
                              {record.needsHumanReview && (
                                <span
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-100 text-rose-900 border border-rose-300"
                                  title={(record.reviewReasons || []).join(', ')}
                                >
                                  ⚠️ مراجعة بشرية
                                </span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Time */}
                        <td className="py-3 px-2 text-right text-[11px] font-semibold text-slate-500 whitespace-nowrap align-top">
                          {formatTimestamp(record.receivedAt)}
                        </td>

                        {/* Actions */}
                        <td className="py-3 px-3 text-right align-top">
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {/* Mark as Approved Button */}
                            <button
                              type="button"
                              onClick={() => handleMarkApproved(record)}
                              disabled={updatingStatusId === record.id || record.status === 'approved'}
                              className={`px-2 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 transition-all cursor-pointer ${
                                record.status === 'approved'
                                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 opacity-80 cursor-default'
                                  : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs active:scale-95'
                              }`}
                              title={record.status === 'approved' ? 'الحالة معتمدة بالفعل' : 'اعتماد الموافقة (Mark as Approved)'}
                            >
                              <CheckCircle2 size={12} className={record.status === 'approved' ? 'text-emerald-700' : 'text-white'} />
                              <span>اعتماد</span>
                            </button>

                            {/* Cancel Approval Button */}
                            <button
                              type="button"
                              onClick={() => handleCancelApproval(record)}
                              disabled={updatingStatusId === record.id || record.status === 'refused' || record.isRefused}
                              className={`px-2 py-1 rounded-lg text-[11px] font-bold inline-flex items-center gap-1 transition-all cursor-pointer ${
                                record.status === 'refused' || record.isRefused
                                  ? 'bg-rose-100 text-rose-800 border border-rose-300 opacity-80 cursor-default'
                                  : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 active:scale-95'
                              }`}
                              title={record.status === 'refused' || record.isRefused ? 'الطلب ملغي / مرفوض' : 'إلغاء الطلب (Cancel Approval)'}
                            >
                              <XCircle size={12} className={record.status === 'refused' || record.isRefused ? 'text-rose-700' : 'text-rose-600'} />
                              <span>إلغاء</span>
                            </button>

                            {/* CM Whatsapp Button */}
                            <button
                              type="button"
                              onClick={() => handleCopyWhatsapp(record)}
                              className={`p-1.5 rounded-lg text-[11px] font-bold inline-flex items-center transition-all cursor-pointer ${
                                copiedWhatsappId === record.id
                                  ? 'bg-emerald-600 text-white shadow-xs'
                                  : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300'
                              }`}
                              title="Copy Case Manager WhatsApp Message"
                            >
                              {copiedWhatsappId === record.id ? (
                                <Check size={12} className="text-white" />
                              ) : (
                                <MessageCircle size={12} className="text-emerald-700" />
                              )}
                            </button>

                            {/* Manual Draft Button */}
                            {record.status === 'pending_manual_draft' && (
                              <button
                                type="button"
                                onClick={() => handleManualDraft(record)}
                                disabled={draftingManualId === record.id}
                                className="px-2 py-1 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-bold inline-flex items-center gap-1 shadow-2xs transition-all cursor-pointer"
                                title="Draft Reply to Outlook"
                              >
                                <Send size={11} />
                                <span>{draftingManualId === record.id ? '...' : 'Draft'}</span>
                              </button>
                            )}

                            {/* View Draft Modal Button */}
                            <button
                              type="button"
                              onClick={() => {
                                const resolved = resolveApprovalContractorAndOfficer(record, companyConfigs);
                                setViewingApproval({
                                  ...record,
                                  contractorNormalized: resolved.contractor,
                                  contractorOfficer: resolved.officer,
                                  priceListYear: resolved.priceListYear || record.priceListYear,
                                });
                              }}
                              className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-slate-700 text-[11px] font-bold inline-flex items-center transition-all cursor-pointer"
                              title="Preview AI Drafted Reply"
                            >
                              <Eye size={12} />
                            </button>

                            {/* Toggle Answered Button */}
                            <button
                              type="button"
                              onClick={() => handleToggleStatus(record)}
                              disabled={isToggling}
                              className={`p-1.5 rounded-lg text-[11px] font-bold inline-flex items-center transition-all cursor-pointer ${
                                isAnswered
                                  ? 'border border-slate-200 text-slate-500 hover:bg-slate-100'
                                  : 'bg-teal-700 hover:bg-teal-800 text-white shadow-2xs'
                              }`}
                              title={isAnswered ? 'Reopen' : 'Mark as Sent in Outlook'}
                            >
                              <Check size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile & Tablet Card Grid (Zero Horizontal Scrolling) */}
            <div className={`${viewMode === 'table' ? 'hidden' : 'block lg:hidden'} p-4 divide-y divide-slate-100 space-y-4`}>
              {filteredApprovals.map((record) => {
                const isAnswered = record.status === 'answered';
                const resolvedContractor = resolveApprovalContractorAndOfficer(record, companyConfigs);
                const allMatched = record.matchedProcedures?.every((m) => m.status === 'matched');

                return (
                  <div key={record.id} className="pt-4 first:pt-0 space-y-3">
                    {/* Header: Patient, Bed, Timestamp */}
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-extrabold text-sm text-slate-900" dir="auto">
                          {record.patientName}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                          <span>MRN: <strong className="text-slate-700">{record.mrn}</strong></span>
                          {record.bed && <span>• Bed: {record.bed}</span>}
                        </div>
                      </div>
                      <span className="text-[11px] font-semibold text-slate-400 shrink-0">
                        {formatTimestamp(record.receivedAt)}
                      </span>
                    </div>

                    {/* Status & Contractor Badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      {isAnswered ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
                          <Check size={12} className="text-emerald-600" />
                          Answered (Sent)
                        </span>
                      ) : record.isRefused || record.status === 'refused' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-800 border border-rose-300">
                          <AlertCircle size={12} className="text-rose-600" />
                          ملغي / مرفوض
                        </span>
                      ) : record.hasExistingApproval || record.status === 'approved' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
                          <CheckCircle2 size={12} className="text-emerald-600" />
                          معتمد بالكامل {record.approvedAmountLimit ? `(${record.approvedAmountLimit.toLocaleString()} ج.م)` : ''}
                        </span>
                      ) : record.status === 'conditionally_approved' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-teal-50 text-teal-900 border border-teal-300">
                          <ShieldCheck size={12} className="text-teal-700" />
                          موافقة مشروطة
                        </span>
                      ) : record.status === 'pending_information' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-sky-50 text-sky-900 border border-sky-300">
                          <HelpCircle size={12} className="text-sky-700" />
                          استيفاء بيانات
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-300">
                          <Clock size={12} className="text-amber-600" />
                          Pending Approval
                        </span>
                      )}

                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-800 border border-slate-200">
                        <Building size={12} className="text-slate-500" />
                        {resolvedContractor.contractor} (سيلز: {resolvedContractor.officer})
                      </span>
                    </div>

                    {/* AI Summary Banner */}
                    {record.aiThreadSummary && (
                      <div className="p-2.5 rounded-xl bg-teal-50/80 border border-teal-200 text-xs text-slate-800 flex items-start gap-2">
                        <Sparkles size={14} className="text-teal-700 shrink-0 mt-0.5" />
                        <p className="font-medium text-slate-700 leading-relaxed" dir="auto">
                          {record.aiThreadSummary}
                        </p>
                      </div>
                    )}

                    {/* Requested Services */}
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                        الخدمات المطلوبة:
                      </div>
                      {record.requestedServices?.map((srv, idx) => (
                        <div key={idx} className="flex items-center gap-1.5 text-xs text-slate-800">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                          <span>{srv.name}</span>
                        </div>
                      ))}
                      <div className="pt-1">
                        {allMatched ? (
                          <span className="text-[10px] font-bold text-emerald-700">✓ All procedures matched</span>
                        ) : (
                          <span className="text-[10px] font-bold text-amber-700">⚠️ Has unlisted item</span>
                        )}
                      </div>
                    </div>

                    {/* Mobile Action Buttons Bar */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => handleMarkApproved(record)}
                        disabled={updatingStatusId === record.id || record.status === 'approved'}
                        className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          record.status === 'approved'
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 opacity-80'
                            : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs'
                        }`}
                      >
                        <CheckCircle2 size={14} />
                        <span>{record.status === 'approved' ? 'معتمد' : 'اعتماد'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCancelApproval(record)}
                        disabled={updatingStatusId === record.id || record.status === 'refused' || record.isRefused}
                        className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          record.status === 'refused' || record.isRefused
                            ? 'bg-rose-100 text-rose-800 border border-rose-300 opacity-80'
                            : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200'
                        }`}
                      >
                        <XCircle size={14} />
                        <span>{record.status === 'refused' || record.isRefused ? 'ملغي' : 'إلغاء'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopyWhatsapp(record)}
                        className={`py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          copiedWhatsappId === record.id
                            ? 'bg-emerald-700 text-white'
                            : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200'
                        }`}
                        title="Copy CM WhatsApp"
                      >
                        {copiedWhatsappId === record.id ? <Check size={14} /> : <MessageCircle size={14} />}
                        <span>WhatsApp</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const resolved = resolveApprovalContractorAndOfficer(record, companyConfigs);
                          setViewingApproval({
                            ...record,
                            contractorNormalized: resolved.contractor,
                            contractorOfficer: resolved.officer,
                            priceListYear: resolved.priceListYear || record.priceListYear,
                          });
                        }}
                        className="py-2 px-3 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                      >
                        <Eye size={14} />
                        <span>View</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleToggleStatus(record)}
                        disabled={togglingId === record.id}
                        className={`py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                          isAnswered
                            ? 'border border-slate-200 text-slate-500 hover:bg-slate-100'
                            : 'bg-teal-700 hover:bg-teal-800 text-white shadow-2xs'
                        }`}
                      >
                        <Check size={14} />
                        <span>{isAnswered ? 'Reopen' : 'Sent'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Draft Preview Modal */}
      <ViewDraftModal
        isOpen={Boolean(viewingApproval)}
        approval={viewingApproval}
        onClose={() => setViewingApproval(null)}
      />
    </div>
  );
};
