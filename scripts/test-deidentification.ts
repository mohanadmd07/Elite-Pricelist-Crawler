/**
 * Automated Unit Test: Healthcare Data De-identification & PHI Redaction
 * Asserts that:
 * 1. No patient demographics (names, MRNs, beds, physicians, phones, National IDs)
 *    are ever included in AI prompts sent across the network.
 * 2. Clinical procedure nomenclature is strictly preserved for semantic matching.
 */

import { redactPhiFromText, assertZeroDemographics, KnownDemographics } from '../src/lib/deidentifier';

function runDeidentificationTests() {
  console.log('=====================================================');
  console.log('🧪 Starting PHI De-identification & Security Tests');
  console.log('=====================================================\n');

  // Test Case 1: Redaction of Known Demographics
  console.log('Test 1: Redaction of explicit patient demographics...');
  const known: KnownDemographics = {
    patientName: 'عزه احمد احمد عبدالفتاح',
    mrn: '0000266421',
    bed: 'Bed 15 - ICU',
    physician: 'Hany sameer',
    phone: '01012345678',
  };

  const sampleEmail = `
    Dear Team,
    Kindly find approval request for patient عزه احمد احمد عبدالفتاح, MRN: 0000266421 admitted in Bed 15 - ICU.
    Attending physician: Dr. Hany sameer (phone: 01012345678, National ID: 29010101234567).
    Requested procedure: MRI CSF Flowmetry.
    Please review as per contract.
  `;

  const sanitized = redactPhiFromText(sampleEmail, known);

  // Assertions
  if (sanitized.includes('عزه احمد')) {
    throw new Error('FAILED: Patient name was not redacted!');
  }
  if (sanitized.includes('0000266421')) {
    throw new Error('FAILED: Patient MRN was not redacted!');
  }
  if (sanitized.includes('01012345678')) {
    throw new Error('FAILED: Phone number was not redacted!');
  }
  if (sanitized.includes('29010101234567')) {
    throw new Error('FAILED: National ID was not redacted!');
  }
  if (sanitized.includes('Bed 15')) {
    throw new Error('FAILED: Bed location was not redacted!');
  }
  if (sanitized.includes('Hany sameer')) {
    throw new Error('FAILED: Physician name was not redacted!');
  }
  if (!sanitized.includes('MRI CSF Flowmetry')) {
    throw new Error('FAILED: Medical procedure name was accidentally stripped!');
  }

  console.log('  ✓ Patient name redacted to placeholder');
  console.log('  ✓ MRN / File ID redacted to placeholder');
  console.log('  ✓ National ID & Phone redacted to placeholder');
  console.log('  ✓ Bed & Physician redacted to placeholder');
  console.log('  ✓ Clinical procedure ("MRI CSF Flowmetry") fully preserved');
  console.log('✅ PASS: Test 1 (Demographics Redaction)\n');

  // Test Case 2: Zero-Demographics Assertion Guardrail
  console.log('Test 2: Zero-Demographics Assertion Guardrail Verification...');
  
  // Clean prompt verification
  const cleanPrompt = `
    <ContractContext>
    Contractor: جاسكو
    Price List Year: 2025
    Clinical Specialty: Neurology
    </ContractContext>
    <RequestedServices>
    [Srv 0]: "MRI CSF Flowmetry"
    </RequestedServices>
  `;

  const cleanCheck = assertZeroDemographics(cleanPrompt, known);
  if (!cleanCheck.isClean) {
    throw new Error(`FAILED: Clean prompt incorrectly flagged: ${cleanCheck.violations.join(', ')}`);
  }
  console.log('  ✓ Clean prompt verified (zero violations)');

  // Dirty prompt detection
  const dirtyPrompt = cleanPrompt + ` Patient Name: "عزه احمد احمد عبدالفتاح"`;
  const dirtyCheck = assertZeroDemographics(dirtyPrompt, known);
  if (dirtyCheck.isClean) {
    throw new Error('FAILED: Dirty prompt containing patient name was not intercepted!');
  }
  console.log(`  ✓ Dirty prompt correctly intercepted: "${dirtyCheck.violations[0]}"`);
  console.log('✅ PASS: Test 2 (Guardrail Interception)\n');

  console.log('🎉 ALL DE-IDENTIFICATION TESTS PASSED SUCCESSFULLY!');
}

runDeidentificationTests();
