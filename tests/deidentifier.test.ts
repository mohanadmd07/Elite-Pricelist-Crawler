import { describe, it, expect } from 'vitest';
import { redactPhiFromText, assertZeroDemographics } from '../src/lib/deidentifier';

describe('PHI De-identifier', () => {
  it('should redact Egyptian names, MRNs, phones, and national IDs', () => {
    const input = 'المريض: أحمد محمد محمود، رقم الملف: 0001234، الهاتف: 01012345678، الرقم القومي: 29501011234567';
    const redacted = redactPhiFromText(input);

    expect(redacted).not.toContain('0001234');
    expect(redacted).not.toContain('01012345678');
    expect(redacted).not.toContain('29501011234567');
    expect(redacted).toContain('[PHONE_REDACTED]');
    expect(redacted).toContain('[NATIONAL_ID_REDACTED]');
    expect(redacted).toContain('[PATIENT_NAME_REDACTED]');
  });

  it('should assert zero demographics in sanitized clinical prompts', () => {
    const cleanPrompt = 'Candidate 1: MRI Brain. Candidate 2: CT Brain. Query: MRI Brain';
    expect(assertZeroDemographics(cleanPrompt).isClean).toBe(true);

    const dirtyPrompt = 'Patient Name: منى علي حسن requested CBC with phone 01012345678';
    const result = assertZeroDemographics(dirtyPrompt, { patientName: 'منى علي حسن' });
    expect(result.isClean).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
