import { ProcedureResult, SelectedProcedure } from '../types';
import {
  normalizeText,
  normalizeArabic,
  cleanHisProcedureQuery,
  expandMedicalSynonyms,
  isAccommodationOrGenericFee,
  hasAntibodyConflict,
  hasLabInvestigationConflict,
} from '../lib/arabic-normalizer';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { matchProceduresWithAI, isGeminiConfigured } from './aiMatchService';
import { getOverrideForQuery, ProcedureOverrideRecord } from './procedureOverrideService';
import { getCachedCatalog, setCachedCatalog } from '../lib/catalogCache';
import { searchPricelistAsync } from './searchWorkerClient';
import { findOfficialNamesForQuery, getAliasesForQuery, loadCatalogAliases } from './aliasService';

// Module-level caches per react-best-practices (js-cache-function-results)
const cashDataCache: Record<string, ProcedureResult[]> = {};

const AI_CACHE_STORAGE_KEY = 'elite_ai_match_cache_v2';
const aiMemoryCache = new Map<string, ProcedureResult[]>();

/**
 * Pre-warms active pricelist catalogs in memory so user searches incur 0ms network fetch latency.
 */
export function preloadPricelists(activeYear?: string): void {
  loadCatalogAliases().catch(() => {});
  const yearsToPreload: ('2023' | '2024' | '2025' | '2026')[] = [];
  const normalizedYear = activeYear === 'Cash' ? '2026' : activeYear;
  if (normalizedYear && (normalizedYear === '2026' || normalizedYear === '2025' || normalizedYear === '2024' || normalizedYear === '2023')) {
    yearsToPreload.push(normalizedYear);
  } else {
    yearsToPreload.push('2026', '2025', '2024', '2023');
  }

  for (const yr of yearsToPreload) {
    if (!cashDataCache[yr]) {
      getCashData(yr).catch(() => {});
    }
  }
}

export async function getCashData(year: '2023' | '2024' | '2025' | '2026'): Promise<ProcedureResult[]> {
  if (cashDataCache[year]) {
    return cashDataCache[year];
  }

  let data: ProcedureResult[] | null = null;

  if (typeof window === 'undefined') {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const filePath = path.resolve(process.cwd(), 'public', `${year}_cash.json`);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        data = JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`Node read error for ${year}_cash.json:`, err);
    }
  }

  // Content version of the live catalog (written by the pipeline exporter as a
  // sidecar). Never cached by CDN/edge so it always reflects the latest build.
  let remoteChecksum: string | null = null;
  if (typeof window !== 'undefined') {
    try {
      const res = await fetch(`/${year}_cash.version.json`, { cache: 'no-store' });
      if (res.ok) {
        const meta = (await res.json()) as { checksum?: string };
        remoteChecksum = meta.checksum ?? null;
      }
    } catch {
      // Sidecar missing (pre-phase5 deploy): fall back to timestamp freshness.
    }

    try {
      const cached = await getCachedCatalog(year, remoteChecksum);
      if (cached && cached.length > 0) {
        data = cached;
      }
    } catch {
      // Fall through to network fetch
    }
  }

  if (!data) {
    const response = await fetch(
      typeof window !== 'undefined' ? `/${year}_cash.json?v=${remoteChecksum ?? Date.now()}` : `/${year}_cash.json`,
      typeof window !== 'undefined' ? { cache: 'no-store' } : undefined,
    );
    if (!response.ok) {
      throw new Error(`Could not load ${year} Cash pricelist file.`);
    }
    data = await response.json();
    if (data && typeof window !== 'undefined') {
      // If the sidecar was absent, derive the checksum from the fetched bytes so
      // future loads still get content-based invalidation once the sidecar ships.
      let checksum = remoteChecksum;
      if (!checksum) {
        try {
          const { sha256Hex } = await import('../lib/sha256');
          checksum = await sha256Hex(JSON.stringify(data));
        } catch {
          checksum = null;
        }
      }
      setCachedCatalog(year, data, checksum).catch(() => {});
    }
  }

  if (data) {
    cashDataCache[year] = data;
    return data;
  }
  return [];
}


/**
 * Cache key generator for multi-tier AI matching cache
 */
function normalizeCatalogYear(year: string | undefined): string {
  if (!year) return 'all';
  return year === 'Cash' ? '2026' : year;
}

function getCacheKey(year: string | undefined, name: string, arabic?: string): string {
  const y = normalizeCatalogYear(year);
  const n = normalizeText(name);
  const a = arabic ? normalizeArabic(arabic) : '';
  return `${y}:${n}:${a}`;
}

function hasClinicalMismatch(
  queryEngNorm: string,
  queryAraNorm: string,
  rowEngNorm: string,
  rowAraNorm: string
): boolean {
  const queryCombined = `${queryEngNorm} ${queryAraNorm}`;
  const rowCombined = `${rowEngNorm} ${rowAraNorm}`;
  // Isolated safety check: TEE (transesophageal echo) must never match surface TTE or unrelated endoscopy
  const isTeeQuery = /\b(?:transesophageal|tee|t\.e\.e)\b|ايكو مريئي|عبر المريء/i.test(queryCombined);
  const isTeeRow = /\b(?:transesophageal|tee|t\.e\.e)\b|ايكو مريئي|عبر المريء/i.test(rowCombined);
  if (isTeeQuery !== isTeeRow) return true;
  if (hasAntibodyConflict(queryCombined, rowCombined)) return true;
  if (hasLabInvestigationConflict(queryCombined, rowCombined)) return true;
  return false;
}

function loadStorageCache(): Record<string, ProcedureResult[]> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(AI_CACHE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveToStorageCache(key: string, results: ProcedureResult[]): void {
  if (typeof window === 'undefined') return;
  try {
    const cache = loadStorageCache();
    cache[key] = results;
    // Bound cache size to last 200 entries to prevent localStorage bloat
    const keys = Object.keys(cache);
    if (keys.length > 200) {
      delete cache[keys[0]];
    }
    localStorage.setItem(AI_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore storage quota errors
  }
}

function getCachedAIResults(
  year: string | undefined,
  proc: SelectedProcedure
): ProcedureResult[] | null {
  const key = getCacheKey(year, proc.name, proc.arabic);
  if (aiMemoryCache.has(key)) {
    return aiMemoryCache.get(key)!;
  }
  const storage = loadStorageCache();
  if (storage[key]) {
    aiMemoryCache.set(key, storage[key]);
    return storage[key];
  }
  return null;
}

function setCachedAIResults(
  year: string | undefined,
  procName: string,
  procArabic: string | undefined,
  results: ProcedureResult[]
): void {
  const key = getCacheKey(year, procName, procArabic);
  aiMemoryCache.set(key, results);
  saveToStorageCache(key, results);
}

/**
 * Calculates Dice string similarity coefficient (0.0 to 1.0) for fast typo/fuzzy matching
 */
function getDiceCoefficient(s1: string, s2: string): number {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substring(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2);
    const count = bigrams.get(bigram) || 0;
    if (count > 0) {
      bigrams.set(bigram, count - 1);
      intersection++;
    }
  }

  return (2.0 * intersection) / (s1.length + s2.length - 2);
}

/**
 * Relevance scoring function: evaluates a pricelist candidate row against query terms
 */
function scoreCandidate(
  rowEngNorm: string,
  rowAraNorm: string,
  queryEngNorm: string,
  queryAraNorm: string,
  tokens: string[]
): number {
  if (hasClinicalMismatch(queryEngNorm, queryAraNorm, rowEngNorm, rowAraNorm)) {
    return 0;
  }

  let score = 0;

  // Exact phrase match
  if (queryEngNorm && rowEngNorm === queryEngNorm) score += 100;
  if (queryAraNorm && rowAraNorm && rowAraNorm === queryAraNorm) score += 100;

  // Prefix match
  if (queryEngNorm && rowEngNorm.startsWith(queryEngNorm)) score += 45;
  if (queryAraNorm && rowAraNorm && rowAraNorm.startsWith(queryAraNorm)) score += 45;

  // Substring match
  if (queryEngNorm && rowEngNorm.includes(queryEngNorm)) score += 25;
  if (queryAraNorm && rowAraNorm && rowAraNorm.includes(queryAraNorm)) score += 25;

  // Token word matches
  for (const token of tokens) {
    if (rowEngNorm === token || (rowAraNorm && rowAraNorm === token)) {
      score += 20;
    } else if (
      rowEngNorm.includes(` ${token} `) ||
      rowEngNorm.startsWith(`${token} `) ||
      rowEngNorm.endsWith(` ${token}`) ||
      (rowAraNorm && rowAraNorm.includes(token))
    ) {
      score += 12;
    } else if (rowEngNorm.includes(token)) {
      score += 5;
    }
  }

  // Dice bigram similarity bonus
  if (queryEngNorm.length >= 3 && rowEngNorm.length >= 3) {
    const dice = getDiceCoefficient(queryEngNorm, rowEngNorm);
    score += Math.round(dice * 25);
  }

  return score;
}

const GENERIC_MODALITY_TERMS = new Set([
  'ct', 'mri', 'sonar', 'doppler', 'duplex', 'ultrasound',
  'computed tomography', 'magnetic resonance imaging',
  'اشعه مقطعيه', 'اشعة مقطعية', 'رنين مغناطيسي', 'موجات صوتيه', 'موجات صوتية', 'سونار', 'دوبلر', 'دوبلكس'
]);

export function searchLocalPricelist(
  cashList: ProcedureResult[],
  requestedProcedures: { name: string; arabic?: string; aliasOfficialNames?: string[] }[]
): ProcedureResult[] {
  const finalResults: ProcedureResult[] = [];

  for (const proc of requestedProcedures) {
    const cleanEng = cleanHisProcedureQuery(proc.name);
    const qEng = normalizeText(cleanEng);
    const qEngRaw = normalizeText(proc.name);
    // When callers don't pass a separate `arabic` field, derive it from the
    // query text — otherwise Arabic token coverage never runs for Arabic queries.
    const qAra = proc.arabic ? normalizeArabic(proc.arabic) : normalizeArabic(proc.name);
    const aliasOfficialNames = proc.aliasOfficialNames || findOfficialNamesForQuery(proc.name, proc.arabic);
    const aliasNorms = new Set(aliasOfficialNames.map((n) => normalizeText(n)));
    const expandedAliases = getAliasesForQuery(proc.name, proc.arabic);
    const synonyms = [...expandMedicalSynonyms(cleanEng || proc.name), ...expandedAliases];

    if (!qEng && !qAra && !qEngRaw && aliasOfficialNames.length === 0) continue;

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
      const isAliasMatch = Boolean(
        aliasNorms.size > 0 &&
          (aliasNorms.has(itemEng) || (itemAra && aliasOfficialNames.some((n) => normalizeArabic(n) === itemAra)))
      );

      // Check clinical synonym expansions (e.g. CXR -> X - Ray Chest, CTPA -> CT Pulmonary Angio, physiotherapy -> Physiotherapy Session)
      let isExactSynMatch = false;
      let isSynMatch = false;
      if (synonyms.length > 0) {
        for (const syn of synonyms) {
          const normSynEn = normalizeText(syn);
          const normSynAr = normalizeArabic(syn);
          if (normSynEn && !GENERIC_MODALITY_TERMS.has(normSynEn) && normSynEn !== qEng) {
            if (itemEng === normSynEn) {
              isExactSynMatch = true;
              break;
            } else if (normSynEn.length >= 5 && itemEng.includes(normSynEn)) {
              isSynMatch = true;
              break;
            }
          }
          if (normSynAr && !GENERIC_MODALITY_TERMS.has(normSynAr) && normSynAr !== qAra) {
            if (itemAra === normSynAr) {
              isExactSynMatch = true;
              break;
            } else if (normSynAr.length >= 5 && itemAra.includes(normSynAr)) {
              isSynMatch = true;
              break;
            }
          }
        }
      }

      if (isExactEng || isExactAra || isAliasMatch || isExactSynMatch) {
        exactMatches.push({
          ...item,
          requestedProcedureName: proc.name,
        });
        continue;
      }

      const isSubEng = Boolean(qEng && itemEng.includes(qEng));
      const isSubAra = Boolean(qAra && itemAra.includes(qAra));

      if (isSubEng || isSubAra || isSynMatch) {
        partialMatches.push({
          ...item,
          requestedProcedureName: proc.name,
        });
        continue;
      }

      // Multi-token overlap matching (e.g. out of order words or compound terms).
      // Applied to BOTH languages: Arabic catalog names are written with the
      // "علي/على" preposition + genitive suffixes ("القطنية والعجزية"), so a
      // full-string containment test fails for perfectly ordinary queries like
      // "رنين مغناطيسي على الفقرات القطنية". Token coverage is the language-
      // agnostic form of the same rule the English path already uses.
      const qTokensEn = (qEng || qEngRaw).split(/\s+/).filter((t) => t.length >= 3);
      if (qTokensEn.length >= 2) {
        const itemTokens = new Set(itemEng.split(/\s+/));
        if (qTokensEn.every((t) => itemTokens.has(t) || itemEng.includes(t))) {
          partialMatches.push({
            ...item,
            requestedProcedureName: proc.name,
          });
          continue;
        }
      }

      if (qAra) {
        // Coverage counts query tokens present in the row (exact token or substring),
        // and row tokens present in the query — the union direction pg_trgm's
        // word_similarity models server-side.
        const qTokensAr = qAra.split(/\s+/).filter((t) => t.length >= 3);
        if (qTokensAr.length >= 2) {
          const covered = qTokensAr.filter((t) => itemAra.includes(t)).length;
          const rowTokens = itemAra.split(/\s+/).filter((t) => t.length >= 3);
          const reverse = rowTokens.length > 0
            ? rowTokens.filter((t) => qAra.includes(t)).length / rowTokens.length
            : 0;
          const forward = covered / qTokensAr.length;
          if (forward >= 0.6 || reverse >= 0.6) {
            partialMatches.push({
              ...item,
              requestedProcedureName: proc.name,
            });
            continue;
          }
        }
      }


    }

    if (exactMatches.length > 0) {
      const sortedExact = exactMatches.sort((a, b) => {
        const aEng = normalizeText(a.nameEnglish);
        const bEng = normalizeText(b.nameEnglish);
        const aAra = normalizeArabic(a.nameArabic);
        const bAra = normalizeArabic(b.nameArabic);

        // Priority 1: Exact string match to query nameArabic or nameEnglish
        const aIsExact = Boolean((qAra && aAra === qAra) || (qEng && aEng === qEng));
        const bIsExact = Boolean((qAra && bAra === qAra) || (qEng && bEng === qEng));
        if (aIsExact && !bIsExact) return -1;
        if (!aIsExact && bIsExact) return 1;

        const stemToken = (t: string) => t.replace(/^(?:و|ف)?(?:ال)?/, '');
        const qTokens = (qEng + ' ' + qAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aTokens = (aEng + ' ' + aAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const bTokens = (bEng + ' ' + bAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aCount = qTokens.filter((t) => aTokens.some((at) => at === t || at.includes(t) || t.includes(at))).length;
        const bCount = qTokens.filter((t) => bTokens.some((bt) => bt === t || bt.includes(t) || t.includes(bt))).length;
        if (aCount !== bCount) {
          return bCount - aCount;
        }

        // Check bilaterality: if query implies bilateral (ساقين, طرفين, طرفان, both, bilateral), prefer both over one
        const isBilateralQ = /ساقين|طرفين|طرفان|قدمين|ركبتين|يدين|عينين|اذنين|both|bilateral/i.test(qAra + ' ' + qEng);
        if (isBilateralQ) {
          const aBoth = /both|bilateral|طرفين|ساقين|جانبين/i.test(aEng + ' ' + aAra);
          const bBoth = /both|bilateral|طرفين|ساقين|جانبين/i.test(bEng + ' ' + bAra);
          if (aBoth && !bBoth) return -1;
          if (!aBoth && bBoth) return 1;
        }

        return b.nameEnglish.length - a.nameEnglish.length;
      });
      finalResults.push(...sortedExact);
    } else if (partialMatches.length > 0) {
      const sortedPartials = partialMatches.sort((a, b) => {
        const aEng = normalizeText(a.nameEnglish);
        const bEng = normalizeText(b.nameEnglish);
        const aAra = normalizeArabic(a.nameArabic);
        const bAra = normalizeArabic(b.nameArabic);

        // Action verb consistency check: insertion vs removal
        const qAction = /insertion|تركيب|بذل|drainage/i.test(qEng + ' ' + qAra) ? 'insert' :
                        /removal|رفع|استخراج|ازالة/i.test(qEng + ' ' + qAra) ? 'remove' : null;
        if (qAction === 'insert') {
          const aHas = /insertion|تركيب|بذل|drainage/i.test(aEng + ' ' + aAra);
          const bHas = /insertion|تركيب|بذل|drainage/i.test(bEng + ' ' + bAra);
          if (aHas && !bHas) return -1;
          if (!aHas && bHas) return 1;
        } else if (qAction === 'remove') {
          const aHas = /removal|رفع|استخراج|ازالة/i.test(aEng + ' ' + aAra);
          const bHas = /removal|رفع|استخراج|ازالة/i.test(bEng + ' ' + bAra);
          if (aHas && !bHas) return -1;
          if (!aHas && bHas) return 1;
        }

        // Multi-organ specificity: query with multiple targets (e.g. abdomen + pelvis) ranks combined items higher
        const stemToken = (t: string) => t.replace(/^(?:و|ف)?(?:ال)?/, '');
        const qTokens = (qEng + ' ' + qAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aTokens = (aEng + ' ' + aAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const bTokens = (bEng + ' ' + bAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aCount = qTokens.filter((t) => aTokens.some((at) => at === t || at.includes(t) || t.includes(at))).length;
        const bCount = qTokens.filter((t) => bTokens.some((bt) => bt === t || bt.includes(t) || t.includes(bt))).length;
        if (aCount !== bCount) {
          return bCount - aCount;
        }

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

/**
 * Resolves a manual override into a priced catalog row.
 * The override stores only code + display name; we look the SKU up in the live
 * cash catalogs so reports never carry fabricated 0.00 prices. If the SKU is
 * absent from every year (retired procedure), the row is returned with an
 * explicit priceUnresolved marker and null price rather than a fake zero.
 */
async function resolveOverrideRow(
  override: ProcedureOverrideRecord,
  preferredYear?: string,
): Promise<ProcedureResult> {
  const years: ('2023' | '2024' | '2025' | '2026')[] = ['2026', '2025', '2024', '2023'];
  if (preferredYear && years.includes(preferredYear as any)) {
    years.sort((a, b) => (a === preferredYear ? -1 : b === preferredYear ? 1 : 0));
  }

  let fallbackName = override.chosenName;
  for (const yr of years) {
    try {
      const catalog = await getCashData(yr);
      const hit = override.chosenCode
        ? catalog.find((c) => c.code === override.chosenCode)
        : catalog.find(
            (c) =>
              normalizeArabic(normalizeText(c.nameArabic || '')) ===
                normalizeArabic(normalizeText(fallbackName)) ||
              normalizeText(c.nameEnglish).toLowerCase() === normalizeText(fallbackName).toLowerCase(),
          );
      if (hit) {
        return {
          ...hit,
          requestedProcedureName: override.queryText,
          sectionName: `${hit.sectionName || 'عام'} — تعديل يدوي معتمد`,
          sourceFile: `Manual Override Priority (${yr})`,
        };
      }
    } catch {
      // Catalog unavailable for this year; continue searching others.
    }
  }

  return {
    code: override.chosenCode,
    nameArabic: override.chosenName,
    nameEnglish: override.chosenName,
    price: '',
    priceUnresolved: true,
    sectionName: 'تعديل يدوي معتمد (Override)',
    sourceFile: 'Manual Override Priority',
    requestedProcedureName: override.queryText,
  };
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
    aiError?: string;
  }) => void
): Promise<ProcedureResult[]> {
  const normalizedYear = activeYear === 'Cash' ? '2026' : activeYear;
  const yearsToFetch: ('2023' | '2024' | '2025' | '2026')[] = [];
  if (!normalizedYear || normalizedYear === '2026') yearsToFetch.push('2026');
  if (!normalizedYear || normalizedYear === '2025') yearsToFetch.push('2025');
  if (!normalizedYear || normalizedYear === '2024') yearsToFetch.push('2024');
  if (!normalizedYear || normalizedYear === '2023') yearsToFetch.push('2023');

  onProgress?.({
    stage: 'local',
    foundCount: 0,
    pendingCount: selectedProcedures.length,
    isExtendingToAI: false,
  });

  await loadCatalogAliases().catch(() => {});

  const localResults: ProcedureResult[] = [];
  const listsToSearch: { year: string; list: ProcedureResult[] }[] = [];

  // 0. Check clinician and staff priority manual overrides
  const pendingProcedures: SelectedProcedure[] = [];
  for (const proc of selectedProcedures) {
    const override = await getOverrideForQuery(proc.name);
    if (override) {
      localResults.push(await resolveOverrideRow(override, normalizedYear));
    } else {
      pendingProcedures.push(proc);
    }
  }

  // If all procedures resolved by overrides, return immediately
  if (pendingProcedures.length === 0 && localResults.length > 0) {
    return localResults;
  }

  // 1. Parallel Supabase RPC lookup; each query gets its OWN 750ms budget so one
  //    slow query can no longer cancel the whole batch (the previous single
  //    Promise.race discarded every in-flight result on timeout).
  if (isSupabaseConfigured() && supabase) {
    try {
      const targetYear = normalizedYear ? parseInt(normalizedYear, 10) : 2026;
      const sb = supabase;
      const rpcPromises = pendingProcedures.map(async (proc) => {
        try {
          const cleanedSearchTerm = cleanHisProcedureQuery(proc.name) || proc.name;
          const rpcCall = sb.rpc('search_procedures', {
            p_pricelist_year: targetYear,
            p_search_term: cleanedSearchTerm,
            p_similarity_threshold: 0.25,
          });
          const timed = await Promise.race([
            rpcCall,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 750)),
          ]);
          if (!timed) return [];
          const { data, error } = timed;
          if (!error && Array.isArray(data) && data.length > 0) {
            return data.map((r: any) => ({
              code: r.code || undefined,
              nameArabic: r.name_arabic,
              nameEnglish: r.name_english,
              price: String(r.price),
              sectionName: r.section_name || 'عام',
              sourceFile: r.source_file || `Elite Hospital ${targetYear}`,
              requestedProcedureName: proc.name,
            }));
          }
          return [];
        } catch {
          return [];
        }
      });

      // Await every per-query budget; no outer race — slow queries resolve to []
      // individually instead of discarding the fast ones' results.
      const rpcResults = await Promise.all(rpcPromises);

      for (const resList of rpcResults) {
        localResults.push(...resList);
      }
    } catch (rpcErr) {
      console.warn('Supabase RPC search skipped or timed out, using cached lists:', rpcErr);
    }
  }

  // 2. Load cached local JSON lists in parallel, then search all years in ONE
  //    worker round-trip (the previous per-year await serialized ~4 worker trips).
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

  const combinedList: ProcedureResult[] = [];
  for (const item of fetchedLists) {
    if (item.list.length > 0) {
      listsToSearch.push(item);
      combinedList.push(...item.list);
    }
  }

  if (combinedList.length > 0) {
    const matches = await searchPricelistAsync(combinedList, pendingProcedures);
    localResults.push(...matches);
  }

  // 3. Identify unmatched procedures
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
    // 4. Multi-tier Cache Check: Check memory and localStorage cache first
    const stillUnmatched: SelectedProcedure[] = [];

    for (const proc of unmatchedProcedures) {
      const cached = getCachedAIResults(activeYear, proc);
      if (cached && cached.length > 0) {
        geminiResults.push(...cached);
      } else {
        stillUnmatched.push(proc);
      }
    }

    // Only query Gemini if there are uncached procedures
    if (stillUnmatched.length > 0) {
      const getSearchTokens = (text: string) => {
        return text
          .toLowerCase()
          .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
          .split(/\s+/)
          .map((t) => t.trim())
          .filter(
            (t) =>
              (t.length >= 2 || /^[0-9]$/.test(t)) &&
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

      // 5. Pre-score and rank candidates using fast local scoring
      const candidatePool: ProcedureResult[] = [];
      const seenCandidateKeys = new Set<string>();

      for (const proc of stillUnmatched) {
        const cleanProcName = cleanHisProcedureQuery(proc.name);
        const qEngNorm = normalizeText(cleanProcName);
        const qAraNorm = proc.arabic ? normalizeArabic(proc.arabic) : '';
        const tokens = [
          ...getSearchTokens(cleanProcName),
          ...(proc.arabic ? getSearchTokens(proc.arabic) : []),
        ];

        // Score all available pricelist rows for this procedure
        const scoredRows: { row: ProcedureResult; score: number }[] = [];

        for (const item of listsToSearch) {
          for (const row of item.list) {
            const rowEngNorm = normalizeText(row.nameEnglish);
            const rowAraNorm = normalizeArabic(row.nameArabic);

            const score = scoreCandidate(rowEngNorm, rowAraNorm, qEngNorm, qAraNorm, tokens);
            if (score >= 8) {
              scoredRows.push({ row, score });
            }
          }
        }

        // Sort descending by score and pick top 18 most relevant candidates per procedure
        scoredRows.sort((a, b) => b.score - a.score);
        const topCandidates = scoredRows.slice(0, 18);

        for (const item of topCandidates) {
          const key = `${item.row.nameEnglish.toLowerCase()}|${item.row.sourceFile.toLowerCase()}|${item.row.price}`;
          if (!seenCandidateKeys.has(key)) {
            seenCandidateKeys.add(key);
            candidatePool.push(item.row);
          }
        }
      }

      if (candidatePool.length > 0 && isGeminiConfigured()) {
        try {
          // Query Gemini with ultra-compact indexed candidate list
          const newAiMatches = await matchProceduresWithAI(stillUnmatched, candidatePool);
          const clinicallyValidMatches = newAiMatches.filter((match) => {
            const proc = stillUnmatched.find(
              (p) => p.name.toLowerCase() === (match.requestedProcedureName || '').toLowerCase()
            );
            const qEng = normalizeText(cleanHisProcedureQuery(proc?.name || match.requestedProcedureName || ''));
            const qAra = proc?.arabic ? normalizeArabic(proc.arabic) : '';
            return !hasClinicalMismatch(
              qEng,
              qAra,
              normalizeText(match.nameEnglish),
              normalizeArabic(match.nameArabic)
            );
          });
          geminiResults.push(...clinicallyValidMatches);

          // Save newly found matches to multi-tier cache
          for (const proc of stillUnmatched) {
            const matchesForProc = clinicallyValidMatches.filter(
              (m) => m.requestedProcedureName?.toLowerCase() === proc.name.toLowerCase()
            );
            if (matchesForProc.length > 0) {
              setCachedAIResults(activeYear, proc.name, proc.arabic, matchesForProc);
            }
          }
        } catch (aiErr: any) {
          const aiMessage = aiErr?.message || String(aiErr);
          console.warn('[Procedure Service] Semantic AI matching skipped/failed:', aiErr);
          onProgress?.({
            stage: localResults.length > 0 ? 'done' : 'ai',
            foundCount: localResults.length,
            pendingCount: stillUnmatched.length,
            isExtendingToAI: false,
            aiError: aiMessage,
          });
          if (localResults.length === 0) {
            if (candidatePool.length > 0) {
              console.warn('[Procedure Service] Using candidatePool as fallback due to AI 429/error');
              geminiResults.push(...candidatePool.slice(0, 5));
            }
          }
        }
      }
    }
  }

  // 6. Deduplicate combined results
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

/**
 * Dynamic Hybrid Candidate Retriever
 * Evaluates requested clinical services and diagnosis against the FULL hospital catalog
 * (1,600 - 10,000+ items) using clinical synonym expansion and high-performance ranking.
 * Guarantees that Gemini / heuristic engines receive truly relevant surgical and procedural candidates
 * rather than arbitrary top-of-file rows.
 */
export async function retrieveDynamicPricelistCandidates(
  year: string | undefined,
  services: Array<{ name: string; rawPrice?: number }>,
  diagnosis?: string,
  maxTotalCandidates: number = 30
): Promise<Array<{ id: number; nameEnglish: string; nameArabic?: string; sectionName?: string; price?: number; score: number }>> {
  // 1. Resolve normalized year
  let validYear: '2023' | '2024' | '2025' | '2026' = '2026';
  if (year === '2025') validYear = '2025';
  else if (year === '2024') validYear = '2024';
  else if (year === '2023') validYear = '2023';
  else if (year === '2026' || year === 'Cash' || !year) validYear = '2026';

  let catalog: ProcedureResult[] = [];
  try {
    catalog = await getCashData(validYear);
  } catch (err) {
    console.warn(`[CandidateRetriever] Failed to load catalog for year ${validYear}, fallback to 2025:`, err);
    try {
      catalog = await getCashData('2025');
    } catch {}
  }

  if (!catalog || catalog.length === 0) {
    return [];
  }

  // 2. Identify queries to search
  const queriesToScore: Array<{ query: string; isAccommodation: boolean; priority: number }> = [];

  for (const s of services) {
    const raw = (s.name || '').trim();
    if (!raw) continue;
    const isAccom = isAccommodationOrGenericFee(raw);
    queriesToScore.push({
      query: raw,
      isAccommodation: isAccom,
      priority: isAccom ? 1 : 10,
    });
  }

  // If no services or only accommodation, also extract clinical terms from diagnosis
  if (diagnosis && (queriesToScore.length === 0 || queriesToScore.every((q) => q.isAccommodation))) {
    const cleanDiag = diagnosis.replace(/[-–,;:.]+/g, ' ').trim();
    if (cleanDiag.length > 3) {
      queriesToScore.push({
        query: cleanDiag,
        isAccommodation: false,
        priority: 5,
      });
    }
  }

  if (queriesToScore.length === 0) {
    // Fallback: return general surgical and diagnostic core items
    return catalog.slice(0, maxTotalCandidates).map((row, idx) => ({
      id: idx,
      nameEnglish: row.nameEnglish || '',
      nameArabic: row.nameArabic || '',
      sectionName: row.sectionName || '',
      price: Number(row.price) || 0,
      score: 1,
    }));
  }

  // 3. Score all catalog rows against expanded queries
  const candidateScores = new Map<number, { row: ProcedureResult; maxScore: number }>();

  for (const qObj of queriesToScore) {
    const expandedSynonyms = expandMedicalSynonyms(qObj.query);
    const cleanQ = cleanHisProcedureQuery(qObj.query);
    const qEng = normalizeText(cleanQ);
    const qAra = normalizeArabic(cleanQ);

    const tokens = new Set<string>();
    for (const syn of expandedSynonyms) {
      const parts = (normalizeText(syn) + ' ' + normalizeArabic(syn))
        .split(' ')
        .filter((t) => t.length > 2);
      parts.forEach((p) => tokens.add(p));
    }
    const tokenArr = Array.from(tokens);

    catalog.forEach((item, idx) => {
      // Antibody Isotype conflict protection: e.g. Tissue transglutaminase IgG vs IgA
      if (hasAntibodyConflict(cleanQ, item.nameEnglish || '') || hasAntibodyConflict(cleanQ, item.nameArabic || '')) {
        return;
      }

      // Laboratory investigation modality conflict protection: e.g. CSF culture vs CSF analysis
      if (hasLabInvestigationConflict(cleanQ, item.nameEnglish || '') || hasLabInvestigationConflict(cleanQ, item.nameArabic || '')) {
        return;
      }

      const itemEng = normalizeText(item.nameEnglish);
      const itemAra = normalizeArabic(item.nameArabic);

      let score = 0;

      // Check expanded synonyms for exact or prefix matches
      for (const syn of expandedSynonyms) {
        const sEng = normalizeText(syn);
        const sAra = normalizeArabic(syn);

        if (sEng && itemEng === sEng) score = Math.max(score, 120);
        if (sAra && itemAra === sAra) score = Math.max(score, 120);

        if (sEng && (itemEng.startsWith(sEng) || itemEng.includes(` ${sEng} `))) score = Math.max(score, 60);
        if (sAra && (itemAra.startsWith(sAra) || itemAra.includes(` ${sAra} `))) score = Math.max(score, 60);
      }

      // Check tokens
      for (const t of tokenArr) {
        if (itemEng.includes(t) || itemAra.includes(t)) {
          score += 12;
        }
      }

      // Bonus for dice coefficient
      if (qEng.length >= 3 && itemEng.length >= 3) {
        const dice = getDiceCoefficient(qEng, itemEng);
        score += Math.round(dice * 25);
      }

      // Penalize accommodation rows if query is not accommodation
      if (!qObj.isAccommodation && isAccommodationOrGenericFee(item.nameArabic || item.nameEnglish)) {
        score = Math.floor(score * 0.2);
      }

      // Physiotherapy / chest care session with N limbs -> "Chest + N Limbs Session"
      const qAllText = `${cleanQ} ${qEng} ${qAra}`;
      if (/علاج\s*طبيع|physio|عنايه\s*صدر|عناية\s*صدر/i.test(qAllText) && /chest\s*\+\s*\d\s*limbs?/i.test(item.nameEnglish || '')) {
        const qLimbs = qAllText.match(/(\d)\s*(?:اطراف|أطراف|limbs?)/i)?.[1];
        const rowLimbs = (item.nameEnglish || '').match(/\+\s*(\d)\s*limbs?/i)?.[1];
        if (/صدر|chest/i.test(qAllText) && qLimbs && qLimbs === rowLimbs) score = Math.max(score, 80);
      }

      if (score > 15) {
        const existing = candidateScores.get(idx);
        if (!existing || score > existing.maxScore) {
          candidateScores.set(idx, { row: item, maxScore: score });
        }
      }
    });
  }

  // 4. Sort and pick top candidates
  const sorted = Array.from(candidateScores.entries())
    .map(([idx, data]) => ({
      id: idx,
      nameEnglish: data.row.nameEnglish,
      nameArabic: data.row.nameArabic,
      sectionName: data.row.sectionName,
      price: Number(data.row.price) || 0,
      score: data.maxScore,
    }))
    .sort((a, b) => b.score - a.score);

  const topCandidates = sorted.slice(0, maxTotalCandidates);

  // If candidate count is still low, pad with top catalog items so AI has context
  if (topCandidates.length < 5) {
    const padCount = Math.min(10, catalog.length);
    for (let i = 0; i < padCount; i++) {
      if (!topCandidates.some((c) => c.id === i)) {
        topCandidates.push({
          id: i,
          nameEnglish: catalog[i].nameEnglish,
          nameArabic: catalog[i].nameArabic,
          sectionName: catalog[i].sectionName,
          price: Number(catalog[i].price) || 0,
          score: 1,
        });
      }
    }
  }

  return topCandidates;
}


/**
 * For procedures that are NOT listed in the contractor's pricelist, find the same procedure in the
 * other hospital pricelists (cash 2026 first) and attach its price, so the reply can state
 * "مطلوب موافقة سعرية بمبلغ X". Falls back to the HIS requested price when no reference is found.
 */
export async function enrichUnmatchedWithReferencePrice<
  T extends { serviceName: string; status: 'matched' | 'unmatched'; suggestedPrice?: number; suggestedFrom?: string }
>(matched: T[], requestedServices: Array<{ name: string; rawPrice?: number }>): Promise<T[]> {
  const out: T[] = [];
  for (const m of matched) {
    if (m.status !== 'unmatched' || isAccommodationOrGenericFee(m.serviceName)) {
      out.push(m);
      continue;
    }
    const srv = requestedServices.find((r) => r.name === m.serviceName) || { name: m.serviceName, rawPrice: 0 };
    let price: number | undefined;
    let from: string | undefined;
    for (const year of ['2026', '2025', '2024', '2023']) {
      try {
        const cands = await retrieveDynamicPricelistCandidates(year, [srv], undefined, 10);
        const top = cands.find(
          (c) =>
            c.score >= 35 &&
            (c.price || 0) > 0 &&
            !hasAntibodyConflict(srv.name, c.nameEnglish || '') &&
            !hasLabInvestigationConflict(srv.name, c.nameEnglish || '')
        );
        if (top) {
          price = Number(top.price);
          from = top.nameArabic ? `${top.nameArabic} (${top.nameEnglish})` : top.nameEnglish;
          break;
        }
      } catch {
        /* try next pricelist */
      }
    }
    if (!price && srv.rawPrice && srv.rawPrice > 0) price = srv.rawPrice;
    out.push({ ...m, suggestedPrice: price, suggestedFrom: from });
  }
  return out;
}
