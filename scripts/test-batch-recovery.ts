import fs from 'fs';
import path from 'path';
import { retrieveDynamicPricelistCandidates } from '../src/services/procedureService';

async function testAllProcedures() {
  const data = JSON.parse(fs.readFileSync('data/inpatient_approvals.json', 'utf-8'));
  let matched = 0;
  let unmatched = 0;
  const newlyMatched: Array<{ original: string; matchedName: string; price: number; year: string }> = [];

  for (const record of data) {
    const services = record.requestedServices || [];
    if (services.length === 0) continue;

    const year = record.priceListYear || '2025';
    const cands = await retrieveDynamicPricelistCandidates(year, services, record.diagnosis, 15);

    for (const s of services) {
      const topCand = cands.find((c) => c.score >= 50);
      if (topCand) {
        matched++;
        const prevStatus = record.matchedProcedures?.find((p: any) => p.serviceName === s.name)?.status;
        if (prevStatus !== 'matched') {
          newlyMatched.push({
            original: s.name,
            matchedName: `${topCand.nameArabic || ''} (${topCand.nameEnglish})`,
            price: topCand.price || 0,
            year,
          });
        }
      } else {
        unmatched++;
      }
    }
  }

  const total = matched + unmatched;
  console.log(`\n=================================================`);
  console.log(`NEW DYNAMIC RETRIEVAL MATCH RATE`);
  console.log(`=================================================`);
  console.log(`Matched: ${matched}`);
  console.log(`Unmatched: ${unmatched}`);
  console.log(`Total: ${total}`);
  console.log(`New Match Rate: ${(matched / total * 100).toFixed(1)}%`);
  console.log(`Newly recovered procedures: ${newlyMatched.length}`);
  console.log(`\nSample of newly recovered procedures:`);
  newlyMatched.slice(0, 10).forEach((item, idx) => {
    console.log(`  ${idx + 1}. [${item.year}] "${item.original}" ➜ ${item.matchedName} (Price: ${item.price})`);
  });
}

testAllProcedures().catch(console.error);
