import { describe, it, expect } from 'vitest';
import { generateCmWhatsappMessage, extractProcedureFromApprovalReply } from '../src/lib/whatsapp-generator';
import { InpatientApprovalRecord } from '../src/types';

describe('WhatsApp Message Generator', () => {
  it('should generate approved procedure message with credit limit', () => {
    const fixture: InpatientApprovalRecord = {
      id: 'app_1',
      messageId: '<test1@msg>',
      receivedAt: new Date().toISOString(),
      diagnosis: 'Acute Cholecystitis',
      patientName: 'أحمد محمود علي',
      mrn: '000123',
      bed: '304 ICU',
      contractorRaw: 'شركة بترول بلاعيم',
      contractorNormalized: 'بترول بلاعيم',
      priceListYear: '2026',
      contractorOfficer: 'مهند',
      requestedServices: [{ name: 'استئصال المرارة بالمنظار', rawPrice: 50000 }],
      matchedProcedures: [
        {
          serviceName: 'استئصال المرارة بالمنظار',
          matchedName: 'استئصال المرارة بالمنظار',
          code: 'P.101',
          status: 'matched',
        },
      ],
      hasExistingApproval: true,
      existingApprovalSnippet: 'لا مانع من إجراء استئصال المرارة بالمنظار بحد أقصى 50000 ج.م',
      approvedAmountLimit: 50000,
      creditLimit: 50000,
      status: 'approved',
      draftBody: 'تمت الموافقة',
      draftedAt: new Date().toISOString(),
    };

    const msg = generateCmWhatsappMessage(fixture);
    expect(msg).toContain('*أحمد محمود علي* - Bed 304 ICU');
    expect(msg).toContain('بترول بلاعيم');
    expect(msg).toContain('تمت الموافقة على:');
    expect(msg).toContain('50,000 ج.م');
  });

  it('should generate requested procedure message when pending', () => {
    const fixture: InpatientApprovalRecord = {
      id: 'app_2',
      messageId: '<test2@msg>',
      receivedAt: new Date().toISOString(),
      diagnosis: 'Headache',
      patientName: 'عزة إبراهيم حسنين',
      mrn: '000456',
      bed: '210',
      contractorRaw: 'نقابة المهندسين بالإسكندرية',
      contractorNormalized: 'نقابة المهندسين',
      priceListYear: '2026',
      contractorOfficer: 'سارة',
      requestedServices: [{ name: 'MRI Brain with contrast', rawPrice: 4000 }],
      matchedProcedures: [],
      hasExistingApproval: false,
      status: 'new_request',
      draftBody: '',
      draftedAt: new Date().toISOString(),
    };

    const msg = generateCmWhatsappMessage(fixture);
    expect(msg).toContain('*عزة إبراهيم حسنين* - Bed 210');
    expect(msg).toContain('نقابة المهندسين');
    expect(msg).toContain('MRI Brain With Contrast');
  });

  it('should extract procedure from standard Arabic approval phrasing', () => {
    const text = 'تحية طيبة، لا مانع من عمل أشعة رنين مغناطيسي على المخ بحد أقصى ٤٠٠٠ جنيه';
    const proc = extractProcedureFromApprovalReply(text);
    expect(proc).toContain('أشعة رنين مغناطيسي على المخ');
  });
});
