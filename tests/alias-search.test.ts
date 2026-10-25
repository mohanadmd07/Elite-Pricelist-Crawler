import { describe, it, expect } from 'vitest';
import { findOfficialNamesForQuery } from '../src/services/aliasService';
import { searchLocalPricelist } from '../src/services/procedureService';
import { ProcedureResult } from '../src/types';

describe('Catalog Alias Search Integration', () => {
  it('resolves abbreviations to official procedure names', () => {
    const pthMatches = findOfficialNamesForQuery('PTH');
    expect(pthMatches.length).toBeGreaterThan(0);
    expect(pthMatches.some((name) => name.toLowerCase().includes('pth'))).toBe(true);

    const cbcMatches = findOfficialNamesForQuery('CBC');
    expect(cbcMatches.length).toBeGreaterThan(0);
    expect(cbcMatches.some((name) => name.toLowerCase().includes('complete blood count') || name.toLowerCase().includes('cbc'))).toBe(true);

    const kubMatches = findOfficialNamesForQuery('KUB');
    expect(kubMatches.length).toBeGreaterThan(0);
  });

  it('resolves Egyptian Arabic colloquial names to official catalog procedures', () => {
    const portMatches = findOfficialNamesForQuery('بورت كاث');
    expect(portMatches.length).toBeGreaterThan(0);
    expect(portMatches.some((name) => name.toLowerCase().includes('portacath'))).toBe(true);

    const cathMatches = findOfficialNamesForQuery('قسطرة تشخيصية');
    expect(cathMatches.length).toBeGreaterThan(0);
    expect(cathMatches.some((name) => name.toLowerCase().includes('catheter'))).toBe(true);

    const ercpMatches = findOfficialNamesForQuery('منظار قنوات مرارية');
    expect(ercpMatches.length).toBeGreaterThan(0);
    expect(ercpMatches.some((name) => name.toLowerCase().includes('ercp'))).toBe(true);
  });

  it('searches cash catalog items using rich aliases via searchLocalPricelist', () => {
    const mockCatalog: ProcedureResult[] = [
      {
        nameEnglish: 'Intact PTH (PTH 1-84)',
        nameArabic: 'هرمون الغدة الجار درقية',
        price: '850',
        sectionName: 'Laboratory',
        sourceFile: 'Elite 2025',
      },
      {
        nameEnglish: 'Portacath Insertion',
        nameArabic: 'تركيب بورت كاث بالاشعة التداخلية',
        price: '4500',
        sectionName: 'Intervention Radiology',
        sourceFile: 'Elite 2025',
      },
      {
        nameEnglish: 'Diagnostic Cardiac Catheter',
        nameArabic: 'قسطرة القلب التشخيصية',
        price: '6000',
        sectionName: 'Cathlab',
        sourceFile: 'Elite 2025',
      },
      {
        nameEnglish: 'CT Chest',
        nameArabic: 'أشعة مقطعية على الصدر',
        price: '1200',
        sectionName: 'Radiology',
        sourceFile: 'Elite 2025',
      },
    ];

    // Search by abbreviation
    const resPth = searchLocalPricelist(mockCatalog, [{ name: 'PTH' }]);
    expect(resPth.length).toBeGreaterThan(0);
    expect(resPth[0].nameEnglish).toBe('Intact PTH (PTH 1-84)');

    // Search by Arabic synonym
    const resPort = searchLocalPricelist(mockCatalog, [{ name: 'بورت كاث' }]);
    expect(resPort.length).toBeGreaterThan(0);
    expect(resPort[0].nameEnglish).toBe('Portacath Insertion');

    // Search by colloquial Arabic cathlab request
    const resCath = searchLocalPricelist(mockCatalog, [{ name: 'قسطرة تشخيصية' }]);
    expect(resCath.length).toBeGreaterThan(0);
    expect(resCath[0].nameEnglish).toBe('Diagnostic Cardiac Catheter');

    // Search by HRCT acronym
    const resHrct = searchLocalPricelist(mockCatalog, [{ name: 'HRCT Chest' }]);
    expect(resHrct.length).toBeGreaterThan(0);
    expect(resHrct[0].nameEnglish).toBe('CT Chest');
  });
});
