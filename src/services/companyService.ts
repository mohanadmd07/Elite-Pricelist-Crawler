import * as XLSX from 'xlsx';
import { CompanyInfo } from '../types';
import { getBaseNameForSales, normalizeArabic } from '../lib/arabic-normalizer';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

const MANUAL_REPS: Record<string, string> = {
  'المصرية الاماراتية': 'ديانا',
  'عز للحديد والصلب': 'محمد ابو الوفا',
  'حديد عز': 'محمد ابو الوفا',
  'تكنولوجيا الاخشاب': 'نادين',
  'صاان مصر': 'محمد ابو الوفا',
  'صان مصر': 'محمد ابو الوفا',
  'مصر للصيانة (صان مصر) EMC': 'محمد ابو الوفا',
  ميدرايت: 'نادين',
  'Med Right': 'نادين',
  سوميد: 'محمد ابو الوفا',
  Sumed: 'محمد ابو الوفا',
  'نيكست كير': 'أحمد حمزة',
  'Next Care نكست كير': 'أحمد حمزة',
  بترومنت: 'زياد',
  Petromaint: 'زياد',
  الحمراويل: 'نادين',
  'شركة الحمرا اويل': 'نادين',
  'نقابة المهندسين': 'ديانا',
  'نقابه المهندسين': 'ديانا',
  'وزراة العدل': 'ديانا',
  'وزاره العدل': 'ديانا',
  'منصور جروب': 'محمد ابو الوفا',
  'Mansour Group مجموعة منصور': 'محمد ابو الوفا',
  يونايد: 'محمد جابر',
  يونايتد: 'محمد جابر',
};

let cachedCompanies: CompanyInfo[] | null = null;

export async function loadCompanies(): Promise<CompanyInfo[]> {
  if (cachedCompanies) {
    return cachedCompanies;
  }

  // 1. Try Supabase first if configured
  if (isSupabaseConfigured() && supabase) {
    try {
      const { data, error } = await supabase
        .from('companies')
        .select(`
          name,
          price_list_year,
          discount_percentage,
          sales_reps ( name_ar )
        `)
        .order('name');

      if (!error && data && data.length > 0) {
        cachedCompanies = data.map((c: any) => ({
          name: c.name,
          priceListYear: String(c.price_list_year),
          discount: Math.round(Number(c.discount_percentage)),
          responsiblePerson: c.sales_reps?.name_ar || MANUAL_REPS[c.name],
        }));
        return cachedCompanies;
      }
    } catch (err) {
      console.warn('Supabase companies fetch skipped, falling back to local files:', err);
    }
  }

  // 2. Fallback to local Excel files with parallel fetching per react-best-practices
  try {
    const loadFileBuffer = async (fileName: string): Promise<ArrayBuffer | null> => {
      if (typeof window === 'undefined') {
        try {
          const fs = await import('fs');
          const path = await import('path');
          const filePath = path.resolve(process.cwd(), 'public', fileName);
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          }
        } catch {
          return null;
        }
      }

      try {
        const res = await fetch(`/${encodeURIComponent(fileName)}`);
        if (res && res.ok) {
          return await res.arrayBuffer();
        }
      } catch {
        return null;
      }
      return null;
    };

    const [salesBuf, consumablesBuf] = await Promise.all([
      loadFileBuffer('Sales 2027.xlsx'),
      loadFileBuffer('Consumables.xlsx'),
    ]);

    let salesReps: { name: string; rep: string }[] = [];

    if (salesBuf) {
      try {
        const salesWb = XLSX.read(salesBuf);
        const salesWs = salesWb.Sheets[salesWb.SheetNames[0]];
        const salesJson = XLSX.utils.sheet_to_json(salesWs, { header: 1 }) as any[][];

        if (salesJson && salesJson.length > 1) {
          const repsRow = salesJson[1] || [];
          for (let r = 2; r < salesJson.length; r++) {
            const row = salesJson[r];
            if (!row) continue;
            for (let c = 0; c < repsRow.length; c++) {
              const rep = repsRow[c];
              const comp = row[c];
              if (
                rep &&
                comp &&
                typeof rep === 'string' &&
                typeof comp === 'string'
              ) {
                const trimmedRep = rep.trim();
                const trimmedComp = comp.trim();
                if (trimmedComp && trimmedRep) {
                  salesReps.push({ name: trimmedComp, rep: trimmedRep });
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('Error parsing Sales 2027.xlsx:', e);
      }
    }

    if (!consumablesBuf) {
      throw new Error('Consumables.xlsx not found');
    }

    const arrayBuffer = consumablesBuf;
    const workbook = XLSX.read(arrayBuffer);

    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    if (!jsonData || jsonData.length < 2) {
      return [];
    }

    const loadedCompanies: CompanyInfo[] = jsonData
      .slice(1)
      .filter((row) => row && row[0])
      .map((row) => {
        let discountValue = 0;
        const rawDiscount = row[2];

        if (typeof rawDiscount === 'number') {
          discountValue =
            rawDiscount < 1 && rawDiscount > 0 ? rawDiscount * 100 : rawDiscount;
        } else {
          discountValue = parseFloat(String(rawDiscount || '0').replace('%', '')) || 0;
        }

        const compName = String(row[0]).trim();

        // Resolve sales representative
        let responsiblePerson = MANUAL_REPS[compName];
        if (!responsiblePerson && salesReps.length > 0) {
          const exactMatch = salesReps.find(
            (s) => s.name.toLowerCase() === compName.toLowerCase()
          );
          if (exactMatch) {
            responsiblePerson = exactMatch.rep;
          } else {
            const compBase = getBaseNameForSales(compName);
            if (compBase.length > 0) {
              const normMatch = salesReps.find(
                (s) => getBaseNameForSales(s.name) === compBase
              );
              if (normMatch) {
                responsiblePerson = normMatch.rep;
              } else if (compBase.length >= 3) {
                const subMatch = salesReps.find((s) => {
                  const sNorm = getBaseNameForSales(s.name);
                  if (sNorm.length < 3) return false;
                  return sNorm.includes(compBase) || compBase.includes(sNorm);
                });
                if (subMatch) {
                  responsiblePerson = subMatch.rep;
                }
              }
            }
          }
        }

        let priceListYearVal = String(row[1] || '').trim();
        const normCompName = normalizeArabic(compName);
        if (
          normCompName.includes('لايف هيلث كير') ||
          normCompName.includes('لايف هيلثكير') ||
          normCompName.includes('life health') ||
          normCompName.includes('lifehealth')
        ) {
          priceListYearVal = '2024';
        } else if (
          normCompName.includes('خالده') ||
          normCompName.includes('خالدة') ||
          normCompName.includes('khalda')
        ) {
          priceListYearVal = '2025';
        }

        return {
          name: compName,
          priceListYear: priceListYearVal,
          discount: Math.round(discountValue),
          responsiblePerson,
        };
      })
      .filter((c) => c.name.length > 0);

    cachedCompanies = loadedCompanies;
    return loadedCompanies;
  } catch (err) {
    console.error('Failed to load companies:', err);
    return [];
  }
}
