import React, { useState } from 'react';
import {
  X,
  Copy,
  Check,
  FileText,
  User,
  Building,
  AlertCircle,
  MessageCircle,
  Sparkles,
  DollarSign,
  Clock,
  ShieldCheck,
  CheckCircle2,
  Send,
  HelpCircle,
  XCircle,
} from 'lucide-react';
import { InpatientApprovalRecord, ApprovalGranularStatus } from '../../types';
import { generateCmWhatsappMessage, generateCmWhatsappMessageAsync } from '../../lib/whatsapp-generator';
import { buildDraftReplyFromRecord } from '../../lib/draftReplyBuilder';
import { triggerManualDraft, updateApprovalStatus } from '../../services/approvalsFirebaseService';

interface ViewDraftModalProps {
  approval: InpatientApprovalRecord | null;
  isOpen: boolean;
  onClose: () => void;
}

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

export const ViewDraftModal: React.FC<ViewDraftModalProps> = ({
  approval,
  isOpen,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'context' | 'financial' | 'draft' | 'whatsapp'>('context');
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [copiedWhatsapp, setCopiedWhatsapp] = useState(false);
  const [isDraftingToOutlook, setIsDraftingToOutlook] = useState(false);
  const [draftedSuccess, setDraftedSuccess] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [statusSuccessMsg, setStatusSuccessMsg] = useState<string | null>(null);

  if (!isOpen || !approval) return null;

  // Dynamically compute fresh draft reflecting current contractor, officer, and year
  const rawOfficer = approval.contractorOfficer;
  const rawYear = approval.priceListYear;
  let effectiveDraft =
    (approval.draftBody && approval.draftBody !== 'undefined' ? approval.draftBody : null) ||
    (approval.suggestedDraftReply && approval.suggestedDraftReply !== 'undefined' ? approval.suggestedDraftReply : null);

  const isStaleDraft =
    !effectiveDraft ||
    (rawOfficer && rawOfficer !== 'غير محدد' && !rawOfficer.includes('يتطلب تحديد') && !effectiveDraft.includes(rawOfficer.trim())) ||
    (rawYear && !effectiveDraft.includes(rawYear));

  if (isStaleDraft) {
    effectiveDraft = buildDraftReplyFromRecord(approval);
  }

  const effectiveWhatsapp =
    (approval.cmWhatsappMessage &&
     approval.cmWhatsappMessage !== 'undefined' &&
     approval.cmWhatsappMessage !== 'رسالة الواتساب قيد التوليد...'
      ? approval.cmWhatsappMessage
      : null) || generateCmWhatsappMessage(approval);

  const handleUpdateStatus = async (newStatus: InpatientApprovalRecord['status'], reason: string) => {
    try {
      setIsUpdatingStatus(true);
      await updateApprovalStatus(approval.id, newStatus, reason);
      approval.status = newStatus;
      if (newStatus === 'approved') {
        approval.hasExistingApproval = true;
        approval.isRefused = false;
        setStatusSuccessMsg('تم اعتماد الموافقة بنجاح!');
      } else if (newStatus === 'refused') {
        approval.isRefused = true;
        approval.hasExistingApproval = false;
        setStatusSuccessMsg('تم إلغاء طلب الموافقة بنجاح!');
      }
      setTimeout(() => setStatusSuccessMsg(null), 3000);
    } catch (err) {
      console.error('Failed to update status:', err);
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const handleCopyDraft = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(effectiveDraft);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = effectiveDraft;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 2000);
    } catch (err) {
      console.error('Failed to copy draft:', err);
    }
  };

  const handleCopyWhatsapp = async () => {
    try {
      const msg = effectiveWhatsapp;
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
      setCopiedWhatsapp(true);
      setTimeout(() => setCopiedWhatsapp(false), 2000);
    } catch (err) {
      console.error('Failed to copy CM WhatsApp message:', err);
    }
  };

  const handleDraftToOutlook = async () => {
    try {
      setIsDraftingToOutlook(true);
      await triggerManualDraft(approval.id, {
        draftText: effectiveDraft,
        contractorOfficer: approval.contractorOfficer,
        priceListYear: approval.priceListYear,
      });
      setDraftedSuccess(true);
      setTimeout(() => setDraftedSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to draft in Outlook:', err);
    } finally {
      setIsDraftingToOutlook(false);
    }
  };

  const renderStatusBadge = (status: ApprovalGranularStatus) => {
    switch (status) {
      case 'approved':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-900 border border-emerald-300">
            <CheckCircle2 size={13} className="text-emerald-700" />
            معتمد بالكامل (Approved)
          </span>
        );
      case 'conditionally_approved':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-teal-100 text-teal-900 border border-teal-300">
            <ShieldCheck size={13} className="text-teal-700" />
            موافقة مشروطة (Conditional)
          </span>
        );
      case 'partially_approved':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-indigo-100 text-indigo-900 border border-indigo-300">
            <ShieldCheck size={13} className="text-indigo-700" />
            موافقة جزئية (Partial)
          </span>
        );
      case 'pending_information':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-sky-100 text-sky-900 border border-sky-300">
            <HelpCircle size={13} className="text-sky-700" />
            مطلوب استيفاء بيانات (Info Needed)
          </span>
        );
      case 'refused':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-900 border border-rose-300">
            <XCircle size={13} className="text-rose-700" />
            غير مغطى / مرفوض (Refused)
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
            <Clock size={13} className="text-amber-700" />
            قيد المتابعة / بانتظار الرد
          </span>
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[92vh] text-left"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-200/80 text-teal-800 flex items-center justify-center shadow-2xs">
              <Sparkles size={20} className="text-teal-700" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-extrabold text-slate-900 font-display" dir="auto">
                  {approval.patientName}
                </h3>
                {renderStatusBadge(approval.status)}
              </div>
              <p className="text-xs text-slate-500 font-medium mt-0.5">
                MRN: <strong className="text-slate-700">{approval.mrn}</strong>
                {approval.bed && <span> • Bed: {approval.bed}</span>}
                {approval.admissionType && <span> • {approval.admissionType}</span>}
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

        {/* Contractor & Meta Strip */}
        <div className="px-6 py-2.5 bg-slate-50/50 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 font-bold text-slate-800" dir="auto">
              <Building size={14} className="text-slate-400" />
              <span>{approval.contractorNormalized || approval.contractorRaw}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-400">لائحة:</span>
              <span className="px-2 py-0.5 rounded-md bg-teal-50 text-teal-800 font-bold border border-teal-200/50">
                {approval.priceListYear === 'Cash' ? '2026' : (approval.priceListYear || '2026')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <User size={13} className="text-slate-400" />
              <span className="text-slate-500">سيلز:</span>
              <span className="font-semibold text-slate-900">{approval.contractorOfficer || 'غير محدد'}</span>
            </div>
          </div>
          {approval.aiProcessingStatus && (
            <span className="text-[10px] text-teal-700 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded-full font-semibold">
              AI Contextual Engine Active
            </span>
          )}
        </div>

        {/* 4 Navigation Tabs */}
        <div className="flex items-center border-b border-slate-200 bg-white px-6">
          <button
            onClick={() => setActiveTab('context')}
            className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === 'context'
                ? 'border-teal-700 text-teal-800 bg-teal-50/40'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Sparkles size={14} className={activeTab === 'context' ? 'text-teal-700' : 'text-slate-400'} />
            <span>السياق والملخص الذكي</span>
          </button>

          <button
            onClick={() => setActiveTab('financial')}
            className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === 'financial'
                ? 'border-teal-700 text-teal-800 bg-teal-50/40'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <DollarSign size={14} className={activeTab === 'financial' ? 'text-teal-700' : 'text-slate-400'} />
            <span>الشروط والتغطية المالية</span>
            {((approval.patientSharePercentage !== null && approval.patientSharePercentage !== undefined) || approval.approvedAmountLimit) && (
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
            )}
          </button>

          <button
            onClick={() => setActiveTab('draft')}
            className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === 'draft'
                ? 'border-teal-700 text-teal-800 bg-teal-50/40'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <FileText size={14} className={activeTab === 'draft' ? 'text-teal-700' : 'text-slate-400'} />
            <span>مسودة رد الإيميل</span>
          </button>

          <button
            onClick={() => setActiveTab('whatsapp')}
            className={`py-3 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === 'whatsapp'
                ? 'border-teal-700 text-teal-800 bg-teal-50/40'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <MessageCircle size={14} className={activeTab === 'whatsapp' ? 'text-teal-700' : 'text-slate-400'} />
            <span>واتساب كيس مانجر (CM)</span>
          </button>
        </div>

        {/* Tab Content Panes */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {/* TAB 1: AI CONTEXT & TIMELINE */}
          {activeTab === 'context' && (
            <div className="space-y-4">
              {/* Executive Summary Card */}
              <div className="p-4 rounded-xl bg-gradient-to-br from-teal-50/70 to-emerald-50/50 border border-teal-200/80 shadow-2xs">
                <div className="flex items-center gap-2 text-teal-900 font-bold text-xs uppercase tracking-wider mb-2">
                  <Sparkles size={15} className="text-teal-700" />
                  <span>الملخص التنفيذي للمحادثة (Executive Summary)</span>
                </div>
                <p className="text-sm text-slate-800 font-medium leading-relaxed" dir="auto">
                  {approval.aiThreadSummary || 'طلب وارد من السيستم بانتظار استلام الرد أو استكمال الإجراءات.'}
                </p>
                {approval.statusReasonArabic && (
                  <p className="text-xs text-slate-600 mt-2 pt-2 border-t border-teal-200/50 break-words" dir="auto">
                    <strong>سبب الحالة:</strong> {cleanDisplayText(approval.statusReasonArabic)}
                  </p>
                )}
              </div>

              {/* Conditions & Requirements */}
              {approval.coverageConditions && (
                <div className="p-3.5 rounded-xl bg-amber-50/90 border border-amber-300 text-xs text-amber-950 flex items-start gap-2.5">
                  <AlertCircle size={16} className="text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-bold text-amber-900">شروط ومتطلبات جهة التعاقد:</h5>
                    <p className="mt-0.5 font-medium leading-relaxed break-words" dir="auto">{cleanDisplayText(approval.coverageConditions)}</p>
                  </div>
                </div>
              )}

              {/* Clinical Procedures & Matches */}
              <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/40">
                <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2.5">
                  الخدمات المطلوبة ومطابقتها بلائحة الأسعار
                </h4>
                <div className="space-y-2">
                  {approval.matchedProcedures?.map((p, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between text-xs py-2 px-3 rounded-lg bg-white border border-slate-200/80"
                    >
                      <span className="font-bold text-slate-800" dir="auto">{p.serviceName}</span>
                      <div className="flex items-center gap-2">
                        {p.status === 'matched' ? (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                            <Check size={12} /> مطابق: {p.matchedName}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200">
                            <AlertCircle size={12} /> غير متواجد بلائحة الأسعار
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Per-Item Classifier Decision Ledger */}
              {approval.itemsJson && approval.itemsJson.length > 0 && (
                <div className="border border-teal-200 rounded-xl p-4 bg-teal-50/30 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold text-teal-900 uppercase tracking-wider">
                      سجل قرارات البنود الطبية (7-Pass Classifier Ledger)
                    </h4>
                    {approval.classifierStatus && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-teal-100 text-teal-900 border border-teal-300">
                        Verdict: {approval.classifierStatus}
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {approval.itemsJson.map((item: any, idx: number) => (
                      <div key={idx} className="p-2.5 rounded-lg bg-white border border-slate-200 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-slate-900" dir="auto">
                            {item.item_name_raw} {item.canonical_name_en ? `(${item.canonical_name_en})` : ''}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                              item.decision === 'APPROVED'
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                                : item.decision === 'REJECTED'
                                ? 'bg-rose-50 text-rose-800 border-rose-300'
                                : 'bg-amber-50 text-amber-900 border-amber-300'
                            }`}
                          >
                            {item.decision} (Qty: {item.approved_quantity ?? item.requested_quantity ?? 1})
                          </span>
                        </div>
                        {item.conditions && item.conditions.length > 0 && (
                          <p className="text-[11px] text-amber-900 font-medium" dir="auto">
                            ⚠️ الشروط / المطلوب: {item.conditions.join(' • ')}
                          </p>
                        )}
                        {(item.rejection_reason_ar || item.rejection_reason_en) && (
                          <p className="text-[11px] text-rose-800 font-semibold" dir="auto">
                            ❌ سبب الرفض: {item.rejection_reason_ar || item.rejection_reason_en}
                          </p>
                        )}
                        {item.evidence_quote && (
                          <p className="text-[11px] text-slate-500 italic break-words" dir="auto">
                            "{cleanDisplayText(item.evidence_quote)}"
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Advisory Historical Patterns */}
              {approval.historyHintsJson && approval.historyHintsJson.length > 0 && (
                <div className="border border-indigo-200 rounded-xl p-3.5 bg-indigo-50/40 space-y-1.5">
                  <div className="text-[11px] font-extrabold text-indigo-900 uppercase tracking-wider">
                    📊 Historical pattern (advisory, not a decision)
                  </div>
                  {approval.historyHintsJson.map((hint: any, hIdx: number) => (
                    <div key={hIdx} className="text-xs text-indigo-950 bg-white/80 p-2 rounded-lg border border-indigo-100">
                      <span className="font-bold">{hint.canonical_procedure}:</span>{' '}
                      {hint.insufficient_history ? (
                        <span className="text-slate-500">Insufficient history (n={hint.sample_size})</span>
                      ) : (
                        <span>
                          Sample n={hint.sample_size} (Approved: {hint.approved_count}, Conditional: {hint.conditional_count}, Rejected: {hint.rejected_count})
                        </span>
                      )}
                      {hint.anomaly_flags && hint.anomaly_flags.length > 0 && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 text-[10px] font-bold">
                          Anomaly: {hint.anomaly_flags.join(', ')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: FINANCIAL & TERMS */}
          {activeTab === 'financial' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Co-pay Percentage */}
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    نسبة تحمل المريض (Co-Payment)
                  </span>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-extrabold text-blue-900">
                      {approval.patientSharePercentage !== null && approval.patientSharePercentage !== undefined
                        ? `${approval.patientSharePercentage}%`
                        : 'غير محدد'}
                    </span>
                    {approval.patientSharePercentage !== null && (
                      <span className="text-xs font-medium text-slate-500">من إجمالي الفاتورة المعتمدة</span>
                    )}
                  </div>
                </div>

                {/* Approved Monetary Cap */}
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    السقف المالي المعتمد (Financial Cap)
                  </span>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-extrabold text-emerald-900">
                      {approval.approvedAmountLimit
                        ? `${approval.approvedAmountLimit.toLocaleString()} ج.م`
                        : 'غير مقيد بمبلغ محدد'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Two-Tier Pricing Breakdown (Contract vs 2026 Price Approval) */}
              {approval.pricedItemsJson && approval.pricedItemsJson.length > 0 && (
                <div className="p-4 rounded-xl border border-slate-200 bg-white space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h5 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                      التسعير ثنائي المستوى (Two-Tier Pricing: Contract vs موافقة سعرية)
                    </h5>
                    <div className="flex items-center gap-2 text-xs font-bold">
                      {approval.contractTotal !== undefined && (
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-900 border border-emerald-200">
                          إجمالي التعاقد: {approval.contractTotal.toLocaleString()} ج.م
                        </span>
                      )}
                      {approval.priceApprovalTotal !== undefined && approval.priceApprovalTotal > 0 && (
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-950 border border-amber-300">
                          إجمالي موافقة سعرية (2026): {approval.priceApprovalTotal.toLocaleString()} ج.م
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {approval.pricedItemsJson.map((pi: any, pIdx: number) => (
                      <div key={pIdx} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div>
                          <div className="font-bold text-slate-900" dir="auto">{pi.item_name_raw}</div>
                          <div className="text-[11px] text-slate-500">
                            Matched: {pi.matched_name || '—'} • Qty: {pi.quantity} × {pi.unit_price?.toLocaleString() ?? '—'} EGP
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {pi.price_source === 'CONTRACT' ? (
                            <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-900 border border-emerald-200 font-bold text-[11px]">
                              CONTRACT: {pi.line_total?.toLocaleString()} EGP
                            </span>
                          ) : pi.price_source === 'LIST_2026_PRICE_APPROVAL' ? (
                            <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-950 border border-amber-300 font-extrabold text-[11px]">
                              🏷️ موافقة سعرية (2026 Gross): {pi.line_total?.toLocaleString()} EGP
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 rounded-full bg-rose-50 text-rose-900 border border-rose-200 font-bold text-[11px]">
                              {pi.price_source}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Conditions / Prerequisites */}
              <div className="p-4 rounded-xl border border-slate-200 bg-white">
                <h5 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                  شروط التغطية والمستثنيات
                </h5>
                <p className="text-xs text-slate-700 leading-relaxed font-medium" dir="auto">
                  {approval.coverageConditions || 'لا توجد شروط خاصة إضافية مسجلة من شركة التأمين.'}
                </p>
              </div>

              {/* Clinical Diagnosis Reference */}
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/40 text-xs">
                <span className="font-bold text-slate-600 block mb-1">التشخيص الطبي المدون:</span>
                <p className="text-slate-800 font-medium" dir="auto">{approval.diagnosis}</p>
              </div>
            </div>
          )}

          {/* TAB 3: SMART EMAIL DRAFT */}
          {activeTab === 'draft' && (
            <div className="space-y-4">
              {approval.priceApprovalDraftEn && (
                <div className="p-4 rounded-xl bg-amber-50/90 border border-amber-300 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-extrabold text-amber-950 uppercase tracking-wider">
                      🏷️ Corporate Sales Price-Approval Request (موافقة سعرية — 2026 Gross List)
                    </span>
                    <button
                      onClick={() => {
                        navigator.clipboard?.writeText(approval.priceApprovalDraftEn || '');
                      }}
                      className="px-2.5 py-1 rounded-lg bg-amber-800 hover:bg-amber-900 text-white text-[11px] font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Copy size={12} />
                      <span>Copy English Price-Approval Draft</span>
                    </button>
                  </div>
                  <pre
                    dir="ltr"
                    className="w-full p-3 rounded-lg bg-white text-slate-900 font-mono text-[11px] leading-relaxed whitespace-pre-wrap border border-amber-200 max-h-60 overflow-y-auto"
                  >
                    {approval.priceApprovalDraftEn}
                  </pre>
                </div>
              )}
              <div className="relative">
                <pre
                  dir="rtl"
                  className="w-full p-4 rounded-xl bg-slate-900 text-slate-100 font-sans text-xs leading-relaxed whitespace-pre-wrap border border-slate-800 shadow-inner max-h-96 overflow-y-auto"
                >
                  {effectiveDraft}
                </pre>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>مسودة رسمية مهيأة للرد عبر Outlook / Exchange.</span>
                <button
                  onClick={handleCopyDraft}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold flex items-center gap-1.5 transition-all cursor-pointer"
                >
                  {copiedDraft ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                  <span>{copiedDraft ? 'تم النسخ!' : 'نسخ المسودة'}</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 4: CM WHATSAPP */}
          {activeTab === 'whatsapp' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-300 text-emerald-950 font-sans text-xs leading-relaxed whitespace-pre-wrap shadow-inner" dir="rtl">
                {effectiveWhatsapp}
              </div>
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>صيغة قياسية معتمدة من 3 أسطر لمنسق الكيس مانجر.</span>
                <button
                  onClick={handleCopyWhatsapp}
                  className="px-3.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-xs"
                >
                  {copiedWhatsapp ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copiedWhatsapp ? 'تم النسخ بنجاح!' : 'نسخ رسالة الواتساب'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-6 py-3.5 border-t border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleUpdateStatus('approved', 'تمت الموافقة واعتماد الحالة يدوياً بواسطة منسق التأمين')}
              disabled={isUpdatingStatus || approval.status === 'approved'}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                approval.status === 'approved'
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 opacity-80 cursor-default'
                  : 'bg-emerald-700 hover:bg-emerald-800 text-white shadow-xs active:scale-95'
              }`}
            >
              <CheckCircle2 size={13} />
              <span>{approval.status === 'approved' ? 'الحالة معتمدة' : 'اعتماد الموافقة'}</span>
            </button>
            <button
              onClick={() => handleUpdateStatus('refused', 'تم إلغاء طلب الموافقة يدوياً')}
              disabled={isUpdatingStatus || approval.status === 'refused' || approval.isRefused}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                approval.status === 'refused' || approval.isRefused
                  ? 'bg-rose-100 text-rose-800 border border-rose-300 opacity-80 cursor-default'
                  : 'bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-300 active:scale-95'
              }`}
            >
              <XCircle size={13} />
              <span>{approval.status === 'refused' || approval.isRefused ? 'الطلب ملغي' : 'إلغاء الطلب'}</span>
            </button>
            {statusSuccessMsg && (
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                {statusSuccessMsg}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDraftToOutlook}
              disabled={isDraftingToOutlook || draftedSuccess}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                draftedSuccess
                  ? 'bg-emerald-600 text-white'
                  : 'bg-teal-700 hover:bg-teal-800 text-white shadow-xs'
              }`}
            >
              {draftedSuccess ? (
                <>
                  <Check size={13} />
                  <span>تم الإنشاء في Drafts!</span>
                </>
              ) : (
                <>
                  <Send size={13} />
                  <span>{isDraftingToOutlook ? 'جاري الإنشاء...' : 'إنشاء في Outlook Drafts'}</span>
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-all cursor-pointer"
            >
              إغلاق
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};