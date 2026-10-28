/**
 * Pass 5: two-tier pricing, code only.
 *   Tier 1 – insurer's contractor list (its contract-year hospital list × (1 − discount)).
 *   Tier 2 – 2026 hospital list at the GROSS price, labeled "موافقة سعرية".
 *   Neither – NOT_FOUND (human review).
 *   NEEDS_REVIEW is never auto-priced and never falls back to Tier 2.
 * Prices are read from PriceRow objects loaded from the DB/pricelists; the model never
 * supplies or sees a price.
 */
import { checkPackageInclusion, matchItemCoverage, type CoverageDeps } from './coverage';
import { add, contractLinePrice, mul, type ContractInfo } from './pricelist';
import type { CoverageDecision, LedgerItem, PriceRow, PricedLine, Candidate } from './types';

export interface PricingInput {
  items: LedgerItem[];
  contract: ContractInfo | null;
  contractRows: PriceRow[];
  list2026Rows: PriceRow[];
  deps: CoverageDeps;
}

export interface PricingOutput {
  coverage: CoverageDecision[];
  coverage2026: CoverageDecision[];
  priced: PricedLine[];
  contract_total: number;
  price_approval_total: number;
  resolved_total: number;
  contractor_pricelist_id: string | null;
  flags: string[];
}

const isRejected = (i: LedgerItem) => i.decision === 'REJECTED';

export function quantityFor(i: LedgerItem): number {
  const approvedish = i.decision === 'APPROVED' || i.decision === 'CONDITIONAL';
  const q = approvedish ? i.quantity_approved ?? i.quantity_requested : i.quantity_requested ?? i.quantity_approved;
  return q !== null && q !== undefined && q > 0 ? q : 1;
}

const base = (i: LedgerItem, idx: number, cov?: CoverageDecision) => ({
  item: i.text_original,
  canonical_en: i.canonical_en ?? cov?.canonicalEn ?? null,
  item_index: idx,
  qty: quantityFor(i),
});

function reviewCandidates(cands: Candidate[], contract: ContractInfo | null, tier: 'CONTRACT' | 'LIST') {
  return cands.slice(0, 5).map((c) => ({
    code: c.row.code,
    name_en: c.row.nameEn,
    name_ar: c.row.nameAr,
    contract_price: tier === 'CONTRACT' && contract ? contractLinePrice(c.row, contract.discountPercent).unit : c.row.price,
    score: c.score,
  }));
}

export async function priceItems(input: PricingInput): Promise<PricingOutput> {
  const { items, contract, contractRows, list2026Rows, deps } = input;
  const flags: string[] = [];
  const priced: PricedLine[] = [];

  if (!contract) {
    flags.push('NO_PRICELIST_MAPPING');
    items.forEach((i, idx) =>
      priced.push({
        ...base(i, idx),
        unit_price: null,
        line_total: null,
        price_source: 'NO_MAPPING',
        pricelist_id: null,
        pricelist_version: null,
        matched_code: null,
        match_class: null,
        match_score: null,
        note: 'Insurer has no pricelist mapping; not priced.',
      })
    );
    return { coverage: [], coverage2026: [], priced, contract_total: 0, price_approval_total: 0, resolved_total: 0, contractor_pricelist_id: null, flags };
  }

  // Tier-1 coverage for every item (rejected ones only for reference).
  const coverage: CoverageDecision[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    coverage.push(await matchItemCoverage(items[idx], idx, contractRows, deps));
  }

  const coverage2026: CoverageDecision[] = [];
  let contract_total = 0;
  let price_approval_total = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const i = items[idx];
    const cov = coverage[idx];
    const b = base(i, idx, cov);
    const empty = { unit_price: null, line_total: null, pricelist_id: null, pricelist_version: null, matched_code: null, match_class: cov.matchClass, match_score: cov.chosen?.score ?? null };

    // 7. Rejected: never priced for approval; contractor price kept for reference only.
    if (isRejected(i)) {
      priced.push({
        ...b,
        ...empty,
        price_source: 'REJECTED_REFERENCE',
        reference_contract_price: cov.result === 'COVERED' && cov.chosen ? contractLinePrice(cov.chosen.row, contract.discountPercent).unit : null,
        note: 'Rejected item: not priced for price approval.',
      });
      continue;
    }

    // 6. Package inclusion: price once; included ancillary items are not priced separately.
    const pk = checkPackageInclusion(i, idx, coverage);
    if (pk.kind === 'INCLUDED') {
      priced.push({ ...b, ...empty, price_source: 'INCLUDED_IN_PACKAGE', matched_code: pk.packageCode, note: `Included in package "${pk.packageName}".` });
      continue;
    }
    if (pk.kind === 'UNKNOWN_PACKAGE') {
      flags.push(`PACKAGE_INCLUSION_UNKNOWN:${i.text_original}`);
      priced.push({ ...b, ...empty, price_source: 'NEEDS_REVIEW', note: `Package "${pk.packageName}" inclusions unknown.`, review_candidates: reviewCandidates(cov.candidates, contract, 'CONTRACT') });
      continue;
    }
    if (pk.kind === 'OUTSIDE_PACKAGE' || pk.kind === 'PACKAGE_EXCLUDES') flags.push(`ANCILLARY_OUTSIDE_PACKAGE:${i.text_original}`);

    if (cov.result === 'COVERED' && cov.chosen) {
      const row = cov.chosen.row;
      const lp = contractLinePrice(row, contract.discountPercent);
      const line_total = mul(lp.unit, b.qty);
      contract_total = add(contract_total, line_total);
      priced.push({
        ...b,
        unit_price: lp.unit,
        line_total,
        price_source: 'CONTRACT',
        pricelist_id: row.pricelistId,
        pricelist_version: row.pricelistVersion,
        matched_code: row.code,
        matched_name_en: row.nameEn,
        matched_name_ar: row.nameAr,
        match_class: cov.matchClass,
        match_score: cov.chosen.score,
        list_price: row.price,
        discount_percent: lp.discountApplied,
        ...(lp.exempt ? { note: 'Service is exempt from contract discount (list price).' } : {}),
      });
      continue;
    }

    if (cov.result === 'NEEDS_REVIEW') {
      flags.push(`NEEDS_REVIEW:${i.text_original}`);
      priced.push({ ...b, ...empty, price_source: 'NEEDS_REVIEW', review_candidates: reviewCandidates(cov.candidates, contract, 'CONTRACT'), note: cov.guardOverride || cov.rationale });
      continue;
    }

    // NOT_COVERED → Tier 2 (2026 gross). If the contract list IS the 2026 list there is nothing new to find.
    if (contract.year === 2026) {
      flags.push(`NOT_FOUND:${i.text_original}`);
      priced.push({ ...b, ...empty, price_source: 'NOT_FOUND', note: 'Not in contractor list (2026) and no other list to fall back to.' });
      continue;
    }
    const cov26 = await matchItemCoverage(i, idx, list2026Rows, deps);
    coverage2026.push(cov26);
    if (cov26.result === 'COVERED' && cov26.chosen) {
      const row = cov26.chosen.row;
      const unit = row.price; // gross: no discount, markup, VAT adjustment or rounding
      const line_total = mul(unit, b.qty);
      price_approval_total = add(price_approval_total, line_total);
      priced.push({
        ...b,
        unit_price: unit,
        line_total,
        price_source: 'LIST_2026_PRICE_APPROVAL',
        pricelist_id: row.pricelistId,
        pricelist_version: row.pricelistVersion,
        matched_code: row.code,
        matched_name_en: row.nameEn,
        matched_name_ar: row.nameAr,
        match_class: cov26.matchClass,
        match_score: cov26.chosen.score,
        list_price: row.price,
        discount_percent: 0,
      });
    } else if (cov26.result === 'NEEDS_REVIEW') {
      flags.push(`NEEDS_REVIEW_2026:${i.text_original}`);
      priced.push({ ...b, ...empty, price_source: 'NEEDS_REVIEW', review_candidates: reviewCandidates(cov26.candidates, contract, 'LIST'), note: `2026 list: ${cov26.guardOverride || cov26.rationale}` });
    } else {
      flags.push(`NOT_FOUND:${i.text_original}`);
      priced.push({ ...b, ...empty, price_source: 'NOT_FOUND', note: 'Not found in contractor list or 2026 list.' });
    }
  }

  return {
    coverage,
    coverage2026,
    priced,
    contract_total,
    price_approval_total,
    resolved_total: add(contract_total, price_approval_total),
    contractor_pricelist_id: contractRows[0]?.pricelistId ?? contract.pricelistId,
    flags,
  };
}
