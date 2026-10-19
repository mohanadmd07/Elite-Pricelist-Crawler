import { ProcedureResult, SelectedProcedure } from '../types';
import { normalizeText, normalizeArabic } from '../lib/arabic-normalizer';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { matchProceduresWithAI } from './aiMatchService';

// Module-level caches per react-best-practices (js-cache-function-results)
const cashDataCache: Record<string, ProcedureResult[]> = {};

export async function getCashData(year: '2023' | '2024' | '2025'): Promise<ProcedureResult[]> {
  if (cashDataCache[year]) {
    return cashDataCache[year];
  }

  const response = await fetch(`/${year}_cash.json`);
  if (!response.ok) {
    throw new Error(`Could not load ${year} Cash pricelist file.`);
  }

  const data: ProcedureResult[] = await response.json();
  cashDataCache[year] = data;
  return data;
}

export function searchLocalPricelist(
  cashList: ProcedureResult[],
  requestedProcedures: { name: string; arabic?: string }[]
): ProcedureResult[] {
  const finalResults: ProcedureResult[] = [];

  for (const proc of requestedProcedures) {
    const qEng = normalizeText(proc.name);
    const qAra = proc.arabic ? normalizeArabic(proc.arabic) : '';

    if (!qEng && !qAra) continue;

    const exactMatches: ProcedureResult[] = [];
    const partialMatches: ProcedureResult[] = [];

    for (const item of cashList) {
      const itemEng = normalizeText(item.nameEnglish);
      const itemAra = normalizeArabic(item.nameArabic);

      const isExactEng = Boolean(qEng && itemEng === qEng);
      const isExactAra = Boolean(qAra && itemAra === qAra);

      if (isExactEng || isExactAra) {
        exactMatches.push({
          ...item,
          requestedProcedureName: proc.name,
        });
        continue;
      }

      const isSubEng = Boolean(qEng && itemEng.includes(qEng));
      const isSubAra = Boolean(qAra && itemAra.includes(qAra));

      if (isSubEng || isSubAra) {
        partialMatches.push({
          ...item,
          requestedProcedureName: proc.name,
        });
      }
    }

    if (exactMatches.length > 0) {
      finalResults.push(...exactMatches);
    } else if (partialMatches.length > 0) {
      const sortedPartials = partialMatches.sort((a, b) => {
        const aEng = normalizeText(a.nameEnglish);
        const bEng = normalizeText(b.nameEnglish);
        const aStarts = qEng && aEng.startsWith(qEng);
        const bStarts = qEng && bEng.startsWith(qEng);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.nameEnglish.length - b.nameEnglish.length;
      });
      finalResults.push(...sortedPartials.slice(0, 5));
    }
  }

  return finalResults;
}

export async function searchAllProcedures(
  selectedProcedures: SelectedProcedure[],
  activeYear?: string,
  aiSearchEnabled = true,
  onProgress?: (progress: {
    stage: 'local' | 'ai' | 'done';
    foundCount: number;
    pendingCount: number;
    isExtendingToAI: boolean;
  }) => void
): Promise<ProcedureResult[]> {
  const yearsToFetch: ('2023' | '2024' | '2025')[] = [];
  if (!activeYear || activeYear === '2025') yearsToFetch.push('2025');
  if (!activeYear || activeYear === '2024') yearsToFetch.push('2024');
  if (!activeYear || activeYear === '2023') yearsToFetch.push('2023');

  onProgress?.({
    stage: 'local',
    foundCount: 0,
    pendingCount: selectedProcedures.length,
    isExtendingToAI: false,
  });

  const localResults: ProcedureResult[] = [];
  const listsToSearch: { year: string; list: ProcedureResult[] }[] = [];

  // 1. Try Supabase RPC first if configured
  if (isSupabaseConfigured() && supabase) {
    try {
      const targetYear = activeYear ? parseInt(activeYear, 10) : 2025;
      for (const proc of selectedProcedures) {
        const { data, error } = await supabase.rpc('search_procedures', {
          p_pricelist_year: targetYear,
          p_search_term: proc.name,
          p_similarity_threshold: 0.25,
        });
        if (!error && Array.isArray(data) && data.length > 0) {
          localResults.push(
            ...data.map((r: any) => ({
              nameArabic: r.name_arabic,
              nameEnglish: r.name_english,
              price: String(r.price),
              sectionName: r.section_name || 'عام',
              sourceFile: r.source_file || `Elite Hospital ${targetYear}`,
              requestedProcedureName: proc.name,
            }))
          );
        }
      }
    } catch (rpcErr) {
      console.warn('Supabase RPC search skipped, falling back to cached lists:', rpcErr);
    }
  }

  // 2. ALWAYS load the local JSON lists into listsToSearch
  // This guarantees local search works AND candidate rows are available for Gemini AI matching
  const fetchedLists = await Promise.all(
    yearsToFetch.map(async (yr) => {
      try {
        const list = await getCashData(yr);
        return { year: yr, list };
      } catch {
        return { year: yr, list: [] };
      }
    })
  );

  for (const item of fetchedLists) {
    if (item.list.length > 0) {
      listsToSearch.push(item);
      const matches = searchLocalPricelist(item.list, selectedProcedures);
      localResults.push(...matches);
    }
  }

  // Find procedures with no matches
  const unmatchedProcedures = selectedProcedures.filter(
    (proc) => !localResults.some((r) => r.requestedProcedureName === proc.name)
  );

  const foundCount = selectedProcedures.length - unmatchedProcedures.length;
  const pendingCount = unmatchedProcedures.length;
  const isExtendingToAI = pendingCount > 0 && aiSearchEnabled;

  onProgress?.({
    stage: isExtendingToAI ? 'ai' : 'done',
    foundCount,
    pendingCount,
    isExtendingToAI,
  });

  let geminiResults: ProcedureResult[] = [];

  if (unmatchedProcedures.length > 0 && aiSearchEnabled && listsToSearch.length > 0) {
    const candidates: ProcedureResult[] = [];
    const seenCandidateKeys = new Set<string>();

    const getSearchTokens = (text: string) => {
      return text
        .toLowerCase()
        .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(
          (t) =>
            t.length >= 2 &&
            ![
              'and',
              'the',
              'for',
              'with',
              'test',
              'blood',
              'study',
              'urine',
              'stool',
              'scan',
              'profile',
              'panel',
              'investigation',
              'procedure',
            ].includes(t)
        );
    };

    for (const proc of unmatchedProcedures) {
      const engTokens = getSearchTokens(proc.name);
      const araTokens = proc.arabic ? getSearchTokens(proc.arabic) : [];
      const allTokens = [...engTokens, ...araTokens];

      if (allTokens.length === 0) {
        allTokens.push(
          ...proc.name
            .toLowerCase()
            .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
            .split(/\s+/)
            .map((t) => t.trim())
            .filter((t) => t.length >= 1)
        );
      }

      for (const item of listsToSearch) {
        let count = 0;
        for (const row of item.list) {
          const rowEng = row.nameEnglish.toLowerCase();
          const rowAra = row.nameArabic ? row.nameArabic.toLowerCase() : '';

          const hasOverlap = allTokens.some(
            (token) => rowEng.includes(token) || (rowAra && rowAra.includes(token))
          );

          if (hasOverlap) {
            const key = `${row.nameEnglish.toLowerCase()}|${row.sourceFile.toLowerCase()}|${row.price}`;
            if (!seenCandidateKeys.has(key)) {
              seenCandidateKeys.add(key);
              candidates.push(row);
              count++;
              if (count > 250) break;
            }
          }
        }
      }
    }

    // If candidate list is empty or sparse, provide top representative candidate items
    if (candidates.length < 15) {
      for (const item of listsToSearch) {
        for (const row of item.list) {
          const key = `${row.nameEnglish.toLowerCase()}|${row.sourceFile.toLowerCase()}|${row.price}`;
          if (!seenCandidateKeys.has(key)) {
            seenCandidateKeys.add(key);
            candidates.push(row);
            if (candidates.length >= 100) break;
          }
        }
        if (candidates.length >= 100) break;
      }
    }

    if (candidates.length > 0) {
      // Do not swallow error; propagate so user gets explicit error explanation
      geminiResults = await matchProceduresWithAI(unmatchedProcedures, candidates);
    }
  }

  // Deduplicate combined results
  const seenKeys = new Set<string>();
  const finalResults: ProcedureResult[] = [];
  const allResults = [...localResults, ...geminiResults];

  for (const res of allResults) {
    const key = `${res.nameEnglish.toLowerCase()}|${res.sourceFile.toLowerCase()}|${String(res.price).trim()}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      finalResults.push(res);
    }
  }

  onProgress?.({
    stage: 'done',
    foundCount: finalResults.length,
    pendingCount: 0,
    isExtendingToAI: false,
  });

  return finalResults;
}
