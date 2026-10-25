import { describe, it, expect } from 'vitest';
import {
  normalizeArabic,
  normalizeText,
  cleanContractorName,
  cleanHisProcedureQuery,
  hasAntibodyConflict,
  hasLabInvestigationConflict,
  isAccommodationOrGenericFee,
} from '../src/lib/arabic-normalizer';

describe('Arabic & Clinical Normalizer', () => {
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
