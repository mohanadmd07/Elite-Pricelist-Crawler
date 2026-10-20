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
import { generateCmWhatsappMessageAsync } from '../../lib/whatsapp-generator';
import { triggerManualDraft } from '../../services/approvalsFirebaseService';

interface ViewDraftModalProps {
  approval: InpatientApprovalRecord | null;
  isOpen: boolean;
  onClose: () => void;
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

  if (!isOpen || !approval) return null;

  const handleCopyDraft = async () => {
    try {
      await navigator.clipboard.writeText(approval.draftBody);
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 2000);
    } catch (err) {
      console.error('Failed to copy draft:', err);
    }
  };

  const handleCopyWhatsapp = async () => {
    try {
      const msg = approval.cmWhatsappMessage || (await generateCmWhatsappMessageAsync(approval));
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
      await triggerManualDraft(approval.id);
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
                  <p className="text-xs text-slate-600 mt-2 pt-2 border-t border-teal-200/50" dir="auto">
                    <strong>سبب الحالة:</strong> {approval.statusReasonArabic}
                  </p>
                )}
              </div>

              {/* Conditions & Requirements */}
              {approval.coverageConditions && (
                <div className="p-3.5 rounded-xl bg-amber-50/90 border border-amber-300 text-xs text-amber-950 flex items-start gap-2.5">
                  <AlertCircle size={16} className="text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-bold text-amber-900">شروط ومتطلبات جهة التعاقد:</h5>
                    <p className="mt-0.5 font-medium leading-relaxed" dir="auto">{approval.coverageConditions}</p>
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
              <div className="relative">
                <pre
                  dir="rtl"
                  className="w-full p-4 rounded-xl bg-slate-900 text-slate-100 font-sans text-xs leading-relaxed whitespace-pre-wrap selection:bg-teal-700 border border-slate-800 shadow-inner max-h-96 overflow-y-auto"
                >
                  {approval.draftBody}
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
                {approval.cmWhatsappMessage || 'رسالة الواتساب قيد التوليد...'}
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
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-100 bg-slate-50/70">
          <p className="text-[11px] text-slate-500">
            Elite Inpatient Approvals Engine &bull; Automated Real-time Sync
          </p>
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