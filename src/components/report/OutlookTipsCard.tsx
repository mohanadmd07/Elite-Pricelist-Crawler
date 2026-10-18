import React from 'react';
import { Lightbulb, Send } from 'lucide-react';

export const OutlookTipsCard: React.FC = () => {
  return (
    <div className="bg-slate-50 border border-slate-200/90 p-5 rounded-2xl text-left text-xs text-slate-700 font-medium space-y-2">
      <div className="flex items-center gap-2 font-bold text-slate-900 text-sm">
        <Lightbulb size={16} className="text-amber-600" />
        <span>Outlook Email Reply Guide</span>
      </div>
      <p className="leading-relaxed text-slate-600">
        When replying to an insurance or corporate inquiry thread in Microsoft Outlook:
      </p>
      <ol className="list-decimal list-inside space-y-1 text-slate-700 font-semibold pl-1">
        <li>
          Click <span className="font-extrabold text-teal-800">"Copy Text Report"</span> above and paste it directly into your email body.
        </li>
        <li>
          Click <span className="font-extrabold text-slate-900">"Copy CC Emails"</span> and paste them directly into Outlook's CC field to keep the insurance coordinators in loop.
        </li>
      </ol>
    </div>
  );
};
