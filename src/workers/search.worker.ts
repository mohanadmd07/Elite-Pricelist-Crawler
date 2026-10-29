/**
 * Dedicated Background Web Worker for High-Speed Medical Procedure Search.
 * Offloads fuzzy matching, Arabic/English normalization, and clinical conflict checks
 * from the React UI main thread to maintain 60 FPS responsiveness.
 *
 * Performance: row normalization is catalog-dependent, not query-dependent, so it
 * is memoized per catalog array identity (WeakMap). A rebuild swaps in a new array
 * and the index is naturally discarded — no invalidation logic needed.
 */

import { ProcedureResult } from '../types';
import {
  normalizeText,
  normalizeArabic,
  cleanHisProcedureQuery,
  hasAntibodyConflict,
  hasLabInvestigationConflict,
} from '../lib/arabic-normalizer';

interface SearchWorkerRequest {
  id: string;
  cashList: ProcedureResult[];
  requestedProcedures: { name: string; arabic?: string; aliasOfficialNames?: string[] }[];
}

interface SearchWorkerResponse {
  id: string;
  results: ProcedureResult[];
}

interface NormalizedRow {
  item: ProcedureResult;
  eng: string;
  ara: string;
  engTokens: Set<string>;
  araTokens: string[];
}

const normalizedIndexCache = new WeakMap<ProcedureResult[], NormalizedRow[]>();

function getNormalizedIndex(cashList: ProcedureResult[]): NormalizedRow[] {
  let rows = normalizedIndexCache.get(cashList);
  if (!rows) {
    rows = cashList.map((item) => {
      const eng = normalizeText(item.nameEnglish);
      const ara = normalizeArabic(item.nameArabic);
      return {
        item,
        eng,
        ara,
        engTokens: new Set(eng.split(/\s+/)),
        araTokens: ara.split(/\s+/).filter((t) => t.length >= 3),
      };
    });
    normalizedIndexCache.set(cashList, rows);
  }
  return rows;
}

function hasClinicalMismatch(
  queryEngNorm: string,
  queryAraNorm: string,
  rowEngNorm: string,
  rowAraNorm: string
): boolean {
  const queryCombined = `${queryEngNorm} ${queryAraNorm}`;
  const rowCombined = `${rowEngNorm} ${rowAraNorm}`;
  const isTeeQuery = /\b(?:transesophageal|tee|t\.e\.e)\b|ايكو مريئي|عبر المريء/i.test(queryCombined);
  const isTeeRow = /\b(?:transesophageal|tee|t\.e\.e)\b|ايكو مريئي|عبر المريء/i.test(rowCombined);
  if (isTeeQuery !== isTeeRow) return true;
  if (hasAntibodyConflict(queryCombined, rowCombined)) return true;
  if (hasLabInvestigationConflict(queryCombined, rowCombined)) return true;
  return false;
}

function executeSearch(
  cashList: ProcedureResult[],
  requestedProcedures: { name: string; arabic?: string; aliasOfficialNames?: string[] }[]
): ProcedureResult[] {
  const finalResults: ProcedureResult[] = [];
  const rows = getNormalizedIndex(cashList);

  for (const proc of requestedProcedures) {
    const cleanEng = cleanHisProcedureQuery(proc.name);
    const qEng = normalizeText(cleanEng);
    const qEngRaw = normalizeText(proc.name);
    const qAra = proc.arabic ? normalizeArabic(proc.arabic) : normalizeArabic(proc.name);
    const aliasOfficialNames = proc.aliasOfficialNames || [];
    const aliasNorms = new Set(aliasOfficialNames.map(n => normalizeText(n)));
    const aliasAraNorms = new Set(aliasOfficialNames.map(n => normalizeArabic(n)));

    if (!qEng && !qAra && !qEngRaw && aliasOfficialNames.length === 0) continue;

    const exactMatches: ProcedureResult[] = [];
    const partialMatches: ProcedureResult[] = [];

    for (const row of rows) {
      if (hasClinicalMismatch(qEng || qEngRaw, qAra, row.eng, row.ara)) {
        continue;
      }

      const isExactEng = Boolean(qEng && (row.eng === qEng || row.eng === qEngRaw));
      const isExactAra = Boolean(qAra && row.ara === qAra);
      const isAliasMatch = Boolean(
        aliasNorms.size > 0 && (aliasNorms.has(row.eng) || (row.ara && aliasAraNorms.has(row.ara)))
      );

      if (isExactEng || isExactAra || isAliasMatch) {
        exactMatches.push({
          ...row.item,
          requestedProcedureName: proc.name,
        });
        continue;
      }

      const isSubEng = Boolean(qEng && row.eng.includes(qEng));
      const isSubAra = Boolean(qAra && row.ara.includes(qAra));

      if (isSubEng || isSubAra) {
        partialMatches.push({
          ...row.item,
          requestedProcedureName: proc.name,
        });
        continue;
      }

      // Multi-token overlap matching (e.g. out of order words or compound terms).
      // Mirrors searchLocalPricelist: applied to BOTH languages, since Arabic
      // catalog names carry the علي/على preposition + genitive suffixes that a
      // full-string containment test can never match.
      const qTokensEn = (qEng || qEngRaw).split(/\s+/).filter((t) => t.length >= 3);
      if (qTokensEn.length >= 2) {
        if (qTokensEn.every((t) => row.engTokens.has(t) || row.eng.includes(t))) {
          partialMatches.push({
            ...row.item,
            requestedProcedureName: proc.name,
          });
          continue;
        }
      }

      if (qAra) {
        const qTokensAr = qAra.split(/\s+/).filter((t) => t.length >= 3);
        if (qTokensAr.length >= 2) {
          const covered = qTokensAr.filter((t) => row.ara.includes(t)).length;
          const forward = covered / qTokensAr.length;
          const reverse = row.araTokens.length > 0
            ? row.araTokens.filter((t) => qAra.includes(t)).length / row.araTokens.length
            : 0;
          if (forward >= 0.6 || reverse >= 0.6) {
            partialMatches.push({
              ...row.item,
              requestedProcedureName: proc.name,
            });
          }
        }
      }
    }

    if (exactMatches.length > 0) {
      finalResults.push(...exactMatches);
    } else if (partialMatches.length > 0) {
      const sortedPartials = partialMatches.sort((a, b) => {
        const aStarts = qEng && normalizeText(a.nameEnglish).startsWith(qEng);
        const bStarts = qEng && normalizeText(b.nameEnglish).startsWith(qEng);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.nameEnglish.length - b.nameEnglish.length;
      });
      finalResults.push(...sortedPartials.slice(0, 5));
    }
  }

  return finalResults;
}

self.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const { id, cashList, requestedProcedures } = event.data;
  const results = executeSearch(cashList, requestedProcedures);
  self.postMessage({ id, results } as SearchWorkerResponse);
};
