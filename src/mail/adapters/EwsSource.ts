/**
 * EWS Source Adapter
 * Connects directly to Exchange Web Services (EWS) over HTTPS/TLS using NTLM authentication.
 * Implements incremental synchronization via SyncFolderItems and batch retrieval via GetItem.
 */

// @ts-ignore
import httpntlm from 'httpntlm';
import { AttachmentMeta, MailCursor, MailSource, RawMailMessage } from '../types';

export const EXACT_INAPPROVALS_FOLDER_ID =
  'AAMkAGU5Y2EzNmMxLTIwZDItNDcxOC05ZTk0LTBlODJjZjkxOGU5NgAuAAAAAAA4U9epEFcNRbR5QhtWJDZyAQCVKjW+UMYOTr9U/HR/zy7WAAActvclAAA=';

export interface EwsConfig {
  url: string;
  username: string;
  password: string;
  domain: string;
  folderName: string;
}

export class EwsSource implements MailSource {
  private config: EwsConfig;

  constructor(config?: Partial<EwsConfig>) {
    const rawUser = config?.username || process.env.EXCHANGE_USER || process.env.IMAP_USER || '';
    const cleanUser = rawUser.includes('@') ? rawUser.split('@')[0] : rawUser;

    this.config = {
      url: config?.url || process.env.EWS_URL || `https://${process.env.IMAP_HOST || 'wmail.elitehospital.org'}/EWS/Exchange.asmx`,
      username: cleanUser,
      password: config?.password || process.env.EXCHANGE_PASSWORD || process.env.IMAP_PASSWORD || '',
      domain: config?.domain || process.env.EXCHANGE_DOMAIN || 'elitehospital',
      folderName: config?.folderName || process.env.EWS_FOLDER || process.env.IMAP_FOLDER || 'InApprovals',
    };
  }

  /**
   * Executes an NTLM-authenticated SOAP request to the EWS endpoint.
   */
  public async ewsRequest(soapBody: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.config.username || !this.config.password) {
        return reject(new Error('EWS credentials (username/password) are not configured.'));
      }

      httpntlm.post(
        {
          url: this.config.url,
          username: this.config.username,
          password: this.config.password,
          domain: this.config.domain,
          body: soapBody,
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
          },
          rejectUnauthorized: false,
        },
        (err: any, res: any) => {
          if (err) return reject(err);
          if (res.statusCode !== 200) {
            return reject(new Error(`EWS HTTP ${res.statusCode}: ${res.body?.substring(0, 300)}`));
          }
          resolve(res.body);
        }
      );
    });
  }

  /**
   * Tests connectivity to EWS endpoint.
   */
  public async testConnection(): Promise<{ ok: boolean; message: string }> {
    const testSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindFolder Traversal="Shallow">
      <m:FolderShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:FolderShape>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox"/>
      </m:ParentFolderIds>
    </m:FindFolder>
  </soap:Body>
</soap:Envelope>`;

    try {
      const response = await this.ewsRequest(testSoap);
      if (response.includes('FindFolderResponse') && response.includes('ResponseClass="Success"')) {
        return { ok: true, message: 'Successfully authenticated with Exchange EWS.' };
      }
      return { ok: false, message: `EWS response: ${response.substring(0, 200)}` };
    } catch (err: any) {
      return { ok: false, message: `Failed to connect to EWS: ${err.message || err}` };
    }
  }

  /**
   * Resolves the FolderId for a named folder or returns distinguished folder id.
   */
  public async resolveFolderId(folderName: string): Promise<string> {
    const raw = folderName || this.config.folderName || 'InApprovals';
    const lower = raw.toLowerCase();
    if (lower === 'inapprovals' || raw.startsWith('AAMk') || raw.startsWith('AQMk')) {
      return EXACT_INAPPROVALS_FOLDER_ID;
    }
    if (['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(lower)) {
      return lower;
    }

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindFolder Traversal="Deep">
      <m:FolderShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="folder:DisplayName"/>
        </t:AdditionalProperties>
      </m:FolderShape>
      <m:IndexedPageFolderView MaxEntriesReturned="100" Offset="0" BasePoint="Beginning"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="msgfolderroot"/>
      </m:ParentFolderIds>
    </m:FindFolder>
  </soap:Body>
</soap:Envelope>`;

    try {
      const xml = await this.ewsRequest(soap);
      const regex = new RegExp(
        `<t:Folder>[\\s\\S]*?<t:FolderId Id="([^"]+)" ChangeKey="([^"]+)"[\\s\\S]*?<t:DisplayName>${raw}<\\/t:DisplayName>[\\s\\S]*?<\\/t:Folder>`,
        'i'
      );
      const match = xml.match(regex);
      if (match) return match[1];
    } catch (err) {
      console.warn(`[EWS Source] Failed to dynamically resolve folder "${raw}", falling back to default.`, err);
    }

    return EXACT_INAPPROVALS_FOLDER_ID;
  }

  /**
   * Finds recent items in an Exchange folder with date restriction and pagination.
   */
  public async findItemsInFolder(
    folderId: string,
    maxEntries = 100,
    sinceDateIso?: string
  ): Promise<Array<{ id: string; subject: string; dateTimeReceived?: string }>> {
    const isDistinguished = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(folderId.toLowerCase());
    const folderXml = isDistinguished
      ? `<t:DistinguishedFolderId Id="${folderId}"/>`
      : `<t:FolderId Id="${folderId}"/>`;

    const restrictionXml = sinceDateIso
      ? `
      <m:Restriction>
        <t:IsGreaterThanOrEqualTo>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURIOrConstant>
            <t:Constant Value="${sinceDateIso}"/>
          </t:FieldURIOrConstant>
        </t:IsGreaterThanOrEqualTo>
      </m:Restriction>`
      : '';

    const allResults: Array<{ id: string; subject: string; dateTimeReceived?: string }> = [];
    const pageSize = Math.min(maxEntries, 250);

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="0" BasePoint="Beginning"/>
      ${restrictionXml}
      <m:SortOrder>
        <t:FieldOrder Order="Descending">
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        ${folderXml}
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;

    try {
      const xml = await this.ewsRequest(soap);
      const itemMatches = xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g);
      for (const match of itemMatches) {
        const msgBlock = match[1];
        const idMatch = msgBlock.match(/<t:ItemId Id="([^"]+)"/);
        const subjMatch = msgBlock.match(/<t:Subject>([^<]*)<\/t:Subject>/);
        const dateMatch = msgBlock.match(/<t:DateTimeReceived>([^<]*)<\/t:DateTimeReceived>/);
        if (idMatch) {
          allResults.push({
            id: idMatch[1],
            subject: subjMatch ? subjMatch[1] : '',
            dateTimeReceived: dateMatch ? dateMatch[1] : undefined,
          });
        }
      }
    } catch (err) {
      console.warn(`[EWS Source] Error finding items in folder "${folderId}":`, err);
    }

    return allResults;
  }

  /**
   * Fetches full message details in batch for a list of EWS item IDs.
   */
  public async getItemsBatch(itemIds: string[]): Promise<RawMailMessage[]> {
    if (itemIds.length === 0) return [];
    const idsXml = itemIds.map((id) => `<t:ItemId Id="${id}"/>`).join('\n');

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>AllProperties</t:BaseShape>
        <t:BodyType>HTML</t:BodyType>
      </m:ItemShape>
      <m:ItemIds>
        ${idsXml}
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const xml = await this.ewsRequest(soap);
        const messageBlocks = [...xml.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)];

        return messageBlocks.map((mb) => {
          const block = mb[1];
          const idMatch = block.match(/<t:ItemId Id="([^"]+)"(?:\s+ChangeKey="([^"]+)")?/);
          const itemId = idMatch ? idMatch[1] : '';
          const changeKey = idMatch?.[2] || '';
          const subject = block.match(/<t:Subject>([^<]*)<\/t:Subject>/)?.[1] || '';
          const messageId = block.match(/<t:InternetMessageId>([^<]*)<\/t:InternetMessageId>/)?.[1] || `<${itemId}@exchange>`;
          const from = block.match(/<t:From>[\s\S]*?<t:EmailAddress>([^<]+)<\/t:EmailAddress>/)?.[1] || '';
          const bodyHtml = block.match(/<t:Body[^>]*>([\s\S]*?)<\/t:Body>/)?.[1] || '';
          const conversationId = block.match(/<t:ConversationId Id="([^"]+)"/)?.[1] || '';
          const receivedAtStr = block.match(/<t:DateTimeReceived>([^<]+)<\/t:DateTimeReceived>/)?.[1];
          const receivedAt = receivedAtStr ? new Date(receivedAtStr).toISOString() : new Date().toISOString();

          // Extract attachment metadata if present
          const attachments: AttachmentMeta[] = [];
          const attMatches = block.matchAll(/<t:FileAttachment>[\s\S]*?<t:AttachmentId Id="([^"]+)"[\s\S]*?<t:Name>([^<]+)<\/t:Name>(?:[\s\S]*?<t:ContentType>([^<]+)<\/t:ContentType>)?(?:[\s\S]*?<t:Size>([^<]+)<\/t:Size>)?/g);
          for (const am of attMatches) {
            attachments.push({
              id: am[1],
              name: am[2],
              contentType: am[3] || 'application/octet-stream',
              sizeBytes: Number(am[4]) || 0,
            });
          }

          return {
            id: itemId,
            changeKey,
            messageId,
            conversationId,
            subject,
            sender: from,
            receivedAt,
            htmlBody: bodyHtml,
            textBody: bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            attachments,
          };
        });
      } catch (err: any) {
        const isThrottled = String(err).includes('ErrorServerBusy') || String(err).includes('503');
        if (attempt < 3 && isThrottled) {
          const delay = attempt * 1500;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        if (attempt === 3) throw err;
      }
    }

    return [];
  }

  /**
   * Incrementally fetches messages since the given cursor.
   */
  public async fetchSince(
    cursor: MailCursor,
    maxItems: number = 50
  ): Promise<{
    messages: RawMailMessage[];
    nextCursor: MailCursor;
    moreAvailable: boolean;
  }> {
    const folderId = await this.resolveFolderId(cursor.folderName || this.config.folderName);
    const isDistinguished = ['inbox', 'drafts', 'deleteditems', 'sentitems', 'msgfolderroot'].includes(folderId.toLowerCase());
    const folderXml = isDistinguished
      ? `<t:DistinguishedFolderId Id="${folderId}"/>`
      : `<t:FolderId Id="${folderId}"/>`;

    const syncStateXml = cursor.token ? `<m:SyncState>${cursor.token}</m:SyncState>` : '';

    const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:SyncFolderItems>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:ItemShape>
      <m:SyncFolderId>
        ${folderXml}
      </m:SyncFolderId>
      ${syncStateXml}
      <m:MaxChangesReturned>${Math.min(maxItems, 250)}</m:MaxChangesReturned>
      <m:SyncScope>NormalItems</m:SyncScope>
    </m:SyncFolderItems>
  </soap:Body>
</soap:Envelope>`;

    let xml = '';
    try {
      xml = await this.ewsRequest(soap);
    } catch (err: any) {
      if (String(err).includes('ErrorInvalidSyncStateData')) {
        console.warn('[EWS Source] Invalid SyncState token encountered; resetting token and requesting full sync.');
        const resetCursor: MailCursor = { ...cursor, token: undefined };
        return this.fetchSince(resetCursor, maxItems);
      }
      throw err;
    }

    const syncStateMatch = xml.match(/<m:SyncState>([^<]+)<\/m:SyncState>/);
    const nextSyncState = syncStateMatch ? syncStateMatch[1] : cursor.token;
    const includesLast = xml.includes('<m:IncludesLastItemInRange>true</m:IncludesLastItemInRange>');

    const createdIds: string[] = [];
    const createMatches = xml.matchAll(/<t:Create>[\s\S]*?<t:ItemId Id="([^"]+)"/g);
    for (const match of createMatches) {
      createdIds.push(match[1]);
    }

    // If SyncFolderItems returned no items (e.g. initial token or empty delta), fall back to FindItem rolling window
    if (createdIds.length === 0) {
      const defaultSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const sinceDateIso = cursor.lastSyncedAt
        ? new Date(new Date(cursor.lastSyncedAt).getTime() - 24 * 60 * 60 * 1000).toISOString()
        : defaultSince;

      console.log(`[EWS Source] SyncFolderItems returned 0 changes. Running FindItem fallback (since ${sinceDateIso})...`);
      const recentItems = await this.findItemsInFolder(folderId, maxItems, sinceDateIso);
      for (const item of recentItems) {
        if (!createdIds.includes(item.id)) {
          createdIds.push(item.id);
        }
      }
      console.log(`[EWS Source] FindItem fallback discovered ${createdIds.length} candidate items.`);
    }

    const messages = await this.getItemsBatch(createdIds);

    return {
      messages,
      nextCursor: {
        folderName: cursor.folderName,
        token: nextSyncState,
        lastSyncedAt: new Date().toISOString(),
        totalSyncedCount: (cursor.totalSyncedCount || 0) + messages.length,
      },
      moreAvailable: !includesLast && createdIds.length > 0,
    };
  }
}
