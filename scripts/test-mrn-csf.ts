import { analyzeThreadWithHeuristics } from '../src/services/aiMatchService';
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

  const cands = await retrieveDynamicPricelistCandidates(
    '2026',
    services,
    'Meningitis',
    40
  );

  const res = analyzeThreadWithHeuristics({
    patientName: 'نادر قدري محمد عبدالله',
    mrn: '0000216945',
    contractor: 'نكست كير',
    diagnosis: 'Meningitis',
    initialServices: services,
    threadMessages: [],
    candidatePricelistRows: cands,
  });

  console.log('Matches:');
  res.matchedProcedures.forEach(m => {
    console.log(`  ${m.serviceName} => [${m.status}] ${m.matchedName}`);
  });
}

test().catch(console.error);
