/**
 * Standard Draft Reply Builder for Inpatient Approvals
 * Produces official corporate email replies for Exchange/Outlook.
 */

export interface ProcedureEntry {
  serviceName: string;
  matchedName?: string;
  status: 'matched' | 'unmatched';
  suggestedPrice?: number;
}

/**
 * Builds the standard hospital Outlook email reply text for an inpatient approval.
 * Formatted in Arabic/English matching the corporate communications standard.
 */
export function buildDraftReplyText(
  priceListYear?: string | null,
  contractor?: string | null,
  officer?: string | null,
  matchedProcedures?: ProcedureEntry[] | null
): string {
  const procedures = matchedProcedures || [];
  const matchedLines = procedures
    .filter((p) => p.status === 'matched')
    .map((p, idx) => `${idx + 1}- ${p.matchedName || p.serviceName}`)
    .join('\n');

  const unmatchedLines = procedures
    .filter((p) => p.status === 'unmatched')
    .map(
      (p) =>
        ` - ${p.serviceName}${
          p.suggestedPrice && p.suggestedPrice > 0
            ? ` : مطلوب موافقة سعرية بمبلغ ${Number(p.suggestedPrice).toLocaleString('en-US')} ج.م`
            : ''
        }`
    )
    .join('\n');

  const contractorDisplay = contractor && contractor.trim() ? contractor.trim() : 'التعاقد';
  const displayYear =
    priceListYear === 'Cash' || /كاش|cash|خصم نادي|خصم نادى/i.test(contractorDisplay)
      ? '2026'
      : (priceListYear || '2026');

  const officerDisplay =
    officer && officer.trim() && officer !== 'غير محدد' && !officer.includes('يتطلب تحديد')
      ? officer.trim()
      : 'مسئول السيلز المختص';

  let text = `Price list: Elite Hospital ${displayYear}
Contractor: ${contractorDisplay}
المسئول من قسم السيلز: ${officerDisplay}
Corporate Email: corporate@elitehospital.org
 
الإجراءات المتواجدة بلائحة أسعار التعاقد:
${matchedLines || 'لا توجد إجراءات مطابقة مباشرة باللائحة'}`;

  if (unmatchedLines) {
    text += `\n\n[⚠️  الإجراءات التالية غير مدرجة في لائحة أسعار التعاقد (مطلوب موافقة سعرية):\n${unmatchedLines}]`;
  }

  text += `\n\n@corporate@elitehospital.org`;

  return text;
}

/**
 * Convenience helper to build draft reply directly from an InpatientApprovalRecord.
 */
export function buildDraftReplyFromRecord(record: {
  priceListYear?: string | null;
  contractorNormalized?: string | null;
  contractorRaw?: string | null;
  contractorOfficer?: string | null;
  matchedProcedures?: ProcedureEntry[] | null;
  requestedServices?: Array<{ name: string; rawPrice?: number }> | null;
}): string {
  const contractor = record.contractorNormalized || record.contractorRaw || 'التعاقد';
  const procedures: ProcedureEntry[] =
    record.matchedProcedures && record.matchedProcedures.length > 0
      ? record.matchedProcedures
      : (record.requestedServices || []).map((s) => ({
          serviceName: s.name,
          matchedName: s.name,
          status: 'matched' as const,
        }));

  return buildDraftReplyText(record.priceListYear, contractor, record.contractorOfficer, procedures);
}
