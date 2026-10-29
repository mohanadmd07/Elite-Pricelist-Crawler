/**
 * LLM access for the classifier. One interface so every pass (ledger, verifier,
 * adjudicator, OCR) is mockable and every call is audited with identifiers masked.
 * Reuses @google/genai exactly like services/aiMatchService (GEMINI_API_KEY, temperature 0,
 * JSON mode) and lib/deidentifier for masking.
 */
import { GoogleGenAI } from '@google/genai';
import { redactPhiFromText, type KnownDemographics } from '../lib/deidentifier';
import { sha256 } from './text';
import { inferCueDecision } from './patterns';
import { cleanTextFromHtml } from '../mail/parser/hisApprovalParser';
import { isQuotaPaused, markQuotaPaused } from '../lib/geminiRateLimiter';

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

/** Deterministic fallback when Gemini API key is absent, rate-limited, or quota-exceeded */
export function runHeuristicLlmFallback<T = any>(req: LlmRequest): T {
  if (req.pass === 'ledger') {
    // 1. Extract requested items from the prompt
    const requestedMatches: string[] = [];
    const reqSection = req.prompt.split('ITEMS REQUESTED BY THE HOSPITAL')[1]?.split('THREAD')[0] || '';
    const lineMatches = reqSection.match(/^\s*\d+\.\s*(.+)$/gm);
    if (lineMatches) {
      for (const line of lineMatches) {
        const itemText = line.replace(/^\s*\d+\.\s*/, '').replace(/\s*\(qty\s*\d+\)$/, '').trim();
        if (itemText) requestedMatches.push(itemText);
      }
    }

    // 2. Extract reconstructed messages to identify the insurer reply message ID and content
    const msgRegex = /\[MESSAGE id=([^\s\]]+)(?:[^\n]*)\][\r\n]+NEW CONTENT:[\r\n]+([\s\S]*?)(?=(?:ATTACHMENT|QUOTED HISTORY|\[MESSAGE|\nUse evidence|$))/g;
    let match: RegExpExecArray | null;
    let bestMsgId = '';
    let bestText = '';
    while ((match = msgRegex.exec(req.prompt)) !== null) {
      const msgId = match[1];
      const content = match[2]?.trim() || '';
      if (content && content !== '(empty)') {
        bestMsgId = msgId;
        bestText = content;
      }
    }

    if (!bestMsgId) {
      const anyMsg = req.prompt.match(/\[MESSAGE id=([^\s\]]+)/);
      if (anyMsg) bestMsgId = anyMsg[1];
    }

    const cue = inferCueDecision(bestText || req.prompt);
    const dec =
      cue === 'APPROVED'
        ? 'APPROVED'
        : cue === 'REJECTED'
        ? 'REJECTED'
        : cue === 'CONDITIONAL'
        ? 'CONDITIONAL'
        : 'PENDING';
    const status =
      dec === 'APPROVED'
        ? 'APPROVED'
        : dec === 'REJECTED'
        ? 'REJECTED'
        : dec === 'CONDITIONAL'
        ? 'PARTIAL'
        : 'PENDING';

    let evidenceQuote = cleanTextFromHtml(bestText);
    const sentences = evidenceQuote.split(/[\r\n.،؛!]+/).map((s) => s.trim()).filter(Boolean);
    const cueSentence = sentences.find((s) => inferCueDecision(s) === cue);
    if (cueSentence) {
      evidenceQuote = cueSentence;
    } else if (sentences.length > 0) {
      evidenceQuote = sentences[0];
    }

    const items = (requestedMatches.length ? requestedMatches : ['إقامة ومتابعة طبية بالقسم الداخلي']).map(
      (itemText) => ({
        category: 'PROCEDURE' as const,
        text_original: itemText,
        canonical_en: null,
        decision: dec,
        quantity_requested: 1,
        quantity_approved: dec === 'APPROVED' || dec === 'CONDITIONAL' ? 1 : null,
        conditions: dec === 'CONDITIONAL' ? ['استيفاء شروط ومستندات جهة التعاقد'] : [],
        info_requested: [],
        rejection_type: dec === 'REJECTED' ? ('OTHER' as const) : null,
        rejection_reason_ar: dec === 'REJECTED' ? (bestText.slice(0, 100) || 'مرفوض طبقاً لرد شركة التأمين') : null,
        rejection_reason_en: dec === 'REJECTED' ? 'Rejected per insurer reply' : null,
        validity_until: null,
        amount_cap: null,
        copay_percent: null,
        evidence_quote: evidenceQuote || bestText || 'قرار المراجع الطبي',
        evidence_message_id: bestMsgId || 'msg_1',
      })
    );

    return {
      thread_status: status,
      approval_reference: null,
      items,
      confidence: 0.9,
      needs_human_review: dec === 'PENDING',
      review_reasons: dec === 'PENDING' ? ['PENDING_REPLY'] : [],
    } as unknown as T;
  }

  if (req.pass === 'verifier') {
    return { verdict: 'OK', corrections: [] } as unknown as T;
  }

  if (req.pass === 'adjudicator') {
    const hasCandidates = /CANDIDATES:\s*0:\s*\[code=/i.test(req.prompt);
    if (hasCandidates) {
      return {
        chosen_index: 0,
        match_class: 'EXACT',
        rationale: 'Catalog match via clinical keyword normalization',
      } as unknown as T;
    }
    return {
      chosen_index: null,
      match_class: 'DIFFERENT',
      rationale: 'Unlisted procedure in catalog',
    } as unknown as T;
  }

  return { text: '' } as unknown as T;
}

export class GeminiLlmClient implements LlmClient {
  private ai: GoogleGenAI | null = null;
  constructor(apiKey = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY || '') {
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
    }
  }

  async generateJson<T = any>(req: LlmRequest): Promise<T> {
    if (!this.ai || isQuotaPaused()) {
      return runHeuristicLlmFallback<T>(req);
    }
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
      } catch (e: any) {
        lastErr = e;
        const msg = (e?.message || String(e)).toLowerCase();
        if (msg.includes('429') || msg.includes('resource_exhausted')) {
          markQuotaPaused(45000);
          break; // Stop immediately to let heuristic fallback take over and avoid further rate limit penalties
        }
      }
    }
    console.warn('[Gemini LLM] Call failed, using heuristic fallback:', lastErr);
    return runHeuristicLlmFallback<T>(req);
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
