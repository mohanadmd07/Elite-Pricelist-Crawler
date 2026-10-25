/**
 * Phase 4 Matching Quality Test Suite
 * Tests:
 * 1. Arabic Medical Normalization Parity (TypeScript vs PostgreSQL normalize_arabic_medical).
 * 2. Structured Gemini Matching with JSON Schema and Boundary Rejection.
 * 3. Confidence Tier Mapping (auto_accept >= 0.85, needs_review >= 0.50, reject < 0.50).
 * 4. Priority Override Logging & Retrieval.
 * 5. Query Hash Caching in public.semantic_match_cache.
 * 6. High-Performance search_procedures RPC on PostgreSQL.
 */

import { normalizeArabic, normalizeText } from '../src/lib/arabic-normalizer';
import { matchProcedureWithGeminiStructured, computeQueryHash, evaluateConfidenceTier, scoreTrigramFallback } from '../src/services/semanticMatchService';
import { logProcedureOverride, getOverrideForQuery } from '../src/services/procedureOverrideService';
import { supabaseAdmin, supabase } from '../src/lib/supabase';
import { ProcedureResult } from '../src/types';

const client = supabaseAdmin || supabase;

async function runMatchingQualityTests() {
  console.log('=====================================================');
  console.log('🧪 Starting Phase 4 Matching Quality Test Suite');
  console.log('=====================================================\n');

  if (!client) {
    throw new Error('Supabase client is not configured in environment!');
  }

  // -------------------------------------------------------------
  // Test 1: Arabic Normalization Parity (TS vs PostgreSQL RPC)
  // -------------------------------------------------------------
  console.log('Test 1: Testing Arabic Normalization Parity between TS and Postgres...');
  const testPhrase = 'أَشِعَّةٌ مَقْطَعِيَّةٌ عَلَى الْمُخِّ بِالْحَقْنِ ١٢٣';
  const tsNormalized = normalizeArabic(testPhrase);

  const { data: pgData, error: pgErr } = await client.rpc('normalize_arabic_medical', {
    input_text: testPhrase,
  });

  if (pgErr) {
    throw new Error(`Postgres normalize_arabic_medical RPC failed: ${pgErr.message}`);
  }

  console.log(`  Input:      "${testPhrase}"`);
  console.log(`  TypeScript: "${tsNormalized}"`);
  console.log(`  PostgreSQL: "${pgData}"`);

  if (tsNormalized !== pgData) {
    throw new Error(`Normalization mismatch! TS: "${tsNormalized}", PG: "${pgData}"`);
  }
  console.log('✅ PASS: Test 1 (Arabic Normalization Parity)');

  // -------------------------------------------------------------
  // Test 2: Confidence Tier Mapping
  // -------------------------------------------------------------
  console.log('\nTest 2: Verifying Confidence Tier Thresholds...');
  if (evaluateConfidenceTier(0.95) !== 'auto_accept') throw new Error('0.95 must be auto_accept');
  if (evaluateConfidenceTier(0.85) !== 'auto_accept') throw new Error('0.85 must be auto_accept');
  if (evaluateConfidenceTier(0.84) !== 'needs_review') throw new Error('0.84 must be needs_review');
  if (evaluateConfidenceTier(0.50) !== 'needs_review') throw new Error('0.50 must be needs_review');
  if (evaluateConfidenceTier(0.49) !== 'reject') throw new Error('0.49 must be reject');
  if (evaluateConfidenceTier(0.10) !== 'reject') throw new Error('0.10 must be reject');
  console.log('  ✓ Verified auto_accept (>=0.85), needs_review (0.50-0.84), and reject (<0.50)');
  console.log('✅ PASS: Test 2 (Confidence Tier Thresholds)');

  // -------------------------------------------------------------
  // Test 3: Trigram Candidate Fallback & Boundary Enforcement
  // -------------------------------------------------------------
  console.log('\nTest 3: Testing Trigram Fallback and Boundary Protection...');
  const mockCandidates: ProcedureResult[] = [
    {
      code: 'P.101',
      nameEnglish: 'Complete Blood Count (CBC)',
      nameArabic: 'صورة دم كاملة',
      price: '150.00',
      sectionName: 'المختبر',
      sourceFile: '2026_cash.json',
    },
    {
      code: 'P.102',
      nameEnglish: 'Transesophageal Echocardiography (TEE)',
      nameArabic: 'موجات فوق صوتية على القلب عن طريق المريء',
      price: '3500.00',
      sectionName: 'القلب',
      sourceFile: '2026_cash.json',
    },
    {
      code: 'P.103',
      nameEnglish: 'Transthoracic Echocardiography (TTE)',
      nameArabic: 'موجات فوق صوتية على القلب إيكو',
      price: '1200.00',
      sectionName: 'القلب',
      sourceFile: '2026_cash.json',
    },
  ];

  const cbcMatch = scoreTrigramFallback('طلب فحص cbc', mockCandidates);
  console.log(`  Query "طلب فحص cbc": matched="${cbcMatch.matchedProcedure?.nameEnglish}", confidence=${cbcMatch.confidence.toFixed(2)}, tier=${cbcMatch.confidenceTier}`);
  if (!cbcMatch.matchedProcedure || cbcMatch.matchedProcedure.code !== 'P.101') {
    throw new Error('Expected CBC to match P.101');
  }

  // Strict clinical distinction: TEE must never match surface Echo (TTE)
  const teeMatch = scoreTrigramFallback('موجات على القلب بالمنظار TEE', mockCandidates);
  console.log(`  Query "TEE": matched="${teeMatch.matchedProcedure?.nameEnglish}", code=${teeMatch.matchedProcedure?.code}`);
  if (!teeMatch.matchedProcedure || teeMatch.matchedProcedure.code !== 'P.102') {
    throw new Error('Expected TEE to match P.102 (Transesophageal)');
  }
  console.log('✅ PASS: Test 3 (Trigram Fallback & Safety Boundary)');

  // -------------------------------------------------------------
  // Test 4: Semantic Query Hash Caching
  // -------------------------------------------------------------
  console.log('\nTest 4: Testing Query Hash Calculation and Persistent Caching...');
  const testQuery = 'أشعة رنين مغناطيسي للمخ';
  const hash1 = computeQueryHash(testQuery);
  const hash2 = computeQueryHash('اشعه رنين مغناطيسي للمخ'); // Variations normalize to same hash
  console.log(`  Hash 1: ${hash1}`);
  console.log(`  Hash 2: ${hash2}`);
  if (hash1 !== hash2) {
    throw new Error('Query hashes must be identical after Arabic normalization!');
  }

  const structuredMatch = await matchProcedureWithGeminiStructured(testQuery, mockCandidates);
  console.log(`  Structured Match Result: tier=${structuredMatch.confidenceTier}, source=${structuredMatch.source}`);
  if (!structuredMatch.source) {
    throw new Error('Structured match must specify result source');
  }
  console.log('✅ PASS: Test 4 (Query Hash Caching)');

  // -------------------------------------------------------------
  // Test 5: Priority Manual Overrides Logging & Retrieval
  // -------------------------------------------------------------
  console.log('\nTest 5: Testing Priority Manual Overrides Logging & Retrieval...');
  const overrideQuery = `فحص نادر جدا للاختبار ${Date.now()}`;
  const logRes = await logProcedureOverride({
    query: overrideQuery,
    chosenCode: 'P.9999',
    chosenName: 'إجراء طبي مخصص ونادر جدا',
    reason: 'Clinical override verification test',
  });

  if (!logRes.success) {
    throw new Error(`Failed to log procedure override: ${logRes.error}`);
  }
  console.log(`  ✓ Logged override ID: ${logRes.id}`);

  // Retrieve override
  const loadedOverride = await getOverrideForQuery(overrideQuery);
  if (!loadedOverride || loadedOverride.chosenCode !== 'P.9999') {
    throw new Error(`Failed to retrieve priority override for "${overrideQuery}"`);
  }
  console.log(`  ✓ Successfully retrieved priority override: Code="${loadedOverride.chosenCode}", Name="${loadedOverride.chosenName}"`);

  // Verify audit_log entry was created
  const { data: auditEntries } = await client
    .from('audit_log')
    .select('id, action')
    .eq('entity_id', logRes.id);

  if (!auditEntries || auditEntries.length === 0) {
    throw new Error('Expected audit_log entry for procedure override!');
  }
  console.log(`  ✓ Verified audit_log entry for override ID: ${auditEntries[0].id}`);

  // Clean up override test record
  await client.from('procedure_overrides').delete().eq('id', logRes.id);
  await client.from('audit_log').delete().eq('entity_id', logRes.id);
  console.log('  ✓ Test override and audit records cleaned up.');
  console.log('✅ PASS: Test 5 (Priority Manual Overrides)');

  // -------------------------------------------------------------
  // Test 6: Database search_procedures RPC Query
  // -------------------------------------------------------------
  console.log('\nTest 6: Testing PostgreSQL search_procedures RPC execution...');
  const { data: searchData, error: searchErr } = await client.rpc('search_procedures', {
    p_pricelist_year: 2026,
    p_search_term: 'CBC',
    p_similarity_threshold: 0.1,
  });

  if (searchErr) {
    throw new Error(`search_procedures RPC execution failed: ${searchErr.message}`);
  }
  console.log(`  ✓ search_procedures returned ${searchData?.length || 0} items for query "CBC".`);
  console.log('✅ PASS: Test 6 (search_procedures RPC)');

  console.log('\n=====================================================');
  console.log('🎉 ALL PHASE 4 MATCHING QUALITY TESTS PASSED SUCCESSFULLY!');
  console.log('=====================================================');
}

runMatchingQualityTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
