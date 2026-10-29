import { describe, it, expect } from 'vitest';
import { cleanHisProcedureQuery, normalizeText, normalizeArabic } from '../src/lib/arabic-normalizer';
import { extractCleanProcedurePhrase, generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { matchServicesAgainstPricelist } from '../src/mail/syncEngine';
import { parseHisApprovalEmail } from '../src/mail/parser/hisApprovalParser';
import type { InpatientApprovalRecord } from '../src/types';

describe('Clinical Extraction & WhatsApp Precision Specification', () => {
  describe('1. Clinical Justification Stripping & EEG Acronym Detection', () => {
    it('should strip doctor justification preamble and suspicion suffix to isolate EEG', () => {
      const input = 'المريض بحاجه الي عمل EEG لاشتباه وجود جلطه بالمخ';
      const cleaned = cleanHisProcedureQuery(input);
      expect(cleaned).toBe('EEG');

      const phrase = extractCleanProcedurePhrase(input);
      expect(phrase).toBe('EEG');
    });

    it('should isolate Arabic procedure phrase when doctor justification clauses are present', () => {
      const input = 'المريض بحاجه الي عمل رسم مخ لاشتباه وجود جلطه بالمخ';
      const cleaned = cleanHisProcedureQuery(input);
      expect(cleaned).toBe('رسم مخ');

      const phrase = extractCleanProcedurePhrase(input);
      expect(phrase).toBe('رسم مخ');
    });

    it('should isolate other short 2-3 letter clinical acronyms (EMG, ECG, CT, MRI) from Arabic sentences', () => {
      expect(cleanHisProcedureQuery('مطلوب عمل EMG لتقييم التهاب الاعصاب')).toBe('EMG');
      expect(cleanHisProcedureQuery('برجاء عمل MRI brain لاشتباه نزيف بالمخ')).toBe('MRI brain');
      expect(cleanHisProcedureQuery('المريضة بحاجة الى CT chest نظرا لضيق بالتنفس')).toBe('CT chest');
      expect(cleanHisProcedureQuery('نرجو عمل ECG لوجود الام بالصدر')).toBe('ECG');
    });

    it('should match EEG against hospital pricelist catalogs via adjacent year fallback', () => {
      const input = 'المريض بحاجه الي عمل EEG لاشتباه وجود جلطه بالمخ';
      const matches = matchServicesAgainstPricelist([{ name: input, rawPrice: 0 }], '2025');
      expect(matches.length).toBe(1);
      expect(matches[0].status).toBe('matched');
      expect(matches[0].matchedName).toMatch(/E\.?E\.?G|رسم مخ/i);
      expect(matches[0].suggestedPrice).toBeGreaterThan(0);
    });
  });

  describe('2. ICD-10 Diagnosis Exclusion from Procedure Action in WhatsApp', () => {
    it('should NEVER treat ICD-10 diagnoses (e.g. C67-Malignant neoplasm of bladder) as a procedure to "عمل"', () => {
      const record: InpatientApprovalRecord = {
        id: 'rec_c67_test',
        messageId: '<c67@msg>',
        receivedAt: new Date().toISOString(),
        patientName: 'فوزيه سليمان محمد طاهر',
        mrn: '0000060854',
        bed: 'Bed 303 - Zone A',
        contractorRaw: 'Hussem Medical',
        contractorNormalized: 'Hussem Medical',
        priceListYear: '2025',
        diagnosis: 'C67-Malignant neoplasm of bladder',
        requestedServices: [],
        matchedProcedures: [],
        status: 'new_request',
      };

      const wa = generateCmWhatsappMessage(record);
      // Must NOT say "*المطلوب موافقة عمل C67-Malignant neoplasm of bladder*"
      expect(wa).not.toContain('موافقة عمل C67');
      expect(wa).not.toContain('عمل C67-Malignant neoplasm of bladder');
      // Should state admission/inpatient stay request
      expect(wa).toMatch(/موافقة دخول|دخول وإقامة|بالقسم الداخلي/);
    });

    it('should handle admission with non-procedure accommodation/nutrition without treating diagnosis as procedure', () => {
      const record: InpatientApprovalRecord = {
        id: 'rec_c67_nutrition',
        messageId: '<c67_nut@msg>',
        receivedAt: new Date().toISOString(),
        patientName: 'فوزيه سليمان محمد طاهر',
        mrn: '0000060854',
        bed: 'Bed 303 - Zone A',
        contractorRaw: 'Hussem Medical',
        contractorNormalized: 'Hussem Medical',
        priceListYear: '2025',
        diagnosis: 'C67-Malignant neoplasm of bladder',
        requestedServices: [{ name: 'Nutrition Reservation', rawPrice: 720 }],
        matchedProcedures: [],
        status: 'new_request',
      };

      const wa = generateCmWhatsappMessage(record);
      expect(wa).not.toContain('عمل C67');
      expect(wa).toContain('Nutrition Reservation');
    });
  });

  describe('3. Patient Name Extraction from Non-standard HIS Notifications', () => {
    it('should extract patient name from slash formatted radiology description "موافقة أشعة/ احمد يوسف زكريا"', () => {
      const email = {
        subject: 'Inpatient Approval Request',
        htmlBody: `
          <strong>Type:</strong> Request<br>
          <strong>Category:</strong> Approval<br>
          <strong>Group:</strong> ApprovalRequest<br>
          <strong>By:</strong> Abdelrahman Atwan Ewida Raslan<br>
          <strong>Location:</strong> Elite Ground ( G Floor ) - Elite<br>
          <strong>Sub.Location:</strong> RAD Reception<br>
          <strong>Description:</strong><br>
          موافقة أشعة/ احمد يوسف زكريا<br>
          مقطعية بطن وحوض<br>
          نكست كير
        `,
        attachments: [],
      };

      const parsed = parseHisApprovalEmail(email);
      expect(parsed.patientName).toBe('احمد يوسف زكريا');
      expect(parsed.contractorRaw).toBe('نكست كير');
    });

    it('should extract patient name from multiline radiology description with newline after slash', () => {
      const email = {
        subject: 'Inpatient Approval Request',
        htmlBody: `
          <strong>Type:</strong> Request<br>
          <strong>Category:</strong> Approval<br>
          <strong>Group:</strong> ApprovalRequest<br>
          <strong>By:</strong> Abdelrahman Atwan Ewida Raslan<br>
          <strong>Location:</strong> Elite Ground ( G Floor ) - Elite<br>
          <strong>Sub.Location:</strong> RAD Reception<br>
          <strong>Description:</strong><br>
          موافقة أشعة/<br>
          عبدالحميد كمال عبدالحميد سليم<br>
          نكست كير
        `,
        attachments: [],
      };

      const parsed = parseHisApprovalEmail(email);
      expect(parsed.patientName).toBe('عبدالحميد كمال عبدالحميد سليم');
      expect(parsed.contractorRaw).toBe('نكست كير');
    });
  });
});
