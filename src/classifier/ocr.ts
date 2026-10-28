/**
 * Pass 1 attachment OCR via Gemini vision (enabled by default per Phase 0 Q5 answer;
 * disable with CLASSIFIER_OCR_ENABLED=false).
 */
import { MODELS, type LlmClient } from './llm';
import { OCR_JSON_SCHEMA, OCR_SYSTEM_PROMPT } from './prompts';
import type { KnownDemographics } from '../lib/deidentifier';

export interface BinaryAttachment {
  name: string;
  mimeType: string;
  contentBase64?: string;
  text?: string;
}

export function isOcrEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.CLASSIFIER_OCR_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export async function extractAttachmentText(
  llm: LlmClient,
  att: BinaryAttachment,
  opts: { known?: KnownDemographics; approvalKey?: string; env?: Record<string, string | undefined> } = {}
): Promise<string> {
  if (att.text && att.text.trim()) return att.text;
  if (!isOcrEnabled(opts.env) || !att.contentBase64) return '';
  try {
    const res = await llm.generateJson<{ text?: string }>({
      pass: 'ocr',
      model: MODELS.flash,
      system: OCR_SYSTEM_PROMPT,
      prompt: `Attachment filename: ${att.name}`,
      schema: OCR_JSON_SCHEMA,
      images: [{ mimeType: att.mimeType || 'application/pdf', dataBase64: att.contentBase64 }],
      known: opts.known,
      approvalKey: opts.approvalKey,
    });
    return (res?.text || '').trim();
  } catch {
    return '';
  }
}
