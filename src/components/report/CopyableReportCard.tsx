import React, { useState } from 'react';
import { Copy, Check, Mail, ClipboardList } from 'lucide-react';
import { ProcedureResult, CompanyInfo, SelectedProcedure } from '../../types';
import { cleanNamePrefix } from '../../lib/arabic-normalizer';
import { calculateDiscountedPrice, formatCurrencyAmount } from '../../lib/pricing-calculator';

interface CopyableReportCardProps {
  results: ProcedureResult[];
  selectedCompany: CompanyInfo | null;
  selectedProcedures: SelectedProcedure[];
}

export const CopyableReportCard: React.FC<CopyableReportCardProps> = ({
  results,
  selectedCompany,
  selectedProcedures,
}) => {
  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedCC, setCopiedCC] = useState(false);

  const getSummaryText = (): string => {
    const lines: string[] = [];

    const priceListName = selectedCompany?.priceListYear
      ? (selectedCompany.priceListYear === 'Cash' || selectedCompany.priceListYear === '2026'
          ? 'Elite Hospital 2026'
          : `Elite Hospital ${selectedCompany.priceListYear}`)
      : results.length > 0
      ? Array.from(new Set(results.map((r) => r.sourceFile))).join(', ')
      : 'Elite Hospital 2026';

    const contractorName = selectedCompany ? selectedCompany.name : 'N/A';
    const discountName = selectedCompany ? `${selectedCompany.discount}%` : 'N/A';

    lines.push(`Price list: ${priceListName}`);
    lines.push(`Contractor: ${contractorName}`);
    if (selectedCompany?.responsiblePerson) {
      lines.push(`المسئول من قسم السيلز: ${selectedCompany.responsiblePerson}`);
    }
    lines.push(`Contractor Discount: ${discountName}`);
    lines.push('');

    // 1. Found procedures
    const foundProcs = selectedProcedures.filter((proc) => {
      const pNorm = proc.name.toLowerCase().trim();
      return results.some((r) => {
        const rReq = (r.requestedProcedureName || '').toLowerCase().trim();
        if (rReq && rReq === pNorm) return true;
        const rEng = r.nameEnglish.toLowerCase();
        return rEng.includes(pNorm) || pNorm.includes(rEng);
      });
    });

    // 2. Unmatched procedures
    const notFoundProcs = selectedProcedures.filter((proc) => {
      const pNorm = proc.name.toLowerCase().trim();
      return !results.some((r) => {
        const rReq = (r.requestedProcedureName || '').toLowerCase().trim();
        if (rReq && rReq === pNorm) return true;
        const rEng = r.nameEnglish.toLowerCase();
        return rEng.includes(pNorm) || pNorm.includes(rEng);
      });
    });

    if (foundProcs.length > 0) {
      lines.push('الإجراءات المتواجدة بلائحة أسعار التعاقد:');
      let index = 1;

      foundProcs.forEach((proc) => {
        const pNorm = proc.name.toLowerCase().trim();
        const matches = results.filter((r) => {
          const rReq = (r.requestedProcedureName || '').toLowerCase().trim();
          if (rReq && rReq === pNorm) return true;
          const rEng = r.nameEnglish.toLowerCase();
          return rEng.includes(pNorm) || pNorm.includes(rEng);
        });

        matches.forEach((match) => {
          const cleanArabic = cleanNamePrefix(match.nameArabic);
          const cleanEnglish = cleanNamePrefix(match.nameEnglish);
          lines.push(`${index}- ${cleanArabic} (${cleanEnglish})`);

          if (selectedCompany) {
            const calculated = calculateDiscountedPrice(match.price, selectedCompany.discount);
            if (calculated) {
              const formatted = formatCurrencyAmount(calculated.discounted);
              lines.push(`   السعر بعد الخصم: ${formatted} ${calculated.currency}`);
            }
          } else {
            lines.push(`   السعر الأصلي: ${match.price} ج.م`);
          }
          lines.push('');
          index++;
        });
      });
    }

    if (notFoundProcs.length > 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('');
      }
      lines.push('الإجراءات الغير متواجدة بلائحة أسعار التعاقد:');
      notFoundProcs.forEach((proc, idx) => {
        const cleanArabic = proc.arabic ? cleanNamePrefix(proc.arabic) : '';
        const cleanEng = cleanNamePrefix(proc.name);
        const procName = cleanArabic ? `${cleanArabic} (${cleanEng})` : cleanEng;
        lines.push(`${idx + 1}- ${procName}`);
      });
    }

    return lines.join('\n').trim();
  };

  const handleCopyReport = () => {
    navigator.clipboard.writeText(getSummaryText());
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2200);
  };

  const handleCopyCC = () => {
    navigator.clipboard.writeText(
      'DirectInsurance@elitehospital.org; corporate@elitehospital.org'
    );
    setCopiedCC(true);
    setTimeout(() => setCopiedCC(false), 2200);
  };

  const summary = getSummaryText();

  return (
    <section className="bg-white border border-slate-200/90 rounded-2xl p-6 sm:p-7 shadow-xs space-y-4 text-left">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-teal-50 border border-teal-200/80 text-teal-700 flex items-center justify-center shrink-0">
            <ClipboardList size={20} />
          </div>
          <div>
            <h3 className="text-base font-bold text-slate-900 font-display">
              تقرير عرض الأسعار للمشاركة / Standardized Quotation Report
            </h3>
            <p className="text-xs text-slate-500 font-medium">
              Ready to copy and paste directly into Outlook email replies or WhatsApp patient inquiries.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          <button
            onClick={handleCopyReport}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:outline-none min-h-[44px] ${
              copiedReport
                ? 'bg-emerald-700 text-white shadow-xs'
                : 'bg-teal-700 hover:bg-teal-800 text-white shadow-xs'
            }`}
            aria-label="Copy full text quotation report to clipboard"
          >
            {copiedReport ? (
              <>
                <Check size={16} />
                <span>Report Copied!</span>
              </>
            ) : (
              <>
                <Copy size={16} />
                <span>Copy Text Report</span>
              </>
            )}
          </button>

          <button
            onClick={handleCopyCC}
            className={`px-4 py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all cursor-pointer focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none min-h-[44px] ${
              copiedCC
                ? 'bg-emerald-700 text-white'
                : 'bg-slate-900 hover:bg-slate-800 text-white'
            }`}
            title="Copy CC email addresses (DirectInsurance@elitehospital.org; corporate@elitehospital.org)"
            aria-label="Copy CC email addresses for Outlook"
          >
            {copiedCC ? (
              <>
                <Check size={16} />
                <span>CC Copied!</span>
              </>
            ) : (
              <>
                <Mail size={16} />
                <span>Copy CC Emails</span>
              </>
            )}
          </button>
        </div>
      </div>

      <div className="relative">
        <pre
          className="w-full bg-slate-50 border border-slate-200/90 p-5 rounded-xl text-sm font-bold text-slate-800 whitespace-pre-wrap text-right leading-relaxed overflow-x-auto select-all"
          dir="rtl"
          style={{ fontFamily: 'inherit' }}
        >
          {summary}
        </pre>
        <span className="absolute top-2.5 left-2.5 text-[9px] bg-slate-200/80 text-slate-700 font-bold px-2 py-0.5 rounded uppercase tracking-wider">
          RTL Arabic Quotation
        </span>
      </div>
    </section>
  );
};
