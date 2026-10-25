import { describe, it, expect } from 'vitest';
import { buildDraftReplyText, buildDraftReplyFromRecord } from '../src/lib/draftReplyBuilder';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { normalizeApprovalRecord } from '../src/services/approvalsFirebaseService';

describe('Draft Reply Builder & CM WhatsApp Resilience', () => {
  it('should generate properly formatted draft reply for matched procedures', () => {
    const draft = buildDraftReplyText('2025', 'جاسكو', 'زياد', [
      { serviceName: 'Chest +4 limbs session', matchedName: 'جلسة عنايه صدر + 4 أطراف', status: 'matched' },
    ]);

    expect(draft).toContain('Price list: Elite Hospital 2025');
    expect(draft).toContain('Contractor: جاسكو');
    expect(draft).toContain('المسئول من قسم السيلز: زياد');
    expect(draft).toContain('1- جلسة عنايه صدر + 4 أطراف');
    expect(draft).toContain('@corporate@elitehospital.org');
    expect(draft).not.toContain('undefined');
  });

  it('should include price approval warning for unlisted procedures', () => {
    const draft = buildDraftReplyText('2026', 'أكسا', 'محمد جابر', [
      { serviceName: 'Rare Cardiac Stent', status: 'unmatched', suggestedPrice: 15000 },
    ]);

    expect(draft).toContain('مطلوب موافقة سعرية بمبلغ 15,000 ج.م');
    expect(draft).toContain('Rare Cardiac Stent');
  });

  it('should generate refusal message for Case Manager WhatsApp when isRefused is true', () => {
    const record = {
      patientName: 'عزه احمد احمد عبدالفتاح',
      bed: 'Bed 15 - ICUPhysicianHany sameer',
      contractorNormalized: 'جاسكو',
      contractorRaw: 'جاسكو',
      requestedServices: [{ name: 'Chest +4 limbs session', rawPrice: 1150 }],
      matchedProcedures: [
        { serviceName: 'Chest +4 limbs session', matchedName: 'جلسة عنايه صدر + 4 أطراف', status: 'matched' as const },
      ],
      diagnosis: 'Altered mental status',
      status: 'refused' as const,
      isRefused: true,
    };

    const wa = generateCmWhatsappMessage(record as any);
    expect(wa).toContain('*عزه احمد احمد عبدالفتاح* - Bed 15 - ICU');
    expect(wa).not.toContain('PhysicianHany');
    expect(wa).toContain('جاسكو');
    expect(wa).toContain('*تم رفض طلب الموافقة على: Chest +4 limbs session*');
    expect(wa).not.toContain('قيد التوليد');
  });

  it('normalizeApprovalRecord should never output undefined or placeholder', () => {
    const emptyRecord = {
      patientName: 'مريض تجريبي',
      mrn: '123456',
      contractorRaw: 'بترول',
      contractorNormalized: 'بترول',
      contractorOfficer: 'زياد',
      priceListYear: '2026',
      draftBody: undefined,
      suggestedDraftReply: undefined,
      cmWhatsappMessage: 'رسالة الواتساب قيد التوليد...',
      requestedServices: [{ name: 'تحليل وظائف كبد', rawPrice: 500 }],
      status: 'received' as const,
    };

    const normalized = normalizeApprovalRecord('doc_1', emptyRecord);

    expect(normalized.draftBody).toBeTruthy();
    expect(normalized.draftBody).not.toBe('undefined');
    expect(normalized.draftBody).toContain('Price list: Elite Hospital 2026');

    expect(normalized.cmWhatsappMessage).toBeTruthy();
    expect(normalized.cmWhatsappMessage).not.toContain('قيد التوليد');
    expect(normalized.cmWhatsappMessage).not.toBe('undefined');
    expect(normalized.cmWhatsappMessage).toContain('*مريض تجريبي*');
  });
});
