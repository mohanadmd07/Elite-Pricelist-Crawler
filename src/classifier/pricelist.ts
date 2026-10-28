/**
 * Price data access for the classifier.
 *
 * Data model (verified in Phase 0): an insurer's "contractor pricelist" is the hospital
 * master list of its contract year (2023-2026) with a contract discount %. Contract
 * price = list price × (1 − discount%), computed with the existing
 * lib/pricing-calculator.calculateDiscountedPrice (no rounding). Tier 2 is the 2026
 * gross list. Prices ONLY ever come from these rows; the model never sees or sets them.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { calculateDiscountedPrice } from '../lib/pricing-calculator';
import { normalizeArabic } from '../lib/arabic-normalizer';
import type { PriceRow } from './types';

export interface PricelistProvider {
  loadRows(year: number): Promise<PriceRow[]>;
}

export interface ContractInfo {
  insurerId: string;
  year: number;
  discountPercent: number;
  pricelistId: string;
  source: 'contractor_pricelist_map' | 'companies' | 'contractors.json' | 'static';
}

export interface ContractResolver {
  resolve(insurerKey: string, at?: Date): Promise<ContractInfo | null>;
}

const PACKAGE_RE = /package|باكدج|باقة|باكج|packages/i;

/** Default provider: reuses procedureService.getCashData (server fs, with its own fallbacks). */
export class CashDataPricelistProvider implements PricelistProvider {
  private cache = new Map<number, PriceRow[]>();
  async loadRows(year: number): Promise<PriceRow[]> {
    const hit = this.cache.get(year);
    if (hit) return hit;
    const { getCashData } = await import('../services/procedureService');
    const raw = await getCashData(String(year) as any);
    const rows = rowsFromCash(raw as any[], year);
    this.cache.set(year, rows);
    return rows;
  }
}

export function rowsFromCash(
  raw: Array<{ nameEnglish?: string; nameArabic?: string; price?: string | number; sectionName?: string; code?: string | null; sourceFile?: string }>,
  year: number
): PriceRow[] {
  const sig = createHash('sha1').update(JSON.stringify(raw.map((r) => [r.code, r.nameEnglish, r.price]))).digest('hex').slice(0, 10);
  const version = `${raw.find((r) => r.sourceFile)?.sourceFile ?? `Elite Hospital ${year}`}#${sig}`;
  const rows: PriceRow[] = [];
  for (const r of raw) {
    const price = parsePrice(r.price);
    if (price === null || !(r.nameEnglish || r.nameArabic)) continue;
    const isPkg = PACKAGE_RE.test(`${r.nameEnglish ?? ''} ${r.nameArabic ?? ''} ${r.sectionName ?? ''}`);
    rows.push({
      code: r.code ?? null,
      nameEn: (r.nameEnglish ?? '').trim(),
      nameAr: (r.nameArabic ?? '').trim(),
      price,
      section: r.sectionName ?? null,
      year,
      pricelistId: `cash-${year}`,
      pricelistVersion: version,
      isPackage: isPkg,
      packageId: isPkg ? (r.code ?? r.nameEnglish ?? null) : null,
    });
  }
  return rows;
}

export function parsePrice(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Exact contract price: list × (1 − discount). Reuses the existing calculator; no rounding. */
export function contractPrice(listPrice: number, discountPercent: number): number {
  if (listPrice === 0 || discountPercent === 0) return listPrice;
  const r = calculateDiscountedPrice(String(listPrice), discountPercent);
  if (!r) throw new Error(`Cannot compute contract price for list price ${listPrice}`);
  return Number(r.discounted.toPrecision(12)); // strips float noise only
}

/**
 * The 2026 list's "General rules" sheet (القواعد العامة) states that some services take NO
 * contract discount: service fees, ambulance, blood bank, prosthetics/consumables/medical
 * supplies, speech rehab, special genetic/immunology labs, etc. Only the unambiguous cases
 * that are identifiable from section/name are exempted here; everything else gets the
 * insurer's discount. REVIEW with Corporate Sales (see SKILL.md → Assumptions).
 */
const EXEMPT_SECTIONS = new Set(['ambulance', 'medical devices']);
const EXEMPT_NAME_RE = /ambulance|اسعاف|إسعاف|blood bank|بنك الدم|prosthe|تركيبات|consumable|مستلزم|speech|تخاطب|service fee|رسوم الخدمه|رسوم الخدمة/i;

export function isDiscountExempt(row: Pick<PriceRow, 'section' | 'nameEn' | 'nameAr'>): boolean {
  if (row.section && EXEMPT_SECTIONS.has(row.section.trim().toLowerCase())) return true;
  return EXEMPT_NAME_RE.test(`${row.nameEn} ${row.nameAr}`);
}

export function contractLinePrice(row: PriceRow, discountPercent: number): { unit: number; discountApplied: number; exempt: boolean } {
  if (isDiscountExempt(row)) return { unit: row.price, discountApplied: 0, exempt: true };
  return { unit: contractPrice(row.price, discountPercent), discountApplied: discountPercent, exempt: false };
}

/** Removes floating-point noise (0.1*3) without rounding any real digit. */
export function mul(a: number, b: number): number {
  return Number((a * b).toPrecision(12));
}
export function add(a: number, b: number): number {
  return Number((a + b).toPrecision(12));
}

// --------------------------------------------------------- contract resolver -

export interface ContractorRecord {
  id?: string;
  name: string;
  aliases?: string[];
  priceListYear?: string | number | null;
  discountPercentage?: number | null;
}

/** Valid master list years. Anything else (e.g. a legacy "متوقف" marker) is unmapped. */
const VALID_YEARS = new Set([2023, 2024, 2025, 2026]);

export class StaticContractResolver implements ContractResolver {
  constructor(
    private contractors: ContractorRecord[],
    private source: ContractInfo['source'] = 'static'
  ) {}
  async resolve(insurerKey: string): Promise<ContractInfo | null> {
    const key = normalizeArabic(insurerKey || '');
    if (!key) return null;
    const rec =
      this.contractors.find((c) => [c.id, c.name, ...(c.aliases || [])].some((n) => n && normalizeArabic(String(n)) === key)) ?? null;
    if (!rec) return null;
    let year = Number(rec.priceListYear);
    if (!VALID_YEARS.has(year)) {
      year = 2026;
    }
    const discount =
      rec.discountPercentage !== null && rec.discountPercentage !== undefined && !Number.isNaN(Number(rec.discountPercentage))
        ? Number(rec.discountPercentage)
        : 0;
    return {
      insurerId: rec.id || rec.name,
      year,
      discountPercent: discount,
      pricelistId: `cash-${year}`,
      source: this.source,
    };
  }
}

/** Layered resolver: contractor_pricelist_map (Supabase) → companies → data/contractors.json. */
export class DefaultContractResolver implements ContractResolver {
  private fallback: StaticContractResolver | null = null;

  async resolve(insurerKey: string, at: Date = new Date()): Promise<ContractInfo | null> {
    const mapped = await this.fromMap(insurerKey, at);
    if (mapped) return mapped;
    if (!this.fallback) this.fallback = new StaticContractResolver(await this.loadContractors(), 'contractors.json');
    return this.fallback.resolve(insurerKey);
  }

  private async fromMap(insurerKey: string, at: Date): Promise<ContractInfo | null> {
    try {
      const { supabaseAdmin } = await import('../lib/supabase');
      if (!supabaseAdmin) return null;
      const day = at.toISOString().slice(0, 10);
      const { data } = await supabaseAdmin
        .from('contractor_pricelist_map')
        .select('insurer_id, discount_percent, valid_from, valid_to, pricelists(year)')
        .eq('insurer_id', insurerKey)
        .order('valid_from', { ascending: false, nullsFirst: false });
      const row = (data || []).find(
        (r: any) => (!r.valid_from || r.valid_from <= day) && (!r.valid_to || r.valid_to >= day)
      ) as any;
      const year = Number(row?.pricelists?.year);
      if (!row || !VALID_YEARS.has(year)) return null;
      return {
        insurerId: row.insurer_id,
        year,
        discountPercent: Number(row.discount_percent),
        pricelistId: `cash-${year}`,
        source: 'contractor_pricelist_map',
      };
    } catch {
      return null;
    }
  }

  private async loadContractors(): Promise<ContractorRecord[]> {
    let baseList: ContractorRecord[] = [];
    try {
      const p = path.resolve(process.cwd(), 'data', 'contractors.json');
      if (fs.existsSync(p)) {
        baseList = JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch {}

    // Supabase `companies` (cloud) updates / overrides
    try {
      const { supabaseAdmin } = await import('../lib/supabase');
      if (supabaseAdmin) {
        const { data } = await supabaseAdmin.from('companies').select('name, price_list_year, discount_percentage');
        if (data?.length) {
          const cloudMap = new Map(data.map((c: any) => [c.name, c]));
          for (const item of baseList) {
            const cloudMatch = cloudMap.get(item.name);
            if (cloudMatch) {
              if (cloudMatch.price_list_year) item.priceListYear = cloudMatch.price_list_year;
              if (cloudMatch.discount_percentage !== undefined && cloudMatch.discount_percentage !== null) {
                item.discountPercentage = Number(cloudMatch.discount_percentage);
              }
            }
          }
          // Also include any cloud companies not yet in contractors.json
          const existingNames = new Set(baseList.map((b) => b.name));
          for (const c of data) {
            if (!existingNames.has((c as any).name)) {
              baseList.push({
                name: (c as any).name,
                priceListYear: (c as any).price_list_year,
                discountPercentage: Number((c as any).discount_percentage),
              });
            }
          }
        }
      }
    } catch {
      /* fall through */
    }
    return baseList;
  }
}
