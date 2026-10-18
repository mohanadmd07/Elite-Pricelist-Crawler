import { GoogleGenAI, Type } from '@google/genai';
import { ProcedureResult, SelectedProcedure } from '../types';

const apiKey =
  (typeof process !== 'undefined' ? process.env?.GEMINI_API_KEY : '') ||
  import.meta.env.VITE_GEMINI_API_KEY ||
  '';

let aiInstance: GoogleGenAI | null = null;
if (apiKey) {
  aiInstance = new GoogleGenAI({ apiKey });
}

export async function matchProceduresWithAI(
  unmatchedProcedures: SelectedProcedure[],
  candidates: ProcedureResult[]
): Promise<ProcedureResult[]> {
  if (!aiInstance || candidates.length === 0 || unmatchedProcedures.length === 0) {
    return [];
  }

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

  const response = await aiInstance.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        parts: [
          {
            text: `You are an expert AI medical assistant. Below is a subset of pricing rows from the hospital excel price lists (excel sheet data):

<ExcelPricelistData>
${candidatesText}
</ExcelPricelistData>

Compare and search for matches inside the provided data for the following requested procedures (Note: handle synonyms, spelling variations, abbreviations with/without dots, or partial matches. For example, "EEG" matches "ELECTROENCEPHALOGRAPHY (EEG)" or "Routine EEG", and "ECG" matches "Electrocardiogram (ECG)"):
${proceduresListText}

STRICT REQUIREMENT: Only select procedures and rates explicitly present in the <ExcelPricelistData> above. Do not estimate or make up any prices or details.
For each matched procedure, map it to the exact English name of the requested procedure this item is a match for (requestedProcedureName).
Return a JSON array of matches. If none found, return an empty array []`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
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
      },
    },
  });

  return JSON.parse(response.text || '[]') as ProcedureResult[];
}
