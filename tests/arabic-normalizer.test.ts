import { describe, it, expect } from 'vitest';
import {
  normalizeArabic,
  normalizeText,
  normalizeHomoglyphs,
  cleanContractorName,
  cleanHisProcedureQuery,
  hasAntibodyConflict,
  hasLabInvestigationConflict,
  isAccommodationOrGenericFee,
} from '../src/lib/arabic-normalizer';
import { matchServicesAgainstPricelist } from '../src/mail/syncEngine';

describe('Arabic & Clinical Normalizer', () => {
  it('should normalize Greek and Cyrillic homoglyphs to Latin', () => {
    // Greek Ρ (Rho), Τ (Tau), Η (Eta) -> PTH
    expect(normalizeHomoglyphs('Intact PTH (\u03a1\u03a4\u0397 1-84)')).toBe('Intact PTH (PTH 1-84)');
    // Cyrillic С (ES) -> C
    expect(normalizeHomoglyphs('CD138IH\u0421')).toBe('CD138IHC');
    // normalizeText should map them and normalize to lowercase
    expect(normalizeText('Intact PTH (\u03a1\u03a4\u0397 1-84)')).toBe('intact pth pth 1 84');
  });

  it('should match Intact PTH (PTH 1-84) - Investigation against 2025 pricelist', () => {
    const results = matchServicesAgainstPricelist(
      [{ name: 'Intact PTH (PTH 1-84) - Investigation', rawPrice: 1065 }],
      '2025'
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('matched');
    expect(results[0].matchedName).toBe('Intact PTH (PTH 1-84)');
    expect(results[0].suggestedPrice).toBe(850);
  });
  it('should normalize Arabic Alef, Yaa, Taa Marbuta and digits', () => {
    expect(normalizeArabic('إِسْتِئْصَالُ الْمَرَارَةِ ١٢٣')).toBe('استءصال المراره 123');
    expect(normalizeArabic('أشعة مقطعية على المخ')).toBe('اشعه مقطعيه علي المخ');
  });

  it('should normalize medical English abbreviations and strip billing suffixes', () => {
    expect(normalizeText('E.E.G. - Investigation')).toBe('eeg');
    expect(normalizeText('Complete Blood Count - Profile')).toBe('complete blood');
  });

  it('should clean contractor names of corporate noise and prefixes', () => {
    expect(cleanContractorName('شركة بترول بلاعيم Main')).toBe('بترول بلاعيم');
    expect(cleanContractorName('Cash نقابة المهندسين')).toBe('نقابة المهندسين');
    expect(cleanContractorName('Contractor Name: إيثدكو')).toBe('إيثدكو');
  });

  it('should detect antibody isotype conflicts', () => {
    expect(hasAntibodyConflict('Helicobacter Pylori IgA', 'Helicobacter Pylori IgG')).toBe(true);
    expect(hasAntibodyConflict('Helicobacter Pylori IgG', 'Helicobacter Pylori IgG')).toBe(false);
  });

  it('should detect laboratory culture vs chemistry conflict', () => {
    expect(hasLabInvestigationConflict('CSF Culture', 'CSF Chemistry & Cell count')).toBe(true);
    expect(hasLabInvestigationConflict('CSF Analysis', 'CSF Chemistry & Cell count')).toBe(false);
  });

  it('should identify accommodation and bed fee strings', () => {
    expect(isAccommodationOrGenericFee('ICU Day Care Unit')).toBe(true);
    expect(isAccommodationOrGenericFee('إقامة سرير عناية مركزة')).toBe(true);
    expect(isAccommodationOrGenericFee('Laparoscopic Cholecystectomy')).toBe(false);
  });
});
