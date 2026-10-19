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
  Send,
  Calendar,
} from 'lucide-react';
import { InpatientApprovalRecord } from '../../types';
import { toggleApprovalStatus, triggerManualDraft } from '../../services/approvalsFirebaseService';
import { ViewDraftModal } from './ViewDraftModal';

interface ApprovalsTableProps {
  approvals: InpatientApprovalRecord[];
  loading: boolean;
  selectedDateFilter: string;
  onDateFilterChange: (filter: string) => void;
}

export const ApprovalsTable: React.FC<ApprovalsTableProps> = ({
  approvals,
  loading,
  selectedDateFilter,
  onDateFilterChange,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending_approval' | 'approved_reply' | 'answered' | 'draft_created'>('all');
  const [viewingApproval, setViewingApproval] = useState<InpatientApprovalRecord | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [draftingManualId, setDraftingManualId] = useState<string | null>(null);

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
      await triggerManualDraft(record.id);
    } catch (err) {
      console.error('Failed to trigger manual draft:', err);
    } finally {
      setDraftingManualId(null);
    }
  };

  // Generate 30 rolling calendar days with request counts for day-by-day navigation
  const dayOptions = useMemo(() => {
    const result = [];
    const now = new Date();
    const countMap = new Map<string, number>();

    for (const a of approvals) {
      if (!a.receivedAt) continue;
      const d =
        typeof a.receivedAt.toDate === 'function' ? a.receivedAt.toDate() : new Date(a.receivedAt);
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
      const match =
        a.patientName?.toLowerCase().includes(term) ||
        a.mrn?.includes(term) ||
        a.contractorNormalized?.toLowerCase().includes(term) ||
        a.contractorRaw?.toLowerCase().includes(term) ||
        a.contractorOfficer?.toLowerCase().includes(term) ||
        a.requestedServices?.some((s) => s.name.toLowerCase().includes(term));
      if (!match) return false;
    }

    // 2. Status filter
    if (statusFilter === 'pending_approval') {
      // Pending approval: no approval reply found and not marked answered
      if (a.hasExistingApproval || a.status === 'answered') return false;
    } else if (statusFilter === 'approved_reply') {
      // Approved reply found (contains "لا مانع", "approve", "approved", "موافقة سعرية")
      if (!a.hasExistingApproval) return false;
    } else if (statusFilter === 'answered') {
      if (a.status !== 'answered') return false;
    } else if (statusFilter === 'draft_created') {
      if (a.status !== 'draft_created') return false;
    }

    // 3. Date filter (strictly within 30-day rolling history)
    if (a.receivedAt) {
      const date =
        typeof a.receivedAt.toDate === 'function'
          ? a.receivedAt.toDate()
          : new Date(a.receivedAt);
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
  });

  const formatTimestamp = (ts: any) => {
    if (!ts) return 'Just now';
    try {
      const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
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
            <option value="all">All Statuses</option>
            <option value="pending_approval">⏳ Pending Approval</option>
            <option value="approved_reply">✅ Approved Replies (لا مانع / Approved)</option>
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
          <span className="text-[11px] text-slate-400">
            Source: Outlook / InApprovals Folder
          </span>
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
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-bold text-slate-400 uppercase tracking-wider bg-slate-50/30">
                  <th className="py-3 px-5">Patient & MRN</th>
                  <th className="py-3 px-4">Contractor & Officer</th>
                  <th className="py-3 px-4">Requested Services</th>
                  <th className="py-3 px-3 text-center">Status</th>
                  <th className="py-3 px-3 text-right">Time</th>
                  <th className="py-3 px-5 text-right">Actions</th>
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
                      <td className="py-3 px-5">
                        <div className="font-extrabold text-slate-900" dir="auto">
                          {record.patientName}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
                          <span>MRN: <strong className="text-slate-600">{record.mrn}</strong></span>
                          {record.bed && <span>• Bed: {record.bed}</span>}
                        </div>

                        {/* Existing Approval Reply Alert Banner */}
                        {record.hasExistingApproval && record.existingApprovalSnippet && (
                          <div className="mt-2 p-2.5 rounded-xl bg-emerald-50/90 border border-emerald-300 text-xs text-emerald-950 flex items-start gap-2 shadow-2xs">
                            <CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <span className="font-bold text-emerald-800">رد الموافقة المستلم:</span>{' '}
                              <span className="font-semibold text-emerald-950" dir="auto">"{record.existingApprovalSnippet}"</span>
                            </div>
                          </div>
                        )}

                        {/* Has Discussion Replies (Non-approval) Alert Banner */}
                        {record.hasReplies && !record.hasExistingApproval && record.replySnippet && (
                          <div className="mt-2 p-2.5 rounded-xl bg-amber-50/90 border border-amber-300 text-xs text-amber-950 flex items-start gap-2 shadow-2xs">
                            <MessageSquare size={15} className="text-amber-600 shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <span className="font-bold text-amber-800">يوجد ردود سابقة في المحادثة:</span>{' '}
                              <span className="italic font-medium text-amber-950" dir="auto">"{record.replySnippet}"</span>
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Contractor & Officer */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 font-bold text-slate-800" dir="auto">
                          <Building size={12} className="text-slate-400 shrink-0" />
                          <span>{record.contractorNormalized || record.contractorRaw}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-slate-500 mt-0.5">
                          <User size={11} className="text-slate-400 shrink-0" />
                          <span>سيلز: <strong className="text-slate-700">{record.contractorOfficer || 'غير محدد'}</strong></span>
                          <span className="text-[10px] text-teal-700 bg-teal-50 px-1 rounded ml-1 font-semibold">
                            {record.priceListYear || '2025'}
                          </span>
                        </div>
                      </td>

                      {/* Requested Services */}
                      <td className="py-3 px-4 max-w-xs">
                        <div className="space-y-1">
                          {record.requestedServices?.map((srv, idx) => (
                            <div key={idx} className="flex items-center gap-1.5 text-[11px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />
                              <span className="text-slate-800 truncate font-medium">{srv.name}</span>
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
                      </td>

                      {/* Status Badge */}
                      <td className="py-3 px-3 text-center whitespace-nowrap">
                        {isAnswered ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
                            <Check size={12} className="text-emerald-600" />
                            Answered (Sent)
                          </span>
                        ) : record.hasExistingApproval ? (
                          /* Approval words found on reply: show the reply (under patient) and do NOT show pending! */
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 shadow-2xs">
                            <CheckCircle2 size={12} className="text-emerald-600" />
                            Approved Reply
                          </span>
                        ) : (
                          /* No replies or non-approval reply: show Pending Approval */
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-300 shadow-2xs">
                            <Clock size={12} className="text-amber-600" />
                            Pending Approval
                          </span>
                        )}
                      </td>

                      {/* Time */}
                      <td className="py-3 px-3 text-right text-[11px] font-semibold text-slate-500 whitespace-nowrap">
                        {formatTimestamp(record.receivedAt)}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Manual Draft Button (shown when reply or approval detected) */}
                          {record.status === 'pending_manual_draft' && (
                            <button
                              onClick={() => handleManualDraft(record)}
                              disabled={draftingManualId === record.id}
                              className="px-2.5 py-1.5 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-bold flex items-center gap-1 shadow-xs transition-all cursor-pointer active:scale-95"
                              title="Draft Reply to Outlook"
                            >
                              <Send size={12} />
                              <span>{draftingManualId === record.id ? 'Drafting...' : 'Draft to Outlook'}</span>
                            </button>
                          )}

                          {/* View Draft Modal Button */}
                          <button
                            onClick={() => setViewingApproval(record)}
                            className="px-2.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-bold flex items-center gap-1 transition-all cursor-pointer"
                            title="Preview AI Drafted Reply"
                          >
                            <Eye size={13} />
                            <span className="hidden sm:inline">View Draft</span>
                          </button>

                          {/* Toggle Answered Button */}
                          <button
                            onClick={() => handleToggleStatus(record)}
                            disabled={isToggling}
                            className={`px-2.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition-all cursor-pointer ${
                              isAnswered
                                ? 'border border-slate-200 text-slate-600 hover:bg-slate-100'
                                : 'bg-teal-700 hover:bg-teal-800 text-white shadow-xs'
                            }`}
                            title={isAnswered ? 'Mark as Pending' : 'Mark as Sent in Outlook'}
                          >
                            {isAnswered ? (
                              <span>Reopen</span>
                            ) : (
                              <>
                                <Check size={13} />
                                <span>Mark Sent</span>
                              </>
                            )}
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

      {/* Draft Preview Modal */}
      <ViewDraftModal
        isOpen={Boolean(viewingApproval)}
        approval={viewingApproval}
        onClose={() => setViewingApproval(null)}
      />
    </div>
  );
};
