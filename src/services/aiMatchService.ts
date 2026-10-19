import { GoogleGenAI, Type } from '@google/genai';
import { ProcedureResult, SelectedProcedure } from '../types';

export const GEMINI_STORAGE_KEY = 'elite_gemini_api_key';

/**
 * Retrieves the Gemini API key from localStorage, import.meta.env, or process.env.
 */
export function getGeminiApiKey(): string {
  if (typeof window !== 'undefined') {
    const local = localStorage.getItem(GEMINI_STORAGE_KEY);
    if (local && local.trim().length > 0) {
      return local.trim();
    }
  }

  const envVite = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_GEMINI_API_KEY : '';
  if (envVite && typeof envVite === 'string' && envVite.trim().length > 0) {
    return envVite.trim();
  }

  const envProcess = typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '';
  if (envProcess && typeof envProcess === 'string' && envProcess.trim().length > 0) {
    return envProcess.trim();
  }

  return '';
}

/**
 * Persists the user's Gemini API key to localStorage.
 */
export function setGeminiApiKey(key: string): void {
  if (typeof window !== 'undefined') {
    if (key.trim()) {
      localStorage.setItem(GEMINI_STORAGE_KEY, key.trim());
    } else {
      localStorage.removeItem(GEMINI_STORAGE_KEY);
    }
  }
}

/**
 * Checks whether a valid Gemini API key is configured.
 */
export function isGeminiConfigured(): boolean {
  return getGeminiApiKey().length > 10;
}

/**
 * Executes AI semantic procedure matching against candidates with model fallback.
 * Uses compact index-based prompt format and candidateId response schema for ultra-fast generation.
 */
export async function matchProceduresWithAI(
  unmatchedProcedures: SelectedProcedure[],
  candidates: ProcedureResult[]
): Promise<ProcedureResult[]> {
  const key = getGeminiApiKey();

  if (!key) {
    throw new Error(
      "Gemini API key is not configured. Please click 'AI Settings' in the top header to enter your API key, or set GEMINI_API_KEY in .env.local."
    );
  }

  if (unmatchedProcedures.length === 0) {
    return [];
  }

  if (candidates.length === 0) {
    throw new Error(
      "No candidate pricelist items could be identified for AI semantic matching. Try broadening your search query."
    );
  }

  const ai = new GoogleGenAI({ apiKey: key });

  const proceduresListText = unmatchedProcedures
    .map(
      (p, idx) =>
        `${idx + 1}. English: "${p.name}"${p.arabic ? ` / Arabic: "${p.arabic}"` : ''}`
    )
    .join('\n');

  // Compact indexed text: eliminates multi-kilobyte JSON syntax overhead
  const candidatesLines = candidates
    .map((c, idx) => {
      const arPart = c.nameArabic ? ` | Ar: ${c.nameArabic}` : '';
      const secPart = c.sectionName ? ` | Sec: ${c.sectionName}` : '';
      return `[${idx}] ${c.nameEnglish}${arPart}${secPart}`;
    })
    .join('\n');

  const promptText = `You are an expert AI medical assistant for Elite Hospital.
Below is a numbered list of candidate pricing rows from the hospital's official pricelists:

<CandidatePricelist>
${candidatesLines}
</CandidatePricelist>

Match each of the following requested clinical procedures with the pricing rows above:
${proceduresListText}

STRICT CLINICAL EXTRACTION RULES:
1. Handle clinical abbreviations with or without dots (e.g., "EEG" matches "ELECTROENCEPHALOGRAPHY (EEG)", "ECG" matches "Electrocardiogram").
2. Handle synonyms and common clinical variations (e.g., "Echo" matches "Echocardiography").
3. ONLY select candidates that truly match the requested procedure by their numeric [ID]. If no candidate is an appropriate clinical match, omit it.
4. Return a JSON array with 'candidateId' (integer ID) and 'requestedProcedureName' (exact requested English name). If none match, return an empty array [].`;

  // Lean response schema: LLM outputs only the numeric index and requested name (~15-30 tokens)
  const responseSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        candidateId: {
          type: Type.INTEGER,
          description:
            'The numeric index [0, 1, 2...] of the matching candidate row from CandidatePricelist.',
        },
        requestedProcedureName: {
          type: Type.STRING,
          description:
            "The exact English name from the prompt's requested list that this candidate belongs to.",
        },
      },
      required: ['candidateId', 'requestedProcedureName'],
    },
  };

  // Try candidate models in order: gemini-2.5-flash -> gemini-2.0-flash -> gemini-1.5-flash
  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      // 8-second timeout per model attempt to prevent UI hangs
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: [
            {
              parts: [{ text: promptText }],
            },
          ],
          config: {
            temperature: 0, // Deterministic greedy search for maximum speed
            responseMimeType: 'application/json',
            responseSchema,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout querying Gemini model ${model}`)), 8000)
        ),
      ]);

      const parsed = JSON.parse(response.text || '[]') as Array<{
        candidateId: number;
        requestedProcedureName: string;
      }>;

      // Reconstruct full ProcedureResult objects instantly in memory with 100% data fidelity
      const matches: ProcedureResult[] = [];
      const seenMatch = new Set<string>();

      for (const item of parsed) {
        if (
          typeof item.candidateId === 'number' &&
          item.candidateId >= 0 &&
          item.candidateId < candidates.length
        ) {
          const cand = candidates[item.candidateId];
          const matchKey = `${cand.nameEnglish}|${cand.sourceFile}|${cand.price}|${item.requestedProcedureName}`;
          if (!seenMatch.has(matchKey)) {
            seenMatch.add(matchKey);
            matches.push({
              ...cand,
              requestedProcedureName: item.requestedProcedureName,
            });
          }
        }
      }

      return matches;
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      console.warn(`Gemini model ${model} failed, trying fallback:`, msg);

      // If it's a 403 (Permission denied / Invalid API key), don't retry models as the key is rejected
      if (
        msg.includes('403') ||
        msg.includes('API key not valid') ||
        msg.includes('PERMISSION_DENIED')
      ) {
        throw new Error(
          'Gemini API Key rejected (403 Permission Denied). Please verify that your API key is active and has access to Gemini in Google AI Studio.'
        );
      }
      // If it's a 429 quota exhausted, inform user
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        throw new Error(
          'Gemini API rate limit or quota exceeded (429). Please wait a few moments and try again.'
        );
      }
    }
  }

  throw lastError || new Error('Failed to query Gemini AI model.');
}
