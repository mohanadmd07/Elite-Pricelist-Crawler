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

  const candidatesText = JSON.stringify(
    candidates.map((c) => ({
      nameEnglish: c.nameEnglish,
      nameArabic: c.nameArabic,
      price: c.price,
      sectionName: c.sectionName,
      sourceFile: c.sourceFile,
    })),
    null,
    2
  );

  const promptText = `You are an expert AI medical assistant for Elite Hospital. Below is a subset of pricing rows extracted from the hospital's official Excel pricelists:

<ExcelPricelistData>
${candidatesText}
</ExcelPricelistData>

Match each of the following requested clinical procedures with the pricing rows above:
${proceduresListText}

STRICT MEDICAL EXTRACTION RULES:
1. Handle clinical abbreviations with or without dots (e.g., "EEG" matches "ELECTROENCEPHALOGRAPHY (EEG)", "ECG" matches "Electrocardiogram").
2. Handle synonyms and common clinical variations (e.g., "Echo" matches "Echocardiography").
3. ONLY select procedures and rates explicitly present in <ExcelPricelistData>. DO NOT invent, hallucinate, or estimate prices.
4. For each match, map 'requestedProcedureName' to the exact English name of the requested procedure it matches.
5. Return a JSON array of matches. If none match, return an empty array [].`;

  const responseSchema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        nameArabic: {
          type: Type.STRING,
          description:
            'The name of the procedure in Arabic as text. If there is no Arabic name in the document, return an empty string ("").',
        },
        nameEnglish: {
          type: Type.STRING,
          description: 'The name of the procedure in English as text.',
        },
        price: {
          type: Type.STRING,
          description: 'The price of the procedure. Extract this number as a string.',
        },
        sectionName: {
          type: Type.STRING,
          description: 'The name of the section where the procedure was found',
        },
        sourceFile: {
          type: Type.STRING,
          description: 'The source file name exactly as shown in the candidate row',
        },
        requestedProcedureName: {
          type: Type.STRING,
          description:
            "The exact English name from the prompt's requested list of unmatched procedures that this item match belongs to.",
        },
      },
      required: [
        'nameArabic',
        'nameEnglish',
        'price',
        'sectionName',
        'sourceFile',
        'requestedProcedureName',
      ],
    },
  };

  // Try candidate models in order: gemini-2.5-flash -> gemini-2.0-flash -> gemini-1.5-flash
  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError: any = null;

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            parts: [{ text: promptText }],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema,
        },
      });

      const parsed = JSON.parse(response.text || '[]') as ProcedureResult[];
      return parsed;
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      console.warn(`Gemini model ${model} failed, trying fallback:`, msg);

      // If it's a 403 (Permission denied / Invalid API key), don't retry models as the key is rejected
      if (msg.includes('403') || msg.includes('API key not valid') || msg.includes('PERMISSION_DENIED')) {
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
