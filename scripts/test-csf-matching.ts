import { retrieveDynamicPricelistCandidates } from '../src/services/procedureService';

async function test() {
  const services = [
    { name: 'CSF culture - Investigation', rawPrice: 1125 },
    { name: 'PCR panel for Meningitis, CSF (Bacterial & Viral) - Investigation', rawPrice: 6875 },
    { name: 'Lactate, CSF - Investigation', rawPrice: 765 },
    { name: 'CSF analysis (Chemistry & cell count) - Investigation', rawPrice: 940 },
    { name: 'Gram stain - Investigation', rawPrice: 290 },
    { name: 'Cytology for fluids - Investigation', rawPrice: 1565 }
  ];

  console.log('Testing 2025:');
  const c2025 = await retrieveDynamicPricelistCandidates('2025', services, '', 30);
  console.log('Candidates 2025:');
  for (const c of c2025) {
    console.log(`  [score=${c.score}] ${c.nameEnglish} (ar: ${c.nameArabic}) (price: ${c.price})`);
  }

  console.log('\nTesting 2026:');
  const c2026 = await retrieveDynamicPricelistCandidates('2026', services, '', 30);
  console.log('Candidates 2026:');
  for (const c of c2026) {
    console.log(`  [score=${c.score}] ${c.nameEnglish} (ar: ${c.nameArabic}) (price: ${c.price})`);
  }
}
test();
