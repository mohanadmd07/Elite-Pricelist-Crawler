import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

export interface OfficerInfo {
  name: string;
  columnHeader: string;
  phone?: string;
}

export interface ContractorOfficerMapping {
  rawName: string;
  canonicalName: string;
  normalizedTokens: string[];
  officer: OfficerInfo;
  aliases: string[];
}

export interface OfficerResolutionResult {
  matched: boolean;
  officerName: string;
  officerPhone?: string;
  contractorNormalized: string;
  confidenceScore: number;
  matchType: 'exact' | 'alias' | 'token_overlap' | 'substring' | 'unmatched';
}

const OFFICER_DISPLAY_NAMES: Record<string, string> = {
  'زياد': 'زياد',
  'نادين': 'نادين',
  'ابو الوفا': 'محمد ابو الوفا',
  'ديانا': 'ديانا',
  'جابر': 'محمد جابر',
  'حمزة': 'أحمد حمزة',
  'طارق': 'طارق',
};

const STOP_WORDS = new Set([
  'شركه',
  'شركة',
  'فحص',
  'كاش',
  'cash',
  'co',
  'company',
  'مجموعه',
  'مجموعة',
  'group',
  'egypt',
  'مصر',
  'للتامين',
  'للتأمين',
  'للتامينات',
  'للتأمينات',
  'للبترول',
  'بترول',
  'للرعاية',
  'للخدمات',
  'الطبية',
  'الصحية',
]);

// Known English <-> Arabic common transliterations in Egyptian insurance market
const TRANSLITERATION_PAIRS: Record<string, string[]> = {
  'globemed': ['جلوب ميد', 'جلوبميد'],
  'enayatisr': ['عنايه مصر', 'عناية مصر'],
  'gasco': ['جاسكو'],
  'alico': ['اليكو', 'ميتلايف اليكو', 'metlife'],
  'mednet': ['ميدنت', 'ميد نت'],
  'medright': ['ميدرايت', 'ميد رايت', 'med right'],
  'axa': ['اكسا', 'أكسا'],
  'gig': ['جي اي جي', 'gig egypt'],
  'dms': ['الماسية', 'الماسيه'],
  'nextcare': ['نكست كير', 'نيكست كير', 'next care'],
  'wepco': ['ويبكو'],
  'petromaint': ['بترومنت'],
  'ethydco': ['ايثدكو', 'اثيدكو'],
  'sidpec': ['سيدبك'],
  'amoc': ['اموك'],
  'eprom': ['ايبروم'],
  'gupco': ['جابكو'],
  'bapetco': ['بدر الدين للبترول', 'بدر الدين'],
};

/**
 * Normalizes text for robust Arabic and English matching
 */
export function normalizeContractorText(text: string): string {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u200e\u200f\u00a0]/g, '') // strip diacritics, tatweel, direction marks
    .replace(/[ـ]/g, '') // strip tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/[^\u0600-\u06FFa-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenizes text, stripping Arabic definite article "ال" and common stopwords
 */
export function getContractorTokens(text: string): string[] {
  const norm = normalizeContractorText(text);
  if (!norm) return [];
  return norm
    .split(' ')
    .map((t) => t.replace(/^ال(?=.{3,})/, '')) // strip leading "ال" only if token is at least 3 chars long
    .filter((t) => t && !STOP_WORDS.has(t));
}

// In-memory cache with file mtime detection
let cachedMappings: ContractorOfficerMapping[] = [];
let cachedOfficers: Record<string, OfficerInfo> = {};
let lastExcelMtime = 0;
let lastExcelPath = '';

/**
 * Loads and caches contractor-to-officer mappings from contacts_table.xlsx
 */
export function loadContractorOfficersFromExcel(
  excelPath: string = path.resolve(process.cwd(), 'contacts_table.xlsx')
): ContractorOfficerMapping[] {
  try {
    if (!fs.existsSync(excelPath)) {
      console.warn(`[ContractorResolver] Excel file not found at ${excelPath}. Using fallback cache.`);
      return cachedMappings;
    }

    const stat = fs.statSync(excelPath);
    if (stat.mtimeMs === lastExcelMtime && excelPath === lastExcelPath && cachedMappings.length > 0) {
      return cachedMappings;
    }

    console.log(`[ContractorResolver] Reading latest contractor officers from ${excelPath}...`);
    const fileBuffer = fs.readFileSync(excelPath);
    const readFn = (XLSX as any).read || (XLSX as any).default?.read;
    const utils = (XLSX as any).utils || (XLSX as any).default?.utils;
    const wb = readFn(fileBuffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.includes('Contacts') ? 'Contacts' : wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = utils.sheet_to_json(sheet, { header: 1 }) as any[][];

    if (!rows || rows.length < 2) {
      console.warn('[ContractorResolver] Invalid or empty sheet format in Excel file.');
      return cachedMappings;
    }

    const headerRow = rows[0];
    const phoneRow = rows.find((r) => r.some((c) => String(c).includes('+20')));

    const officerCols: Array<{ colIdx: number; header: string; officer: OfficerInfo }> = [];
    const officersMap: Record<string, OfficerInfo> = {};

    for (let c = 1; c < headerRow.length; c++) {
      const rawHeader = String(headerRow[c] || '').trim();
      if (!rawHeader) continue;

      const normHeader = normalizeContractorText(rawHeader);
      let officerKey = Object.keys(OFFICER_DISPLAY_NAMES).find(
        (k) => normalizeContractorText(k) === normHeader
      ) || rawHeader;

      const displayName = OFFICER_DISPLAY_NAMES[officerKey] || rawHeader;
      const phone = phoneRow && phoneRow[c] ? String(phoneRow[c]).trim() : undefined;

      const info: OfficerInfo = {
        name: displayName,
        columnHeader: rawHeader,
        phone,
      };

      officerCols.push({ colIdx: c, header: rawHeader, officer: info });
      officersMap[displayName] = info;
    }

    const mappings: ContractorOfficerMapping[] = [];

    // Parse contractor rows (skip header row 0 and phone row)
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row === phoneRow) continue;

      for (const col of officerCols) {
        const cellValue = row[col.colIdx];
        if (!cellValue) continue;

        const rawName = String(cellValue).trim();
        if (!rawName || rawName.startsWith('+20') || rawName.length < 2) continue;

        const normTokens = getContractorTokens(rawName);
        if (normTokens.length === 0 && normalizeContractorText(rawName).length === 0) continue;

        // Extract aliases if cell contains parentheses, e.g. "شركة بترول الصحراء الغربيه (wepco)"
        const aliases = [rawName];
        const parenMatch = rawName.match(/\(([^)]+)\)/);
        if (parenMatch && parenMatch[1]) {
          aliases.push(parenMatch[1].trim());
        }
        const cleanedWithoutParen = rawName.replace(/\([^)]+\)/g, '').trim();
        if (cleanedWithoutParen && cleanedWithoutParen !== rawName) {
          aliases.push(cleanedWithoutParen);
        }

        // Add transliteration equivalents
        const normRaw = normalizeContractorText(rawName);
        for (const [eng, arList] of Object.entries(TRANSLITERATION_PAIRS)) {
          if (normRaw.includes(eng) || arList.some((ar) => normRaw.includes(normalizeContractorText(ar)))) {
            aliases.push(eng);
            aliases.push(...arList);
          }
        }

        mappings.push({
          rawName,
          canonicalName: cleanedWithoutParen || rawName,
          normalizedTokens: normTokens,
          officer: col.officer,
          aliases,
        });
      }
    }

    // Merge complementary aliases and authoritative officer overrides from data/contractors.json
    try {
      const jsonPath = path.resolve(process.cwd(), 'data', 'contractors.json');
      if (fs.existsSync(jsonPath)) {
        const contractorsJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (Array.isArray(contractorsJson)) {
          for (const item of contractorsJson) {
            if (!item.name) continue;
            const itemAliases = Array.isArray(item.aliases) ? item.aliases : [item.name];
            // Find corresponding mapping
            const match = mappings.find(
              (m) =>
                normalizeContractorText(m.rawName) === normalizeContractorText(item.name) ||
                normalizeContractorText(m.canonicalName) === normalizeContractorText(item.name) ||
                m.aliases.some((a) => itemAliases.some((ia: string) => normalizeContractorText(a) === normalizeContractorText(ia)))
            );
            if (match) {
              match.canonicalName = item.name.trim();
              if (item.contractorOfficer && item.contractorOfficer.trim()) {
                match.officer = {
                  name: item.contractorOfficer.trim(),
                  phone: match.officer?.phone || '',
                };
              }
              for (const alias of itemAliases) {
                if (!match.aliases.includes(alias)) {
                  match.aliases.push(alias);
                }
              }
            } else {
              // Add company as first-class contractor mapping
              mappings.push({
                canonicalName: item.name.trim(),
                rawName: item.name.trim(),
                normalizedTokens: tokenizeContractorName(item.name),
                officer: {
                  name: item.contractorOfficer && item.contractorOfficer.trim() ? item.contractorOfficer.trim() : 'غير محدد',
                  phone: '',
                },
                aliases: Array.from(new Set([item.name.trim(), ...itemAliases])),
              });
            }
          }
        }
      }
    } catch (err) {
      // Non-fatal if contractors.json is absent
    }

    cachedMappings = mappings;
    cachedOfficers = officersMap;
    lastExcelMtime = stat.mtimeMs;
    lastExcelPath = excelPath;

    console.log(
      `[ContractorResolver] Loaded ${mappings.length} contractor mappings across ${officerCols.length} officers.`
    );
    return cachedMappings;
  } catch (err) {
    console.error('[ContractorResolver] Error reading contacts_table.xlsx:', err);
    return cachedMappings;
  }
}

/**
 * Manually invalidates in-memory resolver cache so subsequent lookups re-read latest data.
 */
export function invalidateContractorResolverCache(): void {
  cachedMappings = [];
  cachedOfficers = {};
  lastExcelMtime = 0;
  lastExcelPath = '';
}

/**
 * Computes Jaccard/Dice-like token overlap score between two token arrays
 */
function calculateTokenScore(queryTokens: string[], targetTokens: string[]): number {
  if (!queryTokens.length || !targetTokens.length) return 0;

  const setQ = new Set(queryTokens);
  const setT = new Set(targetTokens);

  let matches = 0;
  for (const q of setQ) {
    if (setT.has(q)) {
      matches += 1.0;
    } else {
      // Substring root match for long words (length > 3)
      for (const t of setT) {
        if (q.length > 3 && t.length > 3 && (q.startsWith(t) || t.startsWith(q))) {
          matches += 0.8;
          break;
        }
      }
    }
  }

  const precision = matches / setQ.size;
  const recall = matches / setT.size;
  if (precision === 0 || recall === 0) return 0;

  // Harmonic mean (F1 score)
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Resolves any raw contractor string (from email body, subject, or metadata)
 * to the exact responsible officer from contacts_table.xlsx
 */
export function resolveOfficerByContractor(
  rawQuery: string,
  excelPath?: string
): OfficerResolutionResult {
  if (!rawQuery || !rawQuery.trim()) {
    return {
      matched: false,
      officerName: 'غير محدد (يتطلب تحديد منسق السيلز)',
      contractorNormalized: 'غير محدد',
      confidenceScore: 0,
      matchType: 'unmatched',
    };
  }

  const mappings = loadContractorOfficersFromExcel(excelPath);
  if (!mappings.length) {
    return {
      matched: false,
      officerName: 'غير محدد (يتطلب تحديد منسق السيلز)',
      contractorNormalized: rawQuery.trim(),
      confidenceScore: 0,
      matchType: 'unmatched',
    };
  }

  const queryNorm = normalizeContractorText(rawQuery);
  const queryTokens = getContractorTokens(rawQuery);

  // 1. Direct exact alias match (100% confidence)
  for (const m of mappings) {
    for (const alias of m.aliases) {
      if (normalizeContractorText(alias) === queryNorm) {
        return {
          matched: true,
          officerName: m.officer.name,
          officerPhone: m.officer.phone,
          contractorNormalized: m.canonicalName,
          confidenceScore: 1.0,
          matchType: 'exact',
        };
      }
    }
  }

  // 2. Token Equality Match
  const queryTokenKey = queryTokens.join('');
  if (queryTokenKey) {
    for (const m of mappings) {
      if (m.normalizedTokens.join('') === queryTokenKey) {
        return {
          matched: true,
          officerName: m.officer.name,
          officerPhone: m.officer.phone,
          contractorNormalized: m.canonicalName,
          confidenceScore: 0.98,
          matchType: 'alias',
        };
      }
    }
  }

  // 3. Substring Containment Match
  for (const m of mappings) {
    for (const alias of m.aliases) {
      const aliasNorm = normalizeContractorText(alias);
      if (aliasNorm.length >= 4 && (queryNorm.includes(aliasNorm) || aliasNorm.includes(queryNorm))) {
        return {
          matched: true,
          officerName: m.officer.name,
          officerPhone: m.officer.phone,
          contractorNormalized: m.canonicalName,
          confidenceScore: 0.92,
          matchType: 'substring',
        };
      }
    }
  }

  // 4. Fuzzy Token Overlap
  let bestMapping: ContractorOfficerMapping | null = null;
  let bestScore = 0;

  for (const m of mappings) {
    const score = calculateTokenScore(queryTokens, m.normalizedTokens);
    if (score > bestScore) {
      bestScore = score;
      bestMapping = m;
    }
  }

  // Acceptance threshold: 0.65 for multi-word queries
  if (bestMapping && bestScore >= 0.65) {
    return {
      matched: true,
      officerName: bestMapping.officer.name,
      officerPhone: bestMapping.officer.phone,
      contractorNormalized: bestMapping.canonicalName,
      confidenceScore: Math.round(bestScore * 100) / 100,
      matchType: 'token_overlap',
    };
  }

  // Unmatched fallback
  return {
    matched: false,
    officerName: 'غير محدد (يتطلب تحديد منسق السيلز)',
    contractorNormalized: rawQuery.trim(),
    confidenceScore: bestScore ? Math.round(bestScore * 100) / 100 : 0,
    matchType: 'unmatched',
  };
}
