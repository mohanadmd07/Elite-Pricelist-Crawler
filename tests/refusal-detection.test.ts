import { describe, it, expect } from 'vitest';
import { detectRefusal, detectExistingApproval, extractCleanReplyBody, parseHisApprovalEmail } from '../src/mail/parser/hisApprovalParser';
import { extractRefusalReason } from '../src/lib/arabic-normalizer';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import type { InpatientApprovalRecord } from '../src/types';

describe('Refusal Detection Specification', () => {
  describe('1. Clean Reply Extraction from Encoded and Multiline HTML', () => {
    it('should extract clean reply text from HTML-encoded entities like &lt;hr&gt;', () => {
      const html = `
        &lt;html&gt;&#xD;
        &lt;body&gt;&#xD;
        &lt;p&gt;الحاله كاش برجاء المتابعه الحسابيه &lt;a href="mailto:test@hospital.org"&gt;@patient account&lt;/a&gt;&lt;/p&gt;&#xD;
        &lt;hr style="display:inline-block;width:98%" tabindex="-1"&gt;&#xD;
        &lt;div id="divRplyFwdMsg" dir="ltr"&gt;&lt;b&gt;From:&lt;/b&gt; HIS Notifications&lt;br&gt;&#xD;
        &lt;b&gt;Sent:&lt;/b&gt; Sunday, October 18, 2026 12:57:38 AM&lt;br&gt;&#xD;
        &lt;b&gt;Subject:&lt;/b&gt; Inpatient Approval - عصمت حسن حسن يقطين (MRN: 0000221598)&lt;/font&gt;&#xD;
        &lt;/div&gt;&#xD;
        &lt;div&gt;Patient Information ...&lt;/div&gt;&#xD;
        &lt;/body&gt;&#xD;
        &lt;/html&gt;&#xD;
      `;

      const cleanReply = extractCleanReplyBody(html);
      expect(cleanReply).toContain('الحاله كاش برجاء المتابعه الحسابيه');
      expect(cleanReply).not.toContain('Patient Information');
      expect(cleanReply).not.toContain('HIS Notifications');
    });

    it('should extract clean reply for "تم الرفض على السيستم"', () => {
      const html = `
        &lt;html&gt;&#xD;
        &lt;body&gt;&#xD;
        &lt;p&gt;تم الرفض على السيستم &lt;a href="mailto:diana@hospital.org"&gt;@Diana Awad&lt;/a&gt;&lt;/p&gt;&#xD;
        &lt;hr style="display:inline-block;width:98%" tabindex="-1"&gt;&#xD;
        &lt;div id="divRplyFwdMsg" dir="ltr"&gt;&lt;b&gt;From:&lt;/b&gt; Approvals&lt;br&gt;&#xD;
        &lt;/div&gt;&#xD;
        &lt;/body&gt;&#xD;
        &lt;/html&gt;&#xD;
      `;

      const cleanReply = extractCleanReplyBody(html);
      expect(cleanReply).toContain('تم الرفض على السيستم');
    });
  });

  describe('2. Refusal Detection Keywords & State Resolution', () => {
    it('should accurately detect refusal for "الحاله كاش برجاء المتابعه الحسابيه"', () => {
      const text = 'الحاله كاش برجاء المتابعه الحسابيه @patient account';
      const cleanReply = 'الحاله كاش برجاء المتابعه الحسابيه @patient account';
      const result = detectRefusal(text, 'Re: Inpatient Approval', cleanReply);

      expect(result.hasRefusal).toBe(true);
      expect(result.reason).toMatch(/كاش|متابعة حسابية|حسابات/);

      const approval = detectExistingApproval(text, 'Re: Inpatient Approval', cleanReply);
      expect(approval.hasApproval).toBe(false);
    });

    it('should accurately detect refusal for "المريض كاش"', () => {
      const text = 'المريض كاش';
      const result = detectRefusal(text, 'Re: Inpatient Approval', text);

      expect(result.hasRefusal).toBe(true);
      expect(result.reason).toContain('كاش');
    });

    it('should accurately detect refusal for "تم الرفض على السيستم"', () => {
      const text = 'تم الرفض على السيستم @Diana Awad';
      const result = detectRefusal(text, 'Re: Inpatient Approval Request', text);

      expect(result.hasRefusal).toBe(true);
      expect(result.reason).toMatch(/تم الرفض|السيستم|مرفوض/);
    });

    it('should accurately detect refusal for "غير مغطى برجاء ارسال الاهل للتغطيه"', () => {
      const text = 'غير مغطى برجاء ارسال الاهل للتغطيه للاهميه';
      const result = detectRefusal(text, 'RE: Inpatient Approval', text);

      expect(result.hasRefusal).toBe(true);
      expect(result.reason).toMatch(/إرسال الأهل|للتغطية|غير مغطى/);
    });

    it('should accurately detect refusal for "غير مغطي تامنيا"', () => {
      const text = 'غير مغطي تامنيا';
      const result = detectRefusal(text, 'Re: [URGENT] Inpatient Approval', text);

      expect(result.hasRefusal).toBe(true);
      expect(result.reason).toContain('غير مغطى تأمينياً');
    });
  });

  describe('3. Thread Precedence: Latest Refusal Overrides Quoted Approval in History', () => {
    it('should classify as refused when latest reply is cash/refusal even if quoted body contains prior approval', () => {
      const fullHtml = `
        &lt;html&gt;&#xD;
        &lt;body&gt;&#xD;
        &lt;p&gt;الحالة كاش&lt;/p&gt;&#xD;
        &lt;hr style="display:inline-block;width:98%" tabindex="-1"&gt;&#xD;
        &lt;div id="divRplyFwdMsg" dir="ltr"&gt;&lt;b&gt;From:&lt;/b&gt; Approvals&lt;br&gt;&#xD;
        &lt;b&gt;Subject:&lt;/b&gt; Re: Inpatient Approval - ماجدة السيد علي حسنين (MRN: 0000267389)&lt;/font&gt;&#xD;
        &lt;/div&gt;&#xD;
        &lt;p&gt;لا مانع من الدخول وعمل الفحوصات والعملية بحد أقصى 50000 جنيه&lt;/p&gt;&#xD;
        &lt;/body&gt;&#xD;
        &lt;/html&gt;&#xD;
      `;

      const parsed = parseHisApprovalEmail({
        subject: 'Re: Inpatient Approval  - ماجدة السيد علي حسنين (MRN: 0000267389)',
        htmlBody: fullHtml,
        attachments: [],
      });

      expect(parsed.isRefused).toBe(true);
      expect(parsed.hasExistingApproval).toBe(false);
      expect(parsed.refusalReason).toContain('كاش');
    });
  });

  describe('4. WhatsApp Message for Refused Approvals', () => {
    it('should generate refusal message with clear reason and not say approved or pending', () => {
      const record: InpatientApprovalRecord = {
        id: 'rec_refused_test',
        messageId: '<ref@msg>',
        receivedAt: new Date().toISOString(),
        patientName: 'عصمت حسن حسن يقطين',
        mrn: '0000221598',
        bed: 'Bed 1 - ICU',
        contractorRaw: 'Cash نقابة المهندسين',
        contractorNormalized: 'نقابة المهندسين',
        priceListYear: '2025',
        diagnosis: 'End stage renal disease',
        requestedServices: [{ name: 'CSF culture', rawPrice: 1125 }],
        matchedProcedures: [],
        status: 'refused',
        isRefused: true,
        statusReasonArabic: 'الحاله كاش برجاء المتابعه الحسابيه',
      };

      const wa = generateCmWhatsappMessage(record);
      expect(wa).toContain('تم رفض طلب الموافقة على: CSF culture');
      expect(wa).not.toContain('تمت الموافقة');
      expect(wa).not.toContain('المطلوب موافقة');
    });
  });
});
