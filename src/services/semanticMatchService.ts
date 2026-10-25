/**
 * Structured Semantic Matching Service
 * Constrains Gemini output to strict JSON schema { candidate_id, confidence, reason }.
 * Enforces candidate boundary rejection, SHA-256 normalized query caching,
 * confidence tier evaluation, and deterministic pg_trgm fallback.
 */

import crypto from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { ProcedureResult } from '../types';
import { normalizeArabic, normalizeText } from '../lib/arabic-normalizer';
import { getGeminiApiKey } from './aiMatchService';
import { supabaseAdmin, supabase } from '../lib/supabase';
import { assertZeroDemographics } from '../lib/deidentifier';

const client = supabaseAdmin || supabase;

export type ConfidenceTier = 'auto_accept' | 'needs_review' | 'reject';

export interface StructuredMatchResult {
  query: string;
  matchedProcedure: ProcedureResult | null;
  candidateId: number;
  confidence: number;
  confidenceTier: ConfidenceTier;
  reason: string;
  source: 'override' | 'cache' | 'gemini_structured' | 'trgm_fallback';
}

const semanticMemoryCache = new Map<string, StructuredMatchResult>();

/**
 * Computes SHA-256 hash of normalized query.
 */
export function computeQueryHash(query: string): string {
  const normalized = normalizeArabic(normalizeText(query));
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Evaluates numeric confidence score into operational confidence tier.
 */
export function evaluateConfidenceTier(score: number): ConfidenceTier {
  if (score >= 0.85) return 'auto_accept';
  if (score >= 0.50) return 'needs_review';
  return 'reject';
}

/**
 * Retrieves cached structured prediction from memory or PostgreSQL table public.semantic_match_cache.
 */
async function getCachedMatch(
  queryHash: string,
  candidates: ProcedureResult[]
): Promise<StructuredMatchResult | null> {
  if (semanticMemoryCache.has(queryHash)) {
    return semanticMemoryCache.get(queryHash)!;
  }

  if (!client) return null;

  try {
    const { data, error } = await client
      .from('semantic_match_cache')
      .select('query_normalized, matched_candidate_id, matched_code, matched_name, confidence, confidence_tier, reason')
      .eq('query_hash', queryHash)
      .maybeSingle();

    if (error || !data) return null;

    let matchedProcedure: ProcedureResult | null = null;
    if (data.matched_code) {
      matchedProcedure = candidates.find((c) => c.code === data.matched_code) || null;
    }
    if (!matchedProcedure && data.matched_candidate_id) {
      const idx = parseInt(data.matched_candidate_id, 10);
      if (!isNaN(idx) && idx >= 0 && idx < candidates.length) {
        matchedProcedure = candidates[idx];
      }
    }

    const result: StructuredMatchResult = {
      query: data.query_normalized,
      matchedProcedure,
      candidateId: matchedProcedure ? candidates.indexOf(matchedProcedure) : -1,
      confidence: Number(data.confidence),
      confidenceTier: data.confidence_tier as ConfidenceTier,
      reason: data.reason || 'Loaded from persistent semantic cache',
      source: 'cache',
    };

    semanticMemoryCache.set(queryHash, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Persists structured prediction to PostgreSQL semantic match cache.
 */
async function persistMatchToCache(hash: string, result: StructuredMatchResult): Promise<void> {
  semanticMemoryCache.set(hash, result);
  if (!client) return;

  try {
    await client.from('semantic_match_cache').upsert(
      {
        query_hash: hash,
        query_normalized: normalizeArabic(normalizeText(result.query)),
        matched_candidate_id: result.candidateId >= 0 ? String(result.candidateId) : null,
        matched_code: result.matchedProcedure?.code || null,
        matched_name: result.matchedProcedure?.nameArabic || result.matchedProcedure?.nameEnglish || null,
        confidence: result.confidence,
        confidence_tier: result.confidenceTier,
        reason: result.reason,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'query_hash' }
    );
  } catch (err) {
    console.warn('[Semantic Cache] Error writing to DB cache:', err);
  }
}

const CLINICAL_NOISE_TOKENS = new Set([
  'طلب', 'فحص', 'تحليل', 'عمل', 'إجراء', 'اجراء', 'سحب', 'أشعة', 'اشعة', 'باسم', 'باستخدام', 'تحت'
]);

/**
 * Deterministic fallback scoring candidates via character and token trigrams.
 */
export function scoreTrigramFallback(
  query: string,
  candidates: ProcedureResult[]
): StructuredMatchResult {
  const normQuery = normalizeArabic(normalizeText(query));
  const rawTokens = normQuery.split(/\s+/).filter((t) => t.length >= 2);
  const meaningfulTokens = rawTokens.filter((t) => !CLINICAL_NOISE_TOKENS.has(t));
  const queryTokens = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;

  let bestIdx = -1;
  let maxScore = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const normAr = normalizeArabic(normalizeText(c.nameArabic || ''));
    const normEn = normalizeText(c.nameEnglish || '').toLowerCase();

    // Exact match
    if (normAr === normQuery || normEn === normQuery.toLowerCase()) {
      bestIdx = i;
      maxScore = 0.95;
      break;
    }

    // Substring inclusion
    if (normAr && (normQuery.includes(normAr) || normAr.includes(normQuery))) {
      const score = Math.min(normAr.length, normQuery.length) / Math.max(normAr.length, normQuery.length);
      if (score > maxScore) {
        maxScore = score;
        bestIdx = i;
      }
    } else if (normEn && normQuery.toLowerCase().includes(normEn)) {
      const score = Math.min(normEn.length, normQuery.length) / Math.max(normEn.length, normQuery.length);
      if (score > maxScore) {
        maxScore = score;
        bestIdx = i;
      }
    }

    // Keyword & Acronym token overlap (e.g. "cbc", "tee", "mri", "echo")
    const candTokens = `${normAr} ${normEn}`.split(/\s+/);
    let matchedTokens = 0;
    for (const qt of queryTokens) {
      if (candTokens.includes(qt)) {
        matchedTokens++;
      }
    }
    const tokenScore = queryTokens.length > 0 ? (matchedTokens / queryTokens.length) * 0.9 : 0;
    if (tokenScore > maxScore) {
      maxScore = tokenScore;
      bestIdx = i;
    }
  }

  const matchedProcedure = bestIdx >= 0 && maxScore >= 0.5 ? candidates[bestIdx] : null;
  const confidence = matchedProcedure ? Math.min(0.92, maxScore) : 0.2;

  return {
    query,
    matchedProcedure,
    candidateId: matchedProcedure ? bestIdx : -1,
    confidence,
    confidenceTier: evaluateConfidenceTier(confidence),
    reason: matchedProcedure
      ? `Deterministic trigram token overlap score ${(maxScore * 100).toFixed(0)}%`
      : 'No candidate passed minimum trigram similarity threshold',
    source: 'trgm_fallback',
  };
}

/**
 * Matches a single procedure query against candidate rows using JSON Schema-constrained Gemini AI,
 * with normalized-query SHA256 caching and deterministic pg_trgm fallback.
 */
export async function matchProcedureWithGeminiStructured(
  query: string,
  candidates: ProcedureResult[]
): Promise<StructuredMatchResult> {
  if (!query || candidates.length === 0) {
    return {
      query,
      matchedProcedure: null,
      candidateId: -1,
      confidence: 0,
      confidenceTier: 'reject',
      reason: 'Empty query or empty candidate list',
      source: 'trgm_fallback',
    };
  }

  const queryHash = computeQueryHash(query);

  // 1. Check persistent & memory cache
  const cached = await getCachedMatch(queryHash, candidates);
  if (cached) {
    return cached;
  }

  // 2. Prepare Gemini Prompt
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    console.log('[Semantic Matcher] Gemini API key not present; falling back to trigram matching.');
    const fallback = scoreTrigramFallback(query, candidates);
    await persistMatchToCache(queryHash, fallback);
    return fallback;
  }

  const candidateLines = candidates
    .slice(0, 25)
    .map((c, idx) => {
      const codePart = c.code ? ` [Code: ${c.code}]` : '';
      const arPart = c.nameArabic ? ` | Ar: ${c.nameArabic}` : '';
      return `[ID: ${idx}] ${c.nameEnglish}${arPart}${codePart}`;
    })
    .join('\n');

  const promptText = `You are a Senior Hospital Medical Billing & Clinical Coding AI at Elite Hospital.
Select which Candidate ID best matches the requested clinical procedure.

<RequestedProcedure>
"${query}"
</RequestedProcedure>

<CandidateList>
${candidateLines}
</CandidateList>

CLINICAL MATCHING CONSTRAINTS:
1. Strict Immunoglobulin Specificity: IgA, IgG, IgM, IgE must NEVER match a different isotype.
2. Distinct Investigations: TEE must NEVER match surface echo (TTE). CSF culture must NEVER match CSF analysis.
3. Candidate ID Range: You must ONLY return an integer between 0 and ${Math.min(candidates.length, 25) - 1}. If no candidate accurately matches, return candidate_id: -1.
4. Confidence: Float between 0.00 and 1.00 reflecting clinical certainty.
5. Reason: Concise 1-sentence English explanation.`;

  // Zero-Demographics Assertion
  const demoCheck = assertZeroDemographics(promptText);
  if (!demoCheck.isClean) {
    throw new Error(`Demographics detected in matching prompt: ${demoCheck.violations.join('; ')}`);
  }

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      candidate_id: {
        type: Type.INTEGER,
        description: `Index of matched candidate (0 to ${Math.min(candidates.length, 25) - 1}) or -1 if no candidate matches.`,
      },
      confidence: {
        type: Type.NUMBER,
        description: 'Confidence score between 0.0 and 1.0.',
      },
      reason: {
        type: Type.STRING,
        description: 'Brief clinical rationale.',
      },
    },
    required: ['candidate_id', 'confidence', 'reason'],
  };

  const ai = new GoogleGenAI({ apiKey });
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

  for (const model of models) {
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: promptText }] }],
          config: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout querying Gemini model ${model}`)), 5000)
        ),
      ]);

      const parsed = JSON.parse(response.text || '{}');
      const candidateId = typeof parsed.candidate_id === 'number' ? parsed.candidate_id : -1;
      const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      const reason = parsed.reason || 'AI clinical match';

      // Strict boundary check: Reject anything outside candidate set
      let matchedProcedure: ProcedureResult | null = null;
      let finalConfidence = rawConfidence;

      if (candidateId >= 0 && candidateId < candidates.length && candidateId < 25) {
        matchedProcedure = candidates[candidateId];
      } else {
        // Explicit rejection
        matchedProcedure = null;
        finalConfidence = Math.min(finalConfidence, 0.3);
      }

      const result: StructuredMatchResult = {
        query,
        matchedProcedure,
        candidateId: matchedProcedure ? candidateId : -1,
        confidence: finalConfidence,
        confidenceTier: evaluateConfidenceTier(finalConfidence),
        reason,
        source: 'gemini_structured',
      };

      await persistMatchToCache(queryHash, result);
      return result;
    } catch (err) {
      console.warn(`[Semantic Matcher] Attempt with ${model} failed:`, err);
    }
  }

  // If all Gemini attempts fail or time out, fall back to pure trigram matching
  console.warn('[Semantic Matcher] ⚠️ Gemini calls exhausted; falling back to pg_trgm scoring.');
  const fallback = scoreTrigramFallback(query, candidates);
  await persistMatchToCache(queryHash, fallback);
  return fallback;
}
