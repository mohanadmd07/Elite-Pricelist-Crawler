/**
 * LLM access for the classifier. One interface so every pass (ledger, verifier,
 * adjudicator, OCR) is mockable and every call is audited with identifiers masked.
 * Reuses @google/genai exactly like services/aiMatchService (GEMINI_API_KEY, temperature 0,
 * JSON mode) and lib/deidentifier for masking.
 */
import { GoogleGenAI } from '@google/genai';
import { redactPhiFromText, type KnownDemographics } from '../lib/deidentifier';
import { sha256 } from './text';

export type LlmPass = 'ledger' | 'verifier' | 'adjudicator' | 'ocr';

export interface LlmRequest {
  pass: LlmPass;
  model: string;
  system: string;
  prompt: string;
  schema: object;
  images?: Array<{ mimeType: string; dataBase64: string }>;
  /** used only to mask the audit log; never sent to the model */
  known?: KnownDemographics;
  approvalKey?: string;
}

export interface LlmClient {
  generateJson<T = any>(req: LlmRequest): Promise<T>;
}

export const MODELS = {
  flash: process.env.CLASSIFIER_FLASH_MODEL || 'gemini-2.5-flash',
  pro: process.env.CLASSIFIER_PRO_MODEL || 'gemini-2.5-pro',
};

export class GeminiLlmClient implements LlmClient {
  private ai: GoogleGenAI;
  constructor(apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '') {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateJson<T = any>(req: LlmRequest): Promise<T> {
    const parts: any[] = [{ text: req.prompt }];
    for (const img of req.images || []) parts.push({ inlineData: { mimeType: img.mimeType, data: img.dataBase64 } });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.ai.models.generateContent({
          model: req.model,
          contents: [{ role: 'user', parts }],
          config: {
            temperature: 0,
            systemInstruction: req.system,
            responseMimeType: 'application/json',
            responseJsonSchema: req.schema as any,
          },
        });
        return JSON.parse(res.text || '{}') as T;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

// ------------------------------------------------------------------- audit --

export interface LlmAuditEntry {
  approval_ref: string | null;
  pass: LlmPass;
  model: string;
  masked_input: string;
  masked_output: string | null;
  error?: string;
}
export interface LlmAuditSink {
  record(e: LlmAuditEntry): Promise<void> | void;
}

const EXTRA_PHI: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]'],
  [/(?:\+?20|0)?1[0125]\d{8}\b/g, '[PHONE]'],
  [/\b\d{14}\b/g, '[NATIONAL_ID]'],
  [/\b(?:0?[1-9]|[12]\d|3[01])[\/\-.](?:0?[1-9]|1[0-2])[\/\-.](?:19|20)\d{2}\b/g, '[DATE]'],
  [/(?:policy\s*(?:no\.?|number|#)?|رقم\s*(?:البوليص[هة]|الوثيق[هة]))\s*[:：#-]?\s*[A-Z0-9\-\/]{4,24}/gi, '[POLICY_REDACTED]'],
];

/** Masks identifiers for logs / pools: known demographics first, then pattern-based redaction. */
export function maskPhi(text: string, known?: KnownDemographics): string {
  let t = redactPhiFromText(text || '', known);
  for (const [re, rep] of EXTRA_PHI) t = t.replace(re, rep);
  return t;
}

export class AuditedLlmClient implements LlmClient {
  constructor(private inner: LlmClient, private sink: LlmAuditSink) {}
  async generateJson<T = any>(req: LlmRequest): Promise<T> {
    const approval_ref = req.approvalKey ? sha256(req.approvalKey).slice(0, 16) : null;
    const masked_input = maskPhi(`${req.system}\n---\n${req.prompt}${req.images?.length ? `\n[${req.images.length} image(s)]` : ''}`, req.known);
    try {
      const out = await this.inner.generateJson<T>(req);
      await this.sink.record({ approval_ref, pass: req.pass, model: req.model, masked_input, masked_output: maskPhi(JSON.stringify(out), req.known) });
      return out;
    } catch (e: any) {
      await this.sink.record({ approval_ref, pass: req.pass, model: req.model, masked_input, masked_output: null, error: String(e?.message || e) });
      throw e;
    }
  }
}

export class SupabaseLlmAuditSink implements LlmAuditSink {
  async record(e: LlmAuditEntry): Promise<void> {
    try {
      const { supabaseAdmin } = await import('../lib/supabase');
      await supabaseAdmin?.from('classifier_llm_log').insert({
        approval_ref: e.approval_ref,
        pass: e.pass,
        model: e.model,
        masked_input: e.masked_input,
        masked_output: e.error ? `ERROR: ${e.error}` : e.masked_output,
      });
    } catch {
      /* audit must never break classification */
    }
  }
}
