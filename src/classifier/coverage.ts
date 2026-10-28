/**
 * Pass 4: medical coverage matching.
 *   1. glossary normalization
 *   2. top-5 candidates from a pricelist (code → exact name → fuzzy)
 *   3. model adjudicates ONLY among those candidates
 *   4. code decides COVERED / NEEDS_REVIEW / NOT_COVERED, and hard guards can only make the
 *      result stricter (never promote a model answer)
 *   5. package-inclusion check for ancillary items
 */
import inclusionsJson from '../../.agent/skills/approval-reply-classifier/resources/package-inclusions.json';
import { aliasKey, clinicalConflict, extractAttributes, normalizeItem } from './glossary';
import type { Candidate, CoverageDecision, CoverageResult, LedgerItem, MatchClass, PriceRow } from './types';

export const FUZZY_AUTO_THRESHOLD = 0.9;

// ------------------------------------------------------------- retrieval ----

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0);
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return total ? (2 * inter) / total : 0;
}

function tokenF1(a: string, b: string): number {
  const A = new Set(a.split(' ').filter((t) => t.length > 1));
  const B = new Set(b.split(' ').filter((t) => t.length > 1));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const p = inter / A.size;
  const r = inter / B.size;
  return p + r ? (2 * p * r) / (p + r) : 0;
}

export function fuzzyScore(a: string, b: string): number {
  return Number((0.5 * dice(a, b) + 0.5 * tokenF1(a, b)).toFixed(4));
}

const codeKey = (c: string | null | undefined) => (c || '').toLowerCase().replace(/\s+/g, '');
const CODE_TOKEN_RE = /\b([a-z]{1,4}\.?\s?\d{1,6})\b/gi;

export type Retriever = (queries: string[], rows: PriceRow[], k?: number) => Candidate[];

export const retrieveCandidates: Retriever = (queries, rows, k = 5) => {
  const qs = [...new Set(queries.map(aliasKey).filter(Boolean))];
  const codes = new Set<string>();
  for (const q of queries) for (const m of (q || '').matchAll(CODE_TOKEN_RE)) codes.add(codeKey(m[1]));

  const best = new Map<PriceRow, Candidate>();
  const put = (row: PriceRow, score: number, via: Candidate['via']) => {
    const cur = best.get(row);
    if (!cur || score > cur.score) best.set(row, { row, score, via });
  };

  for (const row of rows) {
    if (row.code && codes.has(codeKey(row.code))) {
      put(row, 1, 'CODE');
      continue;
    }
    const en = aliasKey(row.nameEn);
    const ar = aliasKey(row.nameAr);
    for (const q of qs) {
      if (q === en || q === ar) {
        put(row, 1, 'EXACT_NAME');
        continue;
      }
      const s = Math.max(fuzzyScore(q, en), fuzzyScore(q, ar));
      if (s >= 0.35) put(row, s, 'FUZZY');
    }
  }
  const rank = (c: Candidate) => (c.via === 'CODE' ? 2 : c.via === 'EXACT_NAME' ? 1 : 0) * 10 + c.score;
  return [...best.values()].sort((a, b) => rank(b) - rank(a)).slice(0, k);
};

// ----------------------------------------------------------- adjudication ---

export interface Adjudication {
  chosen_index: number | null;
  match_class: MatchClass;
  rationale: string;
}

export interface Adjudicator {
  adjudicate(item: { text: string; canonical_en: string | null }, candidates: Candidate[]): Promise<Adjudication>;
}

const VALID_CLASSES: MatchClass[] = ['EXACT', 'EQUIVALENT_SYNONYM', 'BROADER', 'NARROWER', 'DIFFERENT'];

export function toResult(c: MatchClass | null): CoverageResult {
  if (c === 'EXACT' || c === 'EQUIVALENT_SYNONYM') return 'COVERED';
  if (c === 'BROADER' || c === 'NARROWER') return 'NEEDS_REVIEW';
  return 'NOT_COVERED';
}

export interface CoverageDeps {
  adjudicator: Adjudicator;
  retriever?: Retriever;
  fuzzyAutoThreshold?: number;
}

export async function matchItemCoverage(
  item: Pick<LedgerItem, 'text_original' | 'canonical_en'>,
  itemIndex: number,
  rows: PriceRow[],
  deps: CoverageDeps
): Promise<CoverageDecision> {
  const norm = normalizeItem(item.text_original);
  const canonical = item.canonical_en || norm.canonical_en;
  const queries = [item.text_original, canonical || '', ...(norm.entry?.aliases || [])].filter(Boolean);
  const retriever = deps.retriever ?? retrieveCandidates;
  const candidates = retriever(queries, rows, 5);
  const base = { itemIndex, itemText: item.text_original, canonicalEn: canonical ?? null, candidates };

  if (!candidates.length) {
    return { ...base, result: 'NOT_COVERED', matchClass: 'DIFFERENT', rationale: 'No candidate in pricelist', chosen: null };
  }

  const top = candidates[0];
  let adj: Adjudication;
  if (top.score === 1 && (top.via === 'CODE' || top.via === 'EXACT_NAME')) {
    adj = { chosen_index: 0, match_class: 'EXACT', rationale: `Exact ${top.via === 'CODE' ? 'code' : 'name'} match` };
  } else {
    try {
      adj = await deps.adjudicator.adjudicate({ text: item.text_original, canonical_en: canonical ?? null }, candidates);
    } catch (e: any) {
      return { ...base, result: 'NEEDS_REVIEW', matchClass: null, rationale: `Adjudicator failed: ${e?.message || e}`, chosen: null, guardOverride: 'ADJUDICATOR_ERROR' };
    }
  }

  // The model may only choose from the candidates it was shown; anything else is "no fit".
  const validIdx = Number.isInteger(adj.chosen_index) && adj.chosen_index! >= 0 && adj.chosen_index! < candidates.length;
  let matchClass: MatchClass = VALID_CLASSES.includes(adj.match_class) ? adj.match_class : 'DIFFERENT';
  let chosen: Candidate | null = validIdx ? candidates[adj.chosen_index as number] : null;
  let rationale = adj.rationale || '';
  let guardOverride: string | undefined;

  if (!chosen) {
    matchClass = 'DIFFERENT';
    chosen = null;
  }

  // Guard 1 (clinical): approach / laterality / contrast / site / implant mismatch ⇒ DIFFERENT.
  if (chosen && matchClass !== 'DIFFERENT') {
    const conflict = clinicalConflict(norm.attributes, extractAttributes(`${chosen.row.nameEn} ${chosen.row.nameAr}`));
    if (conflict) {
      guardOverride = `CLINICAL_CONFLICT: ${conflict}`;
      rationale = `${rationale} [overridden: ${conflict}]`.trim();
      matchClass = 'DIFFERENT';
      chosen = null;
    }
  }

  let result = toResult(matchClass);

  // Guard 2 (confidence): a fuzzy-only match below threshold can never be auto-COVERED.
  const thr = deps.fuzzyAutoThreshold ?? FUZZY_AUTO_THRESHOLD;
  if (chosen && result === 'COVERED' && chosen.via === 'FUZZY' && chosen.score < thr) {
    result = 'NEEDS_REVIEW';
    guardOverride = `FUZZY_BELOW_${thr}`;
  }

  return { ...base, result, matchClass, rationale, chosen, ...(guardOverride ? { guardOverride } : {}) };
}

// ---------------------------------------------------------- package logic ---

export type AncillaryType = 'anesthesia' | 'consumables' | 'nursing' | 'ward_stay';
const incl = inclusionsJson as {
  ancillary_types: Record<AncillaryType, string[]>;
  packages: Array<{ id: string; match: string[]; includes: AncillaryType[] }>;
};

export function ancillaryType(text: string): AncillaryType | null {
  const t = aliasKey(text);
  for (const [type, words] of Object.entries(incl.ancillary_types) as Array<[AncillaryType, string[]]>) {
    if (words.some((w) => t.includes(aliasKey(w)))) return type;
  }
  return null;
}

export type PackageVerdict =
  | { kind: 'NOT_ANCILLARY' }
  | { kind: 'INCLUDED'; packageCode: string | null; packageName: string }
  | { kind: 'OUTSIDE_PACKAGE' } // ancillary, no package in the request → normal flow, flagged
  | { kind: 'PACKAGE_EXCLUDES'; packageName: string } // known package that does not include it → normal flow, flagged
  | { kind: 'UNKNOWN_PACKAGE'; packageName: string }; // package whose rule we do not know → NEEDS_REVIEW

export function packageRuleFor(row: PriceRow): { id: string; includes: AncillaryType[] } | null {
  const hay = aliasKey(`${row.nameEn} ${row.nameAr}`);
  return incl.packages.find((p) => p.match.some((m) => hay.includes(aliasKey(m)))) ?? null;
}

export function checkPackageInclusion(item: Pick<LedgerItem, 'text_original'>, itemIndex: number, coverage: CoverageDecision[]): PackageVerdict {
  const type = ancillaryType(item.text_original);
  if (!type) return { kind: 'NOT_ANCILLARY' };
  const pkgs = coverage.filter((c) => c.itemIndex !== itemIndex && c.result === 'COVERED' && c.chosen?.row.isPackage);
  if (!pkgs.length) return { kind: 'OUTSIDE_PACKAGE' };
  let unknown: CoverageDecision | null = null;
  let excludes: CoverageDecision | null = null;
  for (const p of pkgs) {
    const rule = packageRuleFor(p.chosen!.row);
    if (!rule) unknown = unknown ?? p;
    else if (rule.includes.includes(type)) return { kind: 'INCLUDED', packageCode: p.chosen!.row.code, packageName: p.chosen!.row.nameEn };
    else excludes = excludes ?? p;
  }
  if (unknown) return { kind: 'UNKNOWN_PACKAGE', packageName: unknown.chosen!.row.nameEn };
  return { kind: 'PACKAGE_EXCLUDES', packageName: excludes!.chosen!.row.nameEn };
}
