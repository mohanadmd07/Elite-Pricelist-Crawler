/**
 * EWS SOAP Response Parsing
 *
 * Replaces regex scraping of Exchange XML with a real parser. The previous
 * `[\s\S]*?` / `[^<]*` patterns in EwsSource.ts corrupted subjects containing
 * encoded entities, leaked To/Cc addresses into `sender`, and treated
 * ResponseElementError blocks as messages.
 *
 * Selectors use escaped namespace prefixes (`t\:Message`) because cheerio's XML
 * mode keeps the prefixed name as the tag; traversal is always scoped to one
 * parent block so sibling sections (From vs ToRecipients) can never
 * cross-contaminate each other.
 */
import { load } from 'cheerio';
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { AttachmentMeta, RawMailMessage } from '../types';

const T = 't\\:';
const M = 'm\\:';

/** Wraps a raw dom node in a scoped cheerio selection. */
const scope = ($: CheerioAPI, node: AnyNode): Cheerio<AnyNode> => $(node);

function textOf(container: Cheerio<AnyNode>, selector: string): string {
  return container.children(selector).first().text().trim();
}

/** Reads an element's character data, decoded exactly once by the XML parser. */
function rawInner($: CheerioAPI, container: Cheerio<AnyNode>, selector: string): string {
  const node = container.children(selector).first();
  if (!node.length) return '';
  // EWS returns the message body as *escaped text* inside <t:Body>, never as
  // nested XML nodes, so .text() yields the decoded HTML fragment directly.
  return node.text().trim();
}

function toIsoUtc(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseAttachments($: CheerioAPI, message: Cheerio<AnyNode>): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  const container = message.children(`${T}Attachments`).first();
  if (!container.length) return attachments;

  container.children().each((_i, el) => {
    const node = scope($, el);
    const localName = ((el as any).name || '').replace(/^t:/i, '');
    if (!/^(FileAttachment|ItemAttachment)$/.test(localName)) return;

    const id = node.children(`${T}AttachmentId`).first().attr('Id') || '';
    const name = node.children(`${T}Name`).first().text().trim();
    const contentType = node.children(`${T}ContentType`).first().text().trim();
    const size = Number(node.children(`${T}Size`).first().text().trim());

    if (!id && !name) return;
    attachments.push({
      id,
      name: name || 'attachment',
      contentType: contentType || 'application/octet-stream',
      sizeBytes: Number.isFinite(size) ? size : 0,
    });
  });

  return attachments;
}

/**
 * Parses a GetItem (or FindItem) response body into messages.
 * Only `<m:Items>` children of Success response messages are considered;
 * Error response messages (ErrorItemNotFound etc.) are skipped by construction.
 */
export function parseGetItemsResponse(xml: string): RawMailMessage[] {
  const $ = load(xml, { xml: true });
  const messages: RawMailMessage[] = [];

  $(`${M}GetItemResponseMessage[ResponseClass="Success"], ${M}FindItemResponseMessage[ResponseClass="Success"]`).each(
    (_i, respEl) => {
      const items = scope($, respEl).children(`${M}Items`).first();

      items.children(`${T}Message`).each((_j, msgEl) => {
        const message = scope($, msgEl);

        const itemIdEl = message.children(`${T}ItemId`).first();
        const id = itemIdEl.attr('Id') || '';
        const changeKey = itemIdEl.attr('ChangeKey') || '';

        const subject = textOf(message, `${T}Subject`);
        const conversationId = message.children(`${T}ConversationId`).first().attr('Id') || '';
        const internetMessageId = textOf(message, `${T}InternetMessageId`);
        const sender = message
          .children(`${T}From`)
          .first()
          .find(`${T}EmailAddress`)
          .first()
          .text()
          .trim();
        const receivedAt = toIsoUtc(textOf(message, `${T}DateTimeReceived`));
        const htmlBody = rawInner($, message, `${T}Body`);

        if (!id) return;

        messages.push({
          id,
          changeKey,
          messageId: internetMessageId || `<${id}@exchange>`,
          conversationId,
          subject,
          sender,
          receivedAt: receivedAt || new Date().toISOString(),
          htmlBody,
          textBody: htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          attachments: parseAttachments($, message),
        });
      });
    },
  );

  return messages;
}

export interface SyncChange {
  id: string;
  changeKey: string;
  kind: 'create' | 'update' | 'delete';
}

/**
 * Extracts changes from a SyncFolderItems response, keeping create/update/delete
 * buckets separate so callers can react to removals instead of re-ingesting them.
 */
export function parseSyncFolderItemsResponse(xml: string): {
  changes: SyncChange[];
  syncState: string | null;
  includesLastItemInRange: boolean;
} {
  const $ = load(xml, { xml: true });
  const changes: SyncChange[] = [];

  $(`${M}SyncFolderItemsResponseMessage`).each((_i, respEl) => {
    const resp = scope($, respEl);
    const responseCode = textOf(resp, `${M}ResponseCode`);
    if (responseCode && responseCode !== 'NoError') return;

    const root = resp.children(`${M}Changes`).first();
    const buckets: Array<['create' | 'update' | 'delete', string]> = [
      ['create', `${M}Create`],
      ['update', `${M}Update`],
      ['delete', `${M}Delete`],
    ];

    for (const [kind, bucketSelector] of buckets) {
      root.children(bucketSelector).each((_k, bucketEl) => {
        scope($, bucketEl)
          .children()
          .each((_m, itemEl) => {
            const node = scope($, itemEl);
            const idEl = node.children(`${T}ItemId`).first();
            const id = idEl.attr('Id') || node.attr('Id');
            if (!id) return;
            changes.push({
              id,
              changeKey: idEl.attr('ChangeKey') || node.attr('ChangeKey') || '',
              kind,
            });
          });
      });
    }
  });

  const syncState = $(`${M}SyncState`).first().text().trim() || null;
  const includesLast =
    $(`${M}IncludesLastItemInRange`).first().text().trim().toLowerCase() === 'true';

  return { changes, syncState, includesLastItemInRange: includesLast };
}
