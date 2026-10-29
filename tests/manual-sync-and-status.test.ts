import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveOfficerByContractor } from '../src/services/contractorOfficerResolver';
import { decide } from '../src/classifier/decide';
import { priceItems } from '../src/classifier/pricing';
import type { LedgerItem, PricedLine } from '../src/classifier/types';
import { triggerManualApprovalsSync } from '../src/services/approvalsFirebaseService';

describe('Status Strings and Unresolved States Specification', () => {
  describe('1. Contractor Resolver Unmatched State', () => {
    it('should return exact matchType "unmatched" and fallback officer string when contractor cannot be resolved', () => {
      const result = resolveOfficerByContractor('Unknown Mysterious Entity 99999');
      expect(result.matched).toBe(false);
      expect(result.matchType).toBe('unmatched');
      expect(result.officerName).toBe('غير محدد (يتطلب تحديد منسق السيلز)');
      expect(result.contractorNormalized).toBe('Unknown Mysterious Entity 99999');
    });
  });

  describe('2. Pricing Engine & Classifier "NO_MAPPING" State', () => {
    it('should set price_source to "NO_MAPPING" when contractor has no pricelist mapping', async () => {
      const items: LedgerItem[] = [
        {
          category: 'PROCEDURE',
          text_original: 'CT Chest with contrast',
          decision: 'APPROVED',
          evidence_quote: 'approved',
          evidence_message_id: 'msg_1',
        },
      ];

      const pricing = await priceItems({
        items,
        contract: null, // No contract mapping
        contractRows: [],
        list2026Rows: [],
        deps: {
          searchPricelistRows: vi.fn().mockResolvedValue([]),
        },
      });

      expect(pricing.flags).toContain('NO_PRICELIST_MAPPING');
      expect(pricing.priced[0].price_source).toBe('NO_MAPPING');
      expect(pricing.priced[0].unit_price).toBeNull();
      expect(pricing.contract_total).toBe(0);
    });

    it('should trigger needs_human_review with "NO_MAPPING" in decide() when item has price_source "NO_MAPPING"', () => {
      const items: LedgerItem[] = [
        {
          category: 'PROCEDURE',
          text_original: 'CT Chest with contrast',
          decision: 'APPROVED',
          evidence_quote: 'approved',
          evidence_message_id: 'msg_1',
        },
      ];

      const priced: PricedLine[] = [
        {
          item: 'CT Chest with contrast',
          canonical_en: null,
          item_index: 0,
          qty: 1,
          unit_price: null,
          line_total: null,
          price_source: 'NO_MAPPING',
          pricelist_id: null,
          pricelist_version: null,
          matched_code: null,
          match_class: null,
          match_score: null,
        },
      ];

      const decision = decide({
        items,
        confidence: 0.95,
        priced,
        resolvedTotal: 0,
        amountCap: null,
        conflicts: [],
        reviewReasons: [],
        priceApprovalStatus: null,
      });

      expect(decision.needs_human_review).toBe(true);
      expect(decision.reasons).toEqual(expect.arrayContaining([expect.stringContaining('NO_MAPPING')]));
    });
  });

  describe('3. Manual Sync Debounce & Force Execution', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('should enforce force flag to bypass debounce on user explicit manual clicks', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messagesFetched: 5, messagesProcessed: 5, messagesSkipped: 0 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // First call with force=true
      const res1 = await triggerManualApprovalsSync(true);
      expect(res1.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second immediate call with force=false should debounce
      const res2 = await triggerManualApprovalsSync(false);
      expect(res2.message).toContain('البيانات حديثة');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Third immediate call with force=true must bypass debounce and fetch
      const res3 = await triggerManualApprovalsSync(true);
      expect(res3.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
    });
  });

  describe('4. Initial Request Parsing & Contractor Variant Resolution', () => {
    it('should resolve EgyptAir Cargo variant to canonical 2025 contract without NO_MAPPING', async () => {
      const { DefaultContractResolver } = await import('../src/classifier/pricelist');
      const resolver = new DefaultContractResolver();
      const contract = await resolver.resolve('مصر للطيران للشحن الجوي بالاسكندرية', new Date());

      expect(contract).not.toBeNull();
      expect(contract?.year).toBe(2025);
      expect(contract?.discountPercent).toBe(25);
    });

    it('should correctly parse DirectApprovalRequest as initial request with pending decision', async () => {
      const { parseHisApprovalEmail } = await import('../src/mail/parser/hisApprovalParser');
      const html = `<html>
        <body>
          <strong>Type:</strong> Request<br>
          <strong>Category:</strong> Approval<br>
          <strong>Group:</strong> DirectApprovalRequest<br>
          <strong>By:</strong> Mohamed Hany Saad Ahmed<br>
          <strong>Description:</strong><br>
          Patient Barcode: 0000095572<br>
          Patient Name: اشرف ابراهيم حنفي محمود<br>
          Contractor Name: مصر للطيران للشحن الجوي بالاسكندرية Main<br>
          Visit Type: HospitalCase<br>
          EmployeeName: محمد سعيد ابو الوفا ابو الوفا
        </body>
      </html>`;

      const parsed = parseHisApprovalEmail({
        subject: 'DirectApprovalRequest',
        htmlBody: html,
        textBody: '',
        sender: 'notifications@elitehospital.org',
        receivedAt: new Date().toISOString(),
      });

      expect(parsed.mrn).toBe('0000095572');
      expect(parsed.patientName).toBe('اشرف ابراهيم حنفي محمود');
      expect(parsed.isReplyMessage).toBe(false);
      expect(parsed.hasExistingApproval).toBe(false);
      expect(parsed.isRefused).toBe(false);
    });
  });

  describe('5. HTML Entity Sanitization & Medical Tourism Role Inference', () => {
    it('should decode HTML entities and strip raw tags from approval text', async () => {
      const { cleanTextFromHtml, decodeHtmlEntities } = await import('../src/mail/parser/hisApprovalParser');
      const raw = '&lt;html&gt;&#xD; &lt;body&gt;&#xD; &lt;div dir="auto"&gt;&#xD; Approved&amp;nbsp;&lt;/div&gt;&#xD; &lt;/body&gt;&#xD; &lt;/html&gt;';

      const decoded = decodeHtmlEntities(raw);
      expect(decoded).not.toContain('&lt;');
      expect(decoded).not.toContain('&#xD;');

      const cleaned = cleanTextFromHtml(raw);
      expect(cleaned).toBe('Approved');
    });

    it('should infer INSURER_ADMIN role for Medical Tourism department approvals', async () => {
      const { inferRole } = await import('../src/classifier/text');
      const sender = 'MedicalTourism@elitehospital.org';
      const text = 'Approved Kind regards, Zina Ibrahim Medical Tourism Department';

      const role = inferRole(sender, text);
      expect(role).toBe('INSURER_ADMIN');
    });
  });
});
