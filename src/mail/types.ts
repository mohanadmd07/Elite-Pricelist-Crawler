/**
 * Types and interfaces for Mail Ingestion Architecture
 * Transport-agnostic design supporting EWS, IMAP, and cloud mail providers.
 */

export interface AttachmentMeta {
  id?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  contentBase64?: string;
  storagePath?: string;
  signedUrl?: string;
}

export interface RawMailMessage {
  id: string; // Transport item ID (e.g. EWS ItemId)
  changeKey?: string;
  messageId: string; // RFC 822 Message-ID (Exchange native or forwarded)
  conversationId: string;
  subject: string;
  sender: string;
  receivedAt: string; // ISO-8601 UTC
  htmlBody: string;
  textBody?: string;
  attachments?: AttachmentMeta[];
}

export interface MailCursor {
  folderName: string;
  token?: string; // EWS SyncState or IMAP UID or Gmail historyId
  lastSyncedAt: string;
  totalSyncedCount?: number;
}

export interface ParsedApprovalEmail {
  patientName: string;
  mrn: string;
  bed?: string;
  admissionType?: string;
  physician?: string;
  contractorRaw: string;
  contractorNormalized: string;
  contractorOfficer?: string;
  priceListYear: string;
  diagnosis: string;
  requestedServices: Array<{
    name: string;
    rawPrice: number;
  }>;
  financialTerms?: {
    patientSharePercentage?: number | null;
    approvedAmountLimit?: number | null;
    coverageConditions?: string;
  };
  hasReplies: boolean;
  hasExistingApproval: boolean;
  isRefused: boolean;
  statusReasonArabic?: string;
  cleanReplyBody?: string;
  isReplyMessage?: boolean;
  attachments: AttachmentMeta[];
  rawBody?: string;
}

export interface MailSyncStats {
  success: boolean;
  messagesFetched: number;
  messagesProcessed: number;
  messagesSkipped: number;
  attachmentsSaved: number;
  durationMs: number;
  nextCursorToken?: string;
  error?: string;
}

export interface MailSource {
  /**
   * Fetches new or updated messages incrementally since the provided cursor.
   */
  fetchSince(
    cursor: MailCursor,
    maxItems?: number
  ): Promise<{
    messages: RawMailMessage[];
    nextCursor: MailCursor;
    moreAvailable: boolean;
  }>;

  /**
   * Health and connectivity test against the remote mail server.
   */
  testConnection(): Promise<{ ok: boolean; message: string }>;
}
