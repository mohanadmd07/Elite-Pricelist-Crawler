import { describe, it, expect } from 'vitest';
import { cleanHisProcedureQuery, normalizeArabic, isAccommodationOrGenericFee } from '../src/lib/arabic-normalizer';
import { extractCleanProcedurePhrase, generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { searchLocalPricelist } from '../src/services/procedureService';
import { matchServicesAgainstPricelist } from '../src/mail/syncEngine';
import { parseHisApprovalEmail } from '../src/mail/parser/hisApprovalParser';
import fs from 'fs';
import path from 'path';

describe('Clinical Narrative, Stay Extension, and Pricelist Mapping Specification', () => {
  const rawDoctorNote =
    'المريضة تعاني من ارتفاع في درجة الحرارة و تحتاج الي مد فترة حجزها لعمل التحاليل اللازمة و اخد المضادات الحيوية مع عمل اشعة مقطعية علئ المخ لانها تعاني من صداع شديد مع تاريخ مرضي بالجلطات';

  describe('1. Clinical Narrative Preamble and Trailing Indication Cleaning', () => {
    it('should strip doctor preamble and trailing indication, leaving requested clinical items', () => {
      const cleaned = cleanHisProcedureQuery(rawDoctorNote);
      expect(cleaned).not.toContain('المريضة تعاني من ارتفاع');
      expect(cleaned).not.toContain('تحتاج الي');
      expect(cleaned).not.toContain('لانها تعاني من صداع شديد');
      expect(cleaned).not.toContain('تاريخ مرضي بالجلطات');
      expect(cleaned).toContain('مد فترة حجزها');
      expect(cleaned).toContain('اشعة مقطعية');
    });

    it('should normalize typo "علئ" to "علي"', () => {
      const norm = normalizeArabic('اشعة مقطعية علئ المخ');
      expect(norm).toBe('اشعه مقطعيه علي المخ');
      expect(norm).not.toContain('علء');
    });
  });

  describe('2. Pricelist Priority: Exact Name Beats Longer Aliases', () => {
    it('should return CT Brain (1125 EGP) as top match for "أشعة مقطعية علي المخ", not CT Cerebral Angiography', () => {
      const catalog = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'public', '2025_cash.json'), 'utf-8')
      );
      const res = searchLocalPricelist(catalog, [{ name: 'أشعة مقطعية علي المخ' }]);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].nameEnglish).toBe('CT Brain');
      expect(Number(res[0].price)).toBe(1125);
    });
  });

  describe('3. Accommodation and Stay Extension Mapping (Fixing NO_MAPPING)', () => {
    it('should recognize "مد فترة حجزها" as an accommodation stay item', () => {
      expect(isAccommodationOrGenericFee('مد فترة حجزها')).toBe(true);
      expect(isAccommodationOrGenericFee('مد فترة الحجز')).toBe(true);
      expect(isAccommodationOrGenericFee('مد الإقامة')).toBe(true);
    });

    it('should match stay extension and CT Brain without NO_MAPPING', () => {
      const matches = matchServicesAgainstPricelist([
        { name: 'مد فترة حجزها' },
        { name: 'أشعة مقطعية علئ المخ' },
      ], '2025');

      expect(matches).toHaveLength(2);
      expect(matches[0].status).toBe('matched');
      expect(matches[0].matchedName).toMatch(/إقامة|اقامة|Accommodation/i);

      expect(matches[1].status).toBe('matched');
      expect(matches[1].matchedName).toBe('CT Brain');
      expect(matches[1].suggestedPrice).toBe(1125);
    });
  });

  describe('4. Email Parser Multi-Service Extraction from Doctor Note', () => {
    it('should extract distinct services and clinical diagnosis from composite doctor note', () => {
      const html = `
        <html>
        <body>
        <strong>Type:</strong> Request<br>
        <strong>Category:</strong> Approval<br>
        Patient Name: منى محمد أحمد<br>
        Patient Barcode: 0000287419<br>
        Contractor Name: بوبا للتأمين<br>
        Visit Type: HospitalCase<br>
        Bed: 215 - Inpatient<br>
        Request Details: ${rawDoctorNote}<br>
        </body>
        </html>
      `;

      const parsed = parseHisApprovalEmail({
        subject: 'Inpatient Approval - منى محمد أحمد (MRN: 0000287419)',
        htmlBody: html,
        attachments: [],
      });

      expect(parsed.patientName).toBe('منى محمد أحمد');
      expect(parsed.requestedServices.length).toBeGreaterThanOrEqual(1);

      // Verify none of the requested services contain the uncleaned clinical backstory
      for (const s of parsed.requestedServices) {
        expect(s.name).not.toContain('المريضة تعاني من ارتفاع في درجة الحرارة');
        expect(s.name).not.toContain('لانها تعاني من صداع شديد');
      }
    });
  });

  describe('5. WhatsApp Message Formatting for Stay Extension and Procedures', () => {
    it('should format message as "المطلوب موافقة مد الإقامة..." without ungrammatical "عمل"', () => {
      const msg = generateCmWhatsappMessage({
        patientName: 'منى محمد أحمد',
        bed: '215 - Inpatient',
        contractorNormalized: 'بوبا للتأمين',
        contractorRaw: 'بوبا للتأمين',
        requestedServices: [
          { name: 'مد فترة حجزها لعمل التحاليل اللازمة واخد المضادات الحيوية مع عمل اشعة مقطعية علئ المخ', rawPrice: 0 },
        ],
        matchedProcedures: [],
        diagnosis: 'ارتفاع بدرجة الحرارة وصداع شديد',
        status: 'pending',
        hasExistingApproval: false,
        isRefused: false,
      } as any);

      expect(msg).toContain('المطلوب موافقة مد الإقامة');
      expect(msg).not.toContain('المطلوب موافقة عمل مد');
      expect(msg).not.toContain('المريضة تعاني');
      expect(msg).not.toContain('لانها تعاني');
    });
  });
});
