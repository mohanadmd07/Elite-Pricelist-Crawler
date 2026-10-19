import React, { useState } from 'react';
import { X, Copy, Check, FileText, User, Building, AlertCircle } from 'lucide-react';
import { InpatientApprovalRecord } from '../../types';

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
  const [copied, setCopied] = useState(false);

  if (!isOpen || !approval) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(approval.draftBody);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy draft:', err);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] text-left"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-200/60 text-teal-800 flex items-center justify-center">
              <FileText size={16} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 font-display">
                Outlook AI Draft Preview
              </h3>
              <p className="text-xs text-slate-500 font-medium">
                {approval.patientName} (MRN: {approval.mrn})
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

        {/* Metadata Strip */}
        <div className="px-6 py-3 bg-slate-50/50 border-b border-slate-100 flex flex-wrap items-center gap-4 text-xs text-slate-600">
          <div className="flex items-center gap-1.5">
            <Building size={14} className="text-slate-400" />
            <span className="font-semibold text-slate-800">{approval.contractorNormalized || approval.contractorRaw}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Pricelist:</span>
            <span className="px-2 py-0.5 rounded-md bg-teal-50 text-teal-800 font-bold border border-teal-200/50">
              {approval.priceListYear || '2025'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <User size={14} className="text-slate-400" />
            <span>Officer:</span>
            <span className="font-semibold text-slate-900">{approval.contractorOfficer || 'غير محدد'}</span>
          </div>
        </div>

        {/* Draft Text Preview Box */}
        <div className="p-6 overflow-y-auto space-y-4">
          <div className="relative">
            <pre
              dir="rtl"
              className="w-full p-4 rounded-xl bg-slate-900 text-slate-100 font-sans text-sm leading-relaxed whitespace-pre-wrap selection:bg-teal-700 border border-slate-800 shadow-inner"
            >
              {approval.draftBody}
            </pre>
          </div>

          {/* Requested Services vs Matches summary */}
          <div className="mt-4 border border-slate-200 rounded-xl p-4 bg-slate-50/60">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2.5">
              Service Matching Verification
            </h4>
            <div className="space-y-1.5">
              {approval.matchedProcedures?.map((p, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between text-xs py-1 px-2.5 rounded-lg bg-white border border-slate-100"
                >
                  <span className="font-medium text-slate-800">{p.serviceName}</span>
                  <div className="flex items-center gap-2">
                    {p.status === 'matched' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200/60">
                        <Check size={11} /> Matched: {p.matchedName}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200/60">
                        <AlertCircle size={11} /> Unmatched
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-100 bg-slate-50/50">
          <p className="text-[11px] text-slate-500">
            This reply is drafted in Outlook for this conversation thread.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-4 py-2 bg-teal-700 hover:bg-teal-800 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all cursor-pointer active:scale-98"
            >
              {copied ? (
                <>
                  <Check size={14} />
                  <span>Copied to Clipboard!</span>
                </>
              ) : (
                <>
                  <Copy size={14} />
                  <span>Copy Draft</span>
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-xl text-xs font-bold transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
