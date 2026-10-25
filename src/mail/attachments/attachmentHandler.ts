/**
 * Attachment Security and Supabase Storage Handler
 * Enforces filetype whitelisting, size limits, and signed URL generation.
 */

import crypto from 'crypto';
import path from 'path';
import { supabaseAdmin } from '../../lib/supabase';
import { AttachmentMeta } from '../types';

export const BUCKET_NAME = 'approval-attachments';
export const MAX_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024; // 15MB
export const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
]);

export const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.tiff',
  '.tif',
]);

export interface AttachmentValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates file type and size before persisting to storage.
 */
export function validateAttachment(att: AttachmentMeta): AttachmentValidationResult {
  if (att.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File size ${att.sizeBytes} exceeds maximum allowed size of 15MB`,
    };
  }

  const ext = path.extname(att.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `Extension "${ext}" is not permitted for medical attachments`,
    };
  }

  if (att.contentType && !ALLOWED_MIME_TYPES.has(att.contentType.toLowerCase())) {
    // If MIME type is generic application/octet-stream but extension is allowed, proceed cautiously
    if (att.contentType !== 'application/octet-stream') {
      return {
        valid: false,
        reason: `MIME type "${att.contentType}" is not in the allowed list`,
      };
    }
  }

  return { valid: true };
}

/**
 * Uploads a validated attachment buffer to Supabase Storage and returns its metadata and signed URL.
 */
export async function uploadAttachmentToStorage(
  approvalId: string,
  att: AttachmentMeta,
  buffer: Buffer
): Promise<AttachmentMeta> {
  const validation = validateAttachment(att);
  if (!validation.valid) {
    console.warn(`[Attachment Security] ⚠️ Skipped attachment "${att.name}": ${validation.reason}`);
    return {
      ...att,
      contentBase64: undefined, // Drop raw content from memory
    };
  }

  const client = supabaseAdmin;
  if (!client) {
    console.warn('[Attachment Storage] Supabase Admin client not configured; skipping cloud upload.');
    return {
      ...att,
      contentBase64: undefined,
    };
  }

  const year = new Date().getFullYear().toString();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').substring(0, 16);
  const ext = path.extname(att.name).toLowerCase() || '.bin';
  const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `approvals/${year}/${approvalId}/${hash}_${safeName}`;

  try {
    const { error: uploadError } = await client.storage
      .from(BUCKET_NAME)
      .upload(storagePath, buffer, {
        contentType: att.contentType || 'application/octet-stream',
        upsert: true,
      });

    if (uploadError) {
      console.error(`[Attachment Storage] Failed to upload ${storagePath}:`, uploadError.message);
      return { ...att, contentBase64: undefined };
    }

    // Generate signed URL (expires in 60 minutes)
    const { data: signedData, error: signError } = await client.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storagePath, 3600);

    return {
      name: att.name,
      contentType: att.contentType,
      sizeBytes: buffer.length,
      storagePath,
      signedUrl: signError ? undefined : signedData?.signedUrl,
      contentBase64: undefined,
    };
  } catch (err: any) {
    console.error(`[Attachment Storage] Unexpected error uploading ${att.name}:`, err.message || err);
    return { ...att, contentBase64: undefined };
  }
}
