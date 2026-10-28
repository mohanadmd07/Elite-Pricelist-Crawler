/**
 * Medical glossary: alias / abbreviation / Franco-Arabic normalization and the
 * clinical attribute extractor used by the coverage guard.
 *
 * The glossary file is seeded by .agent/skills/approval-reply-classifier/scripts/build-glossary.ts
 * and MUST be reviewed by a clinician before use (see SKILL.md).
 */
import glossaryJson from '../../.agent/skills/approval-reply-classifier/resources/medical-glossary.json';
import { normalizeArabicLight } from './text';

export type Approach = 'laparoscopic' | 'open' | 'endoscopic' | 'percutaneous' | 'robotic' | null;
export type Contrast = 'with' | 'without' | null;
export type Laterality = 'left' | 'right' | 'bilateral' | null;

export interface GlossaryEntry {
  canonical_en: string;
  aliases: string[];
  category: string;
  code: string | null;
  laterality: Laterality;
  approach: Approach;
  contrast: Contrast;
  /** optional extra discriminators (e.g. mesh / no-mesh, implant type) */
  tags?: string[];
}

export interface ClinicalAttributes {
  approach: Approach;
  contrast: Contrast;
  laterality: Laterality;
  mesh: 'with' | 'without' | null;
  /** body region tokens, used for the anatomical-site guard */
  site: string[];
  implant: string | null;
}

/** key used for alias matching: lower-case, Arabic-light normalized, punctuation→space */
export function aliasKey(s: string): string {
  return normalizeArabicLight(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0621-\u064A\s+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SITE_TOKENS: Array<[string, RegExp]> = [
  ['brain', /\b(brain|head|cerebral|cranial)\b|مخ|الرأس|راس|جمجمه/],
  ['chest', /\b(chest|thorax|thoracic|lung)\b|صدر|رئه/],
  ['abdomen', /\b(abdomen|abdominal|abdo|pelvis|pelvic)\b|بطن|حوض/],
  ['spine', /\b(spine|spinal|lumbar|cervical|dorsal)\b|عمود|فقري|قطني|عنق/],
  ['knee', /\bknee\b|ركبه/],
  ['hip', /\bhip\b|ورك|مفصل الفخذ/],
  ['shoulder', /\bshoulder\b|كتف/],
  ['kidney', /\b(kidney|renal|ureter|urinary)\b|كلي|حالب/],
  ['heart', /\b(heart|cardiac|coronary)\b|قلب|تاجي/],
  ['neck', /\bneck\b|رقبه/],
  ['gallbladder', /\b(gallbladder|cholecyst)\w*|مراره/],
  ['appendix', /\bappend\w*|زايده/],
  ['hernia', /\bherni\w*|فتق/],
];

export function extractAttributes(text: string): ClinicalAttributes {
  const t = aliasKey(text);
  const has = (re: RegExp) => re.test(t);
  let approach: Approach = null;
  if (has(/laparoscop|\blap\b|بالمنظار|منظار البطن|لابروسكوب/)) approach = 'laparoscopic';
  else if (has(/robotic|روبوت/)) approach = 'robotic';
  else if (has(/endoscop|ureteroscop|cystoscop|منظار/)) approach = 'endoscopic';
  else if (has(/percutaneous|\bpercut\b|عبر الجلد/)) approach = 'percutaneous';
  else if (has(/\bopen\b|مفتوح|جراحه مفتوحه|تقليدي/)) approach = 'open';

  let contrast: Contrast = null;
  if (has(/without contrast|\bnon[\s-]?contrast|plain\b|w\/o contrast|بدون صبغ|بدون ظلل|بدون حقن/)) contrast = 'without';
  else if (has(/with contrast|\bwith dye|contrast enhanced|\bc\+|w\/ contrast|بالصبغ|بصبغ|مع صبغ|بالظلل|مع ظلل|بالحقن/)) contrast = 'with';
  else if (has(/\bcontrast\b|صبغ/)) contrast = 'with';

  let laterality: Laterality = null;
  if (has(/bilateral|both sides|\bbil\b|الجانبين|جانبين|الطرفين/)) laterality = 'bilateral';
  else if (has(/\bleft\b|\blt\b|يسار|اليسري|الايسر/)) laterality = 'left';
  else if (has(/\bright\b|\brt\b|يمين|اليمني|الايمن/)) laterality = 'right';

  let mesh: 'with' | 'without' | null = null;
  if (has(/without mesh|no mesh|بدون شبك|بدون ميش/)) mesh = 'without';
  else if (has(/with mesh|mesh repair|بشبك|بالشبك|ميش|شبكه/)) mesh = 'with';

  const site = SITE_TOKENS.filter(([, re]) => re.test(t)).map(([k]) => k);

  let implant: string | null = null;
  const imp = t.match(/\b(des|drug eluting|bare metal|bms|titanium|cemented|uncemented|ceramic|plate|nail|screw|mesh|stent|pacemaker|icd|lens|iol)\b/);
  if (imp) implant = imp[1];

  return { approach, contrast, laterality, mesh, site, implant };
}

let _entries: GlossaryEntry[] = (glossaryJson as any).entries ?? (glossaryJson as any);
let _index: Map<string, GlossaryEntry> | null = null;
/** APPROVED learned ALIAS rules are layered on at runtime (never PROPOSED/REJECTED/RETIRED). */
let _extraAliases: Array<{ alias: string; canonical_en: string }> = [];

function buildIndex(): Map<string, GlossaryEntry> {
  const idx = new Map<string, GlossaryEntry>();
  for (const e of _entries) {
    for (const a of [e.canonical_en, ...(e.aliases || [])]) {
      const k = aliasKey(a);
      if (k && !idx.has(k)) idx.set(k, e);
    }
  }
  for (const x of _extraAliases) {
    const e = _entries.find((g) => g.canonical_en === x.canonical_en);
    const k = aliasKey(x.alias);
    if (e && k && !idx.has(k)) idx.set(k, e);
  }
  return idx;
}

export function setGlossary(entries: GlossaryEntry[]): void {
  _entries = entries;
  _index = null;
}
export function setApprovedAliasRules(rules: Array<{ alias: string; canonical_en: string }>): void {
  _extraAliases = rules;
  _index = null;
}
export function getGlossaryEntries(): GlossaryEntry[] {
  return _entries;
}

export interface NormalizedItem {
  original: string;
  canonical_en: string | null;
  entry: GlossaryEntry | null;
  attributes: ClinicalAttributes;
  /** how the alias was found */
  via: 'ALIAS' | 'CONTAINED_ALIAS' | 'NONE';
}

/** Normalizes a free-text item through the glossary (aliases, abbreviations, Franco-Arabic). */
export function normalizeItem(text: string): NormalizedItem {
  if (!_index) _index = buildIndex();
  const key = aliasKey(text);
  const attrs = extractAttributes(text);
  const direct = _index.get(key);
  if (direct) return { original: text, canonical_en: direct.canonical_en, entry: direct, attributes: mergeAttrs(attrs, direct), via: 'ALIAS' };

  // longest alias contained in the text (word-boundary aware, ≥3 chars, ignores 1-2 letter abbreviations unless exact)
  let best: { k: string; e: GlossaryEntry } | null = null;
  const padded = ` ${key} `;
  for (const [k, e] of _index) {
    if (k.length < 3) continue;
    if (padded.includes(` ${k} `) && (!best || k.length > best.k.length)) best = { k, e };
  }
  if (best) {
    // the text's own explicit attributes win over the entry's when they conflict, so a
    // qualified phrase ("open appendectomy") is never silently coerced.
    return { original: text, canonical_en: best.e.canonical_en, entry: best.e, attributes: mergeAttrs(attrs, best.e, true), via: 'CONTAINED_ALIAS' };
  }
  return { original: text, canonical_en: null, entry: null, attributes: attrs, via: 'NONE' };
}

function mergeAttrs(own: ClinicalAttributes, e: GlossaryEntry, ownWins = false): ClinicalAttributes {
  const pick = <T>(a: T | null, b: T | null) => (ownWins ? a ?? b : b ?? a);
  return {
    ...own,
    approach: pick(own.approach, e.approach),
    contrast: pick(own.contrast, e.contrast),
    laterality: pick(own.laterality, e.laterality),
  };
}

/**
 * Hard clinical-difference check used as a guard AFTER the model adjudicates.
 * Returns a reason string when the two descriptions cannot be the same service.
 */
export function clinicalConflict(a: ClinicalAttributes, b: ClinicalAttributes): string | null {
  if (a.approach && b.approach && a.approach !== b.approach) return `approach ${a.approach} vs ${b.approach}`;
  if (a.contrast && b.contrast && a.contrast !== b.contrast) return `contrast ${a.contrast} vs ${b.contrast}`;
  if (a.laterality && b.laterality && a.laterality !== b.laterality) return `laterality ${a.laterality} vs ${b.laterality}`;
  if (a.mesh && b.mesh && a.mesh !== b.mesh) return `mesh ${a.mesh} vs ${b.mesh}`;
  if (a.site.length && b.site.length && !a.site.some((s) => b.site.includes(s))) return `site ${a.site.join('/')} vs ${b.site.join('/')}`;
  if (a.implant && b.implant && a.implant !== b.implant) return `implant ${a.implant} vs ${b.implant}`;
  return null;
}
