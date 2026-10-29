import { describe, it, expect } from 'vitest';
import { extractCleanProcedurePhrase, formatProcedureForCmWhatsapp, generateCmWhatsappMessage, extractClinicalIndication } from '../src/lib/whatsapp-generator';
import { matchServicesAgainstPricelist } from '../src/mail/syncEngine';
import { parseHisApprovalEmail } from '../src/mail/parser/hisApprovalParser';
import type { InpatientApprovalRecord } from '../src/types';

describe('Clinical Context Understanding & Physiotherapy Specification', () => {
  const rawNote = 'patient had bilateral lower limb weakness due to diabetes and hx of strokes and on physiotherapy sessions';

  describe('1. Extraction of Procedure vs Clinical Indication from Doctor Narrative', () => {
    it('should extract "physiotherapy sessions" as the requested procedure', () => {
      const proc = extractCleanProcedurePhrase(rawNote);
      expect(proc.toLowerCase()).toBe('physiotherapy sessions');
    });

    it('should format "physiotherapy sessions" into Arabic "جلسات علاج طبيعي"', () => {
      const formatted = formatProcedureForCmWhatsapp('physiotherapy sessions');
      expect(formatted).toBe('جلسات علاج طبيعي');
    });

    it('should extract and translate the clinical indication (الداعي الطبي)', () => {
      const indication = extractClinicalIndication(rawNote);
      expect(indication).toContain('المريض يعاني من ضعف بالطرفين السفليين بسبب مرض داء السكري');
      expect(indication).toContain('تاريخ مرضي من الجلطات');
    });
  });

  describe('2. WhatsApp Message Generation with Clinical Indication', () => {
    it('should format message as "المطلوب موافقة جلسات علاج طبيعي" followed by "الداعي الطبي"', () => {
      const record: InpatientApprovalRecord = {
        id: 'app_pt_1',
        messageId: '<pt1@msg>',
        receivedAt: new Date().toISOString(),
        patientName: 'حسن احمد محمد سلامه',
        mrn: '0000319456',
        bed: '319 - Zone A',
        contractorRaw: 'جلوب ميد مصر',
        contractorNormalized: 'جلوب ميد',
        priceListYear: '2026',
        diagnosis: 'Bilateral lower limb weakness due to diabetes and hx of strokes',
        requestedServices: [
          { name: rawNote, rawPrice: 0 }
        ],
        matchedProcedures: [],
        status: 'pending',
        hasExistingApproval: false,
        isRefused: false,
      };

      const msg = generateCmWhatsappMessage(record);
      expect(msg).toContain('*حسن احمد محمد سلامه* - Bed 319 - Zone A');
      expect(msg).toContain('جلوب ميد');
      expect(msg).toContain('*المطلوب موافقة جلسات علاج طبيعي*');
      expect(msg).not.toContain('المطلوب موافقة عمل جلسات');
      expect(msg).not.toContain('المطلوب موافقة عمل patient');
      expect(msg).toContain('الداعي الطبي: المريض يعاني من ضعف بالطرفين السفليين بسبب مرض داء السكري ، مع تاريخ مرضي من الجلطات');
    });
  });

  describe('3. Pricelist Matching for Physiotherapy Sessions', () => {
    it('should match "physiotherapy sessions" to Physiotherapy Session in hospital pricelist', () => {
      const matches = matchServicesAgainstPricelist([
        { name: 'physiotherapy sessions' },
        { name: 'جلسات علاج طبيعي' }
      ], '2026');

      expect(matches[0].status).toBe('matched');
      expect(matches[0].matchedName).toMatch(/Physiotherapy Session/i);

      expect(matches[1].status).toBe('matched');
      expect(matches[1].matchedName).toMatch(/Physiotherapy Session/i);
    });
  });

  describe('4. Full Email Ingestion Context Understanding', () => {
    it('should parse email and extract clean procedure and clinical indication without NO_MAPPING', () => {
      const html = `
        <html>
        <body>
        <strong>Type:</strong> Request<br>
        <strong>Category:</strong> Approval<br>
        Patient Name: حسن احمد محمد سلامه<br>
        Patient Barcode: 0000319456<br>
        Contractor Name: جلوب ميد<br>
        Visit Type: HospitalCase<br>
        Bed: 319 - Zone A<br>
        Request Details: ${rawNote}<br>
        </body>
        </html>
      `;

      const parsed = parseHisApprovalEmail({
        subject: 'Inpatient Approval - حسن احمد محمد سلامه (MRN: 0000319456)',
        htmlBody: html,
        attachments: [],
      });

      expect(parsed.patientName).toBe('حسن احمد محمد سلامه');
      expect(parsed.requestedServices.length).toBe(1);
      expect(parsed.requestedServices[0].name.toLowerCase()).toContain('physiotherapy');
      expect(parsed.diagnosis).toContain('ضعف بالطرفين السفليين');
    });
  });
});
