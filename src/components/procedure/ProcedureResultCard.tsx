import React from 'react';
import { motion } from 'motion/react';
import { FileText, Tag } from 'lucide-react';
import { ProcedureResult, CompanyInfo } from '../../types';
import { calculateDiscountedPrice, formatCurrencyAmount } from '../../lib/pricing-calculator';

interface ProcedureResultCardProps {
  result: ProcedureResult;
  selectedCompany: CompanyInfo | null;
  index: number;
}

export const ProcedureResultCard: React.FC<ProcedureResultCardProps> = ({
  result,
  selectedCompany,
  index,
}) => {
  const calculated = selectedCompany
    ? calculateDiscountedPrice(result.price, selectedCompany.discount)
    : null;

  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className="bg-white border border-slate-200/90 rounded-2xl overflow-hidden shadow-xs hover:shadow-md transition-shadow text-left"
    >
      {/* Card Header Strip */}
      <div className="bg-slate-50 border-b border-slate-200/80 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-700">
          <FileText size={14} className="text-teal-700" />
          <span className="text-xs font-bold font-mono text-slate-800">
            {result.sourceFile}
          </span>
        </div>
        <div className="bg-white border border-slate-200 px-2.5 py-1 rounded-lg">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
            {result.sectionName || 'General'}
          </span>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-6 grid gap-6 lg:grid-cols-5 items-center">
        <div className="lg:col-span-3 space-y-4">
          <div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
              English Nomenclature
            </span>
            <h4 className="text-lg font-bold text-slate-900 leading-snug">
              {result.nameEnglish}
            </h4>
          </div>

          <div className="text-right pt-2 border-t border-slate-100">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
              الإسم باللغة العربية
            </span>
            <p className="text-xl font-bold text-slate-900 leading-snug" dir="rtl">
              {result.nameArabic || '—'}
            </p>
          </div>
        </div>

        {/* Pricing Column */}
        <div className="lg:col-span-2">
          <div className="bg-slate-50 border border-slate-200/90 rounded-2xl p-5 flex flex-col gap-3 text-center">
            <div>
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-0.5">
                Original Price
              </span>
              <div
                className={`font-mono font-bold tracking-tight ${
                  selectedCompany
                    ? 'text-lg text-slate-400 line-through'
                    : 'text-3xl text-teal-800'
                }`}
              >
                {result.price} <span className="text-xs font-sans text-slate-500">ج.م</span>
              </div>
            </div>

            {selectedCompany && calculated && (
              <div className="pt-3 border-t border-slate-200/70 flex flex-col items-center">
                <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-100/80 border border-emerald-200 text-emerald-900 rounded-md text-[10px] font-extrabold uppercase tracking-wider mb-1.5">
                  <Tag size={10} />
                  <span>Contract Rate ({selectedCompany.discount}% OFF)</span>
                </div>
                <div className="flex items-baseline gap-1.5 font-mono text-emerald-700">
                  <span className="text-3xl font-black">
                    {formatCurrencyAmount(calculated.discounted)}
                  </span>
                  <span className="text-xs font-bold text-emerald-800">
                    {calculated.currency}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.article>
  );
};
