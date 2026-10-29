import { describe, it, expect, vi } from 'vitest';
import {
  analyzeThreadWithUnifiedAI,
  matchProceduresWithAI,
  extractProceduresFromTextWithAI,
  UnifiedThreadInput,
} from '../src/services/aiMatchService';
import { executeWithRateLimitRetry, isQuotaPaused, markQuotaPaused } from '../src/lib/geminiRateLimiter';

describe('Gemini API 429 Rate Limit & Quota Resilience', () => {
  const sampleInput: UnifiedThreadInput = {
    patientName: 'أحمد محمود علي',
    mrn: '000123456',
    bed: 'Bed 201',
    contractor: 'جلوب ميد',
    priceListYear: '2026',
    diagnosis: 'Acute Appendicitis',
    initialServices: [{ name: 'Laparoscopic Appendectomy', rawPrice: 15000 }],
    threadMessages: [
      {
        sender: 'approvals@globemed.com',
        date: new Date().toISOString(),
        subject: 'Re: Inpatient Approval - أحمد محمود علي',
        body: 'لا مانع من إجراء استئصال الزائدة الدودية بالمنظار بحد أقصى 15000 جنيه',
        isReply: true,
      },
    ],
    candidatePricelistRows: [
      {
        id: 1,
        nameEnglish: 'Laparoscopic Appendectomy',
        nameArabic: 'استئصال الزائدة الدودية بالمنظار',
        sectionName: 'General Surgery',
      },
    ],
  };

  it('should fall back smoothly to heuristics on 429 quota exhaustion without throwing', async () => {
    // When API key is present or absent, analyzeThreadWithUnifiedAI should NEVER throw on 429
    const output = await analyzeThreadWithUnifiedAI(sampleInput);
    expect(output).toBeDefined();
    expect(output.status).toBe('approved');
    expect(output.cmWhatsappMessage).toContain('أحمد محمود علي');
    expect(output.cmWhatsappMessage).toContain('استئصال الزائدة الدودية بالمنظار');
  });

  it('should extract procedure using local fallback if Gemini returns 429 or is unconfigured', async () => {
    const rawNote = 'patient had acute appendicitis and needs urgent laparoscopic appendectomy';
    const procedures = await extractProceduresFromTextWithAI(rawNote);
    expect(procedures.length).toBeGreaterThanOrEqual(1);
    expect(procedures[0].toLowerCase()).toContain('laparoscopic appendectomy');
  });

  it('should retry on transient 429 error with backoff and succeed', async () => {
    let callCount = 0;
    const mockFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('429 Too Many Requests: Resource exhausted quota');
      }
      return 'success_data';
    });

    const result = await executeWithRateLimitRetry(mockFn, { maxRetries: 2, initialDelayMs: 50 });
    expect(result).toBe('success_data');
    expect(callCount).toBe(2);
  });

  it('should track quota paused state when 429 is encountered', () => {
    expect(isQuotaPaused()).toBe(false);
    markQuotaPaused(500);
    expect(isQuotaPaused()).toBe(true);
  });
});
