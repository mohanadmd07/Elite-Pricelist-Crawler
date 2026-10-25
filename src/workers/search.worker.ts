/**
 * Dedicated Background Web Worker for High-Speed Medical Procedure Search.
 * Offloads fuzzy matching, Arabic/English normalization, and clinical conflict checks
 * from the React UI main thread to maintain 60 FPS responsiveness.
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
  requestedProcedures: { name: string; arabic?: string }[];
}

interface SearchWorkerResponse {
  id: string;
  results: ProcedureResult[];
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
  requestedProcedures: { name: string; arabic?: string }[]
): ProcedureResult[] {
  const finalResults: ProcedureResult[] = [];

  for (const proc of requestedProcedures) {
    const cleanEng = cleanHisProcedureQuery(proc.name);
    const qEng = normalizeText(cleanEng);
    const qEngRaw = normalizeText(proc.name);
    const qAra = proc.arabic ? normalizeArabic(proc.arabic) : '';

    if (!qEng && !qAra && !qEngRaw) continue;

    const exactMatches: ProcedureResult[] = [];
    const partialMatches: ProcedureResult[] = [];

    for (const item of cashList) {
      const itemEng = normalizeText(item.nameEnglish);
      const itemAra = normalizeArabic(item.nameArabic);

      if (hasClinicalMismatch(qEng || qEngRaw, qAra, itemEng, itemAra)) {
        continue;
      }

      const isExactEng = Boolean(qEng && (itemEng === qEng || itemEng === qEngRaw));
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

self.onmessage = (event: MessageEvent<SearchWorkerRequest>) => {
  const { id, cashList, requestedProcedures } = event.data;
  const results = executeSearch(cashList, requestedProcedures);
  self.postMessage({ id, results } as SearchWorkerResponse);
};
