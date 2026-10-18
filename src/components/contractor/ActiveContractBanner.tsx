import React from 'react';
import { Building2, Calendar, Percent, UserCheck } from 'lucide-react';
import { CompanyInfo } from '../../types';

interface ActiveContractBannerProps {
  company: CompanyInfo;
}

export const ActiveContractBanner: React.FC<ActiveContractBannerProps> = ({ company }) => {
  return (
    <div className="p-4 bg-teal-50/70 border border-teal-200/80 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs shadow-xs">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0 shadow-xs mt-0.5 sm:mt-0">
          <Building2 size={18} />
        </div>
        <div className="text-left">
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-teal-950 text-sm">
              {company.name}
            </span>
            <span className="text-[10px] font-black uppercase tracking-wider text-teal-700 bg-white px-2 py-0.5 rounded-full border border-teal-200">
              Active Contract
            </span>
          </div>
          {company.responsiblePerson && (
            <p className="text-teal-900 font-semibold text-xs mt-1.5 flex items-center gap-1.5">
              <UserCheck size={14} className="text-teal-700" />
              <span>المسئول من قسم السيلز:</span>
              <span className="font-extrabold text-teal-950">{company.responsiblePerson}</span>
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2.5 items-center w-full sm:w-auto">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-teal-200 rounded-xl text-teal-950 font-bold shadow-xs">
          <Calendar size={13} className="text-teal-600" />
          <span>Price List:</span>
          <span className="font-black text-teal-950 font-mono text-[12px]">{company.priceListYear}</span>
        </div>

        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-emerald-200 rounded-xl text-emerald-950 font-bold shadow-xs">
          <Percent size={13} className="text-emerald-600" />
          <span>Discount:</span>
          <span className="font-black text-emerald-900 font-mono text-[12px]">{company.discount}% OFF</span>
        </div>
      </div>
    </div>
  );
};
