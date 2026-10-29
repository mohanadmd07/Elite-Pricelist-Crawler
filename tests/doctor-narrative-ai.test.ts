import { describe, it, expect } from 'vitest';
import { parseDoctorNarrative, formatDoctorNarrativeSummary } from '../src/lib/doctorNarrativeParser';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { analyzeThreadWithHeuristics, UnifiedThreadInput } from '../src/services/aiMatchService';
import { parseHisApprovalEmail } from '../src/mail/parser/hisApprovalParser';
import type { InpatientApprovalRecord } from '../src/types';

describe('Doctor Narrative Procedure Understanding & AI Decision-Making', () => {
  describe('1. English Doctor Narrative Parsing', () => {
    it('should dissect neuro/physiotherapy narrative into clean procedure and Arabic clinical indication', () => {
      const note = 'patient had bilateral lower limb weakness due to diabetes and hx of strokes and on physiotherapy sessions';
      const parsed = parseDoctorNarrative(note);

      expect(parsed.primaryProcedure.toLowerCase()).toBe('physiotherapy sessions');
      expect(parsed.clinicalIndicationAr).toContain('المريض يعاني من ضعف بالطرفين السفليين بسبب مرض داء السكري');
      expect(parsed.clinicalIndicationAr).toContain('تاريخ مرضي من الجلطات');
      expect(parsed.category).toBe('rehabilitation');
    });

    it('should dissect acute surgical narrative into clean procedure, urgency, and indication', () => {
      const note = 'patient admitted through ER with acute appendicitis, severe RLQ tenderness and vomiting, scheduled for urgent laparoscopic appendectomy';
      const parsed = parseDoctorNarrative(note);

      expect(parsed.primaryProcedure.toLowerCase()).toContain('laparoscopic appendectomy');
      expect(parsed.clinicalIndicationAr).toContain('التهاب حاد بالزائدة الدودية');
      expect(parsed.urgency).toBe('urgent');
      expect(parsed.category).toBe('surgery');
    });

    it('should dissect cardiac intervention narrative with emergency urgency', () => {
      const note = 'patient presenting with acute coronary syndrome and chest pain, ECG shows STEMI, for primary PCI with stent';
      const parsed = parseDoctorNarrative(note);

      expect(parsed.primaryProcedure.toLowerCase()).toContain('primary pci');
      expect(parsed.clinicalIndicationAr).toContain('متلازمة الشريان التاجي الحادة');
      expect(parsed.urgency).toBe('emergency');
      expect(parsed.category).toBe('cardiology');
    });
  });

  describe('2. Arabic Doctor Narrative Parsing & Multi-Procedure Dissection', () => {
    it('should separate stay extension and CT Brain from clinical justification', () => {
      const note = 'المريضة تعاني من ارتفاع في درجة الحرارة و تحتاج الي مد فترة حجزها لعمل التحاليل اللازمة و اخد المضادات الحيوية مع عمل اشعة مقطعية علئ المخ لانها تعاني من صداع شديد مع تاريخ مرضي بالجلطات';
      const parsed = parseDoctorNarrative(note);

      expect(parsed.cleanServices.length).toBeGreaterThanOrEqual(2);
      const names = parsed.cleanServices.map((s) => s.name);
      expect(names.some((n) => n.includes('مد الإقامة') || n.includes('مد فترة حجز'))).toBe(true);
      expect(names.some((n) => n.includes('أشعة مقطعية على المخ') || n.includes('اشعة مقطعية'))).toBe(true);
      expect(parsed.clinicalIndicationAr).toContain('ارتفاع في درجة الحرارة');
      expect(parsed.clinicalIndicationAr).toContain('تاريخ مرضي بالجلطات');
    });
  });

  describe('3. WhatsApp Generation with Clinical Narrative Context', () => {
    it('should render 4-line Case Manager WhatsApp with clean procedure and الداعي الطبي', () => {
      const record: InpatientApprovalRecord = {
        id: 'app_narrative_1',
        messageId: '<narrative1@hospital>',
        receivedAt: new Date().toISOString(),
        patientName: 'عصام عبد الفتاح محمد',
        mrn: '0000456123',
        bed: 'ICU 04',
        contractorRaw: 'ميتلايف MetLife',
        contractorNormalized: 'ميتلايف',
        priceListYear: '2026',
        diagnosis: 'Acute Coronary Syndrome with STEMI',
        requestedServices: [
          { name: 'patient presenting with acute coronary syndrome and chest pain, ECG shows STEMI, for primary PCI with stent', rawPrice: 0 }
        ],
        matchedProcedures: [],
        status: 'pending',
        hasExistingApproval: false,
        isRefused: false,
      };

      const msg = generateCmWhatsappMessage(record);
      expect(msg).toContain('*عصام عبد الفتاح محمد* - ICU 04');
      expect(msg).toContain('ميتلايف');
      expect(msg).toContain('*المطلوب موافقة تركيب دعامة');
      expect(msg).toContain('الداعي الطبي:');
      expect(msg).toContain('متلازمة الشريان التاجي الحادة');
    });
  });

  describe('4. AI Thread Analysis Engine with Doctor Narrative Context', () => {
    it('should parse narrative services cleanly and match against candidate pricelist rows without NO_MAPPING', () => {
      const input: UnifiedThreadInput = {
        patientName: 'مروة كمال ابراهيم',
        mrn: '0000789012',
        bed: 'Room 214',
        contractor: 'بوبا Bupa',
        priceListYear: '2026',
        diagnosis: '',
        initialServices: [
          {
            name: 'patient had bilateral lower limb weakness due to diabetes and hx of strokes and on physiotherapy sessions',
            rawPrice: 0,
          },
        ],
        threadMessages: [],
        candidatePricelistRows: [
          { id: 1, nameEnglish: 'Physiotherapy Session For Inp Patients', nameArabic: 'جلسة علاج طبيعي لمرضي القسم الداخلي', sectionName: 'Physiotherapy' },
          { id: 2, nameEnglish: 'CT Brain Without Contrast', nameArabic: 'اشعة مقطعية على المخ بدون صبغة', sectionName: 'Radiology' }
        ],
      };

      const output = analyzeThreadWithHeuristics(input);
      expect(output.status).toBe('new_request');
      expect(output.matchedProcedures.length).toBe(1);
      expect(output.matchedProcedures[0].status).toBe('matched');
      expect(output.matchedProcedures[0].matchedName).toContain('Physiotherapy Session');
      expect(output.cmWhatsappMessage).toContain('جلسات علاج طبيعي');
      expect(output.cmWhatsappMessage).toContain('الداعي الطبي:');
    });
  });

  describe('5. Full Email Ingestion with Doctor Narrative Decomposition', () => {
    it('should parse email containing doctor narrative, isolating multiple procedures and Arabic indication', () => {
      const html = `
        <html>
        <body>
        <strong>Type:</strong> Request<br>
        <strong>Category:</strong> Approval<br>
        Patient Name: سمير فتحي ابراهيم<br>
        Patient Barcode: 0000888999<br>
        Contractor Name: نكست كير<br>
        Visit Type: HospitalCase<br>
        Bed: Bed 102 - Zone B<br>
        Request Details: patient admitted through ER with acute appendicitis, severe RLQ tenderness and vomiting, scheduled for urgent laparoscopic appendectomy<br>
        </body>
        </html>
      `;

      const parsed = parseHisApprovalEmail({
        subject: 'Inpatient Approval - سمير فتحي ابراهيم (MRN: 0000888999)',
        htmlBody: html,
        attachments: [],
      });

      expect(parsed.patientName).toBe('سمير فتحي ابراهيم');
      expect(parsed.requestedServices.length).toBe(1);
      expect(parsed.requestedServices[0].name.toLowerCase()).toContain('laparoscopic appendectomy');
      expect(parsed.diagnosis).toContain('التهاب حاد بالزائدة الدودية');
    });
  });
});
