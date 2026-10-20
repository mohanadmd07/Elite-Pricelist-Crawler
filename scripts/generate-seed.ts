/**
 * Seed Generator for Elite Pricelist Explorer
 * Extracts data from Consumables.xlsx, Sales 2027.xlsx, and cash json files,
 * and generates clean, executable PostgreSQL statements for supabase/seed.sql.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SEED_OUTPUT = path.resolve(ROOT_DIR, 'supabase', 'seed.sql');

function escapeSql(str: string): string {
  if (!str) return "''";
  return `'${str.replace(/'/g, "''").trim()}'`;
}

function normalizeArabicForSearch(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىيی]/g, 'ي')
    .replace(/[كک]/g, 'ك')
    .replace(/[ةهھ]/g, 'ه')
    .replace(/[ئؤ]/g, 'ء')
    .replace(/[^a-z0-9\u0621-\u064A\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function run() {
  console.log('Generating seed.sql from local Excel and JSON files...');

  const statements: string[] = [
    '-- Auto-generated Seed Data for Elite Pricelist Explorer',
    '-- Generated on: ' + new Date().toISOString(),
    '',
    '-- Insert Master Pricelists',
    `INSERT INTO public.pricelists (year, title, is_active) VALUES (2023, 'Elite Hospital 2023', true) ON CONFLICT (year) DO NOTHING;`,
    `INSERT INTO public.pricelists (year, title, is_active) VALUES (2024, 'Elite Hospital 2024', true) ON CONFLICT (year) DO NOTHING;`,
    `INSERT INTO public.pricelists (year, title, is_active) VALUES (2025, 'Elite Hospital 2025', true) ON CONFLICT (year) DO NOTHING;`,
    `INSERT INTO public.pricelists (year, title, is_active) VALUES (2026, 'Elite Hospital 2026', true) ON CONFLICT (year) DO NOTHING;`,
    ''
  ];

  // 1. Sales Representatives
  const reps = [
    'ديانا',
    'محمد ابو الوفا',
    'نادين',
    'أحمد حمزة',
    'زياد',
    'محمد جابر'
  ];

  statements.push('-- Insert Standard Sales Representatives');
  for (const rep of reps) {
    statements.push(
      `INSERT INTO public.sales_reps (name_ar) SELECT ${escapeSql(rep)} WHERE NOT EXISTS (SELECT 1 FROM public.sales_reps WHERE name_ar = ${escapeSql(rep)});`
    );
  }
  statements.push('');

  // 2. Load Companies from Consumables.xlsx
  const consumablesPath = path.resolve(ROOT_DIR, 'public', 'Consumables.xlsx');
  if (fs.existsSync(consumablesPath)) {
    const buf = fs.readFileSync(consumablesPath);
    const wb = XLSX.read(buf);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];

    statements.push('-- Insert Corporate Companies');
    const seenCompanies = new Set<string>();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || !row[0]) continue;

      const compName = String(row[0]).trim();
      if (!compName || seenCompanies.has(compName)) continue;
      seenCompanies.add(compName);

      let discountVal = 0;
      const rawDiscount = row[2];
      if (typeof rawDiscount === 'number') {
        discountVal = rawDiscount < 1 && rawDiscount > 0 ? rawDiscount * 100 : rawDiscount;
      } else {
        discountVal = parseFloat(String(rawDiscount || '0').replace('%', '')) || 0;
      }
      discountVal = Math.min(Math.max(Math.round(discountVal), 0), 100);

      let year = parseInt(String(row[1] || '2025').trim(), 10);
      if (isNaN(year) || year < 2020 || year > 2030) year = 2025;

      const norm = normalizeArabicForSearch(compName);

      statements.push(
        `INSERT INTO public.companies (name, normalized_name, price_list_year, discount_percentage) ` +
        `VALUES (${escapeSql(compName)}, ${escapeSql(norm)}, ${year}, ${discountVal}) ` +
        `ON CONFLICT (name) DO UPDATE SET discount_percentage = EXCLUDED.discount_percentage, price_list_year = EXCLUDED.price_list_year;`
      );
    }
    statements.push('');
  }

  // 3. Load Sample Procedures from JSON (first 500 procedures per year for initial seed)
  const years = ['2023', '2024', '2025', '2026'];
  for (const yr of years) {
    const jsonPath = path.resolve(ROOT_DIR, 'public', `${yr}_cash.json`);
    if (fs.existsSync(jsonPath)) {
      const procs = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      statements.push(`-- Insert Procedures for Year ${yr} (Sample of ${Math.min(procs.length, 300)})`);
      
      const sample = procs.slice(0, 300);
      for (const p of sample) {
        const pEng = (p.nameEnglish || '').trim();
        const pAra = (p.nameArabic || '').trim();
        const rawPrice = String(p.price || '0').replace(/[^0-9.]/g, '');
        const priceNum = parseFloat(rawPrice) || 0;
        if (!pEng) continue;

        statements.push(
          `INSERT INTO public.procedures (pricelist_id, name_english, name_arabic, price) ` +
          `SELECT pl.id, ${escapeSql(pEng)}, ${escapeSql(pAra)}, ${priceNum} ` +
          `FROM public.pricelists pl WHERE pl.year = ${yr};`
        );
      }
      statements.push('');
    }
  }

  fs.writeFileSync(SEED_OUTPUT, statements.join('\n'), 'utf-8');
  console.log(`Successfully generated: ${SEED_OUTPUT}`);
}

run().catch(err => {
  console.error('Failed to generate seed file:', err);
  process.exit(1);
});
