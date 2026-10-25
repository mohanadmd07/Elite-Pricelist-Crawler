var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/mail/syncEngine.ts
import fs2 from "fs";
import path3 from "path";

// src/mail/adapters/EwsSource.ts
import httpntlm from "httpntlm";
var EXACT_INAPPROVALS_FOLDER_ID = "AAMkAGU5Y2EzNmMxLTIwZDItNDcxOC05ZTk0LTBlODJjZjkxOGU5NgAuAAAAAAA4U9epEFcNRbR5QhtWJDZyAQCVKjW+UMYOTr9U/HR/zy7WAAActvclAAA=";
var DEFAULT_OUTLOOK_SIGNATURE_HTML = `
<br><br>
<table class="MsoNormalTable" border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse">
  <tbody>
    <tr>
      <td style="padding: 0cm 5.4pt;">
        <p class="MsoNormal" style="margin: 0cm; font-size: 9.5pt; font-family: 'Maiandra GD', Calibri, sans-serif; color: gray;">
          <b>Mohanad M. El Maamoun</b><br>
          Duty Manager | Elite Hospital<br>
          <b><u>Mob.:</u></b> &nbsp; 01148085552<br>
          <b><u>Email:</u></b> &nbsp; <a href="mailto:Mohanad.elmaamoun@elitehospital.org" style="color: #467886; text-decoration: underline;">Mohanad.elmaamoun@elitehospital.org</a>
        </p>
      </td>
    </tr>
  </tbody>
</table>`;
var DEFAULT_OUTLOOK_SIGNATURE_TEXT = `

Mohanad M. El Maamoun
Duty Manager | Elite Hospital
Mob.:    01148085552
Email:  Mohanad.elmaamoun@elitehospital.org`;
var EwsSource = class {
  constructor(config) {
    const rawUser = config?.username || process.env.EXCHANGE_USER || process.env.IMAP_USER || "";
    const cleanUser = rawUser.includes("@") ? rawUser.split("@")[0] : rawUser;
    this.config = {
      url: config?.url || process.env.EWS_URL || `https://${process.env.IMAP_HOST || "wmail.elitehospital.org"}/EWS/Exchange.asmx`,
      username: cleanUser,
      password: config?.password || process.env.EXCHANGE_PASSWORD || process.env.IMAP_PASSWORD || "",
      domain: config?.domain || process.env.EXCHANGE_DOMAIN || "elitehospital",
      folderName: config?.folderName || process.env.EWS_FOLDER || process.env.IMAP_FOLDER || "InApprovals"
    };
  }
  /**
   * Executes an NTLM-authenticated SOAP request to the EWS endpoint.
   */
  async ewsRequest(soapBody) {
    return new Promise((resolve, reject) => {
      if (!this.config.username || !this.config.password) {
        return reject(new Error("EWS credentials (username/password) are not configured."));
      }
      httpntlm.post(
        {
          url: this.config.url,
          username: this.config.username,
          password: this.config.password,
          domain: this.config.domain,
          body: soapBody,
          headers: {
            "Content-Type": "text/xml; charset=utf-8"
          },
          rejectUnauthorized: false
        },
        (err, res) => {
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
  async testConnection() {
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
      if (response.includes("FindFolderResponse") && response.includes('ResponseClass="Success"')) {
        return { ok: true, message: "Successfully authenticated with Exchange EWS." };
      }
      return { ok: false, message: `EWS response: ${response.substring(0, 200)}` };
    } catch (err) {
      return { ok: false, message: `Failed to connect to EWS: ${err.message || err}` };
    }
  }
  /**
   * Resolves the FolderId for a named folder or returns distinguished folder id.
   */
  async resolveFolderId(folderName) {
    const raw = folderName || this.config.folderName || "InApprovals";
    const lower = raw.toLowerCase();
    if (lower === "inapprovals" || raw.startsWith("AAMk") || raw.startsWith("AQMk")) {
      return EXACT_INAPPROVALS_FOLDER_ID;
    }
    if (["inbox", "drafts", "deleteditems", "sentitems", "msgfolderroot"].includes(lower)) {
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
        "i"
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
  async findItemsInFolder(folderId, maxEntries = 100, sinceDateIso) {
    const isDistinguished = ["inbox", "drafts", "deleteditems", "sentitems", "msgfolderroot"].includes(folderId.toLowerCase());
    const folderXml = isDistinguished ? `<t:DistinguishedFolderId Id="${folderId}"/>` : `<t:FolderId Id="${folderId}"/>`;
    const restrictionXml = sinceDateIso ? `
      <m:Restriction>
        <t:IsGreaterThanOrEqualTo>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURIOrConstant>
            <t:Constant Value="${sinceDateIso}"/>
          </t:FieldURIOrConstant>
        </t:IsGreaterThanOrEqualTo>
      </m:Restriction>` : "";
    const allResults = [];
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
            subject: subjMatch ? subjMatch[1] : "",
            dateTimeReceived: dateMatch ? dateMatch[1] : void 0
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
  async getItemsBatch(itemIds) {
    if (itemIds.length === 0) return [];
    const idsXml = itemIds.map((id) => `<t:ItemId Id="${id}"/>`).join("\n");
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
          const itemId = idMatch ? idMatch[1] : "";
          const changeKey = idMatch?.[2] || "";
          const subject = block.match(/<t:Subject>([^<]*)<\/t:Subject>/)?.[1] || "";
          const messageId = block.match(/<t:InternetMessageId>([^<]*)<\/t:InternetMessageId>/)?.[1] || `<${itemId}@exchange>`;
          const from = block.match(/<t:From>[\s\S]*?<t:EmailAddress>([^<]+)<\/t:EmailAddress>/)?.[1] || "";
          const bodyHtml = block.match(/<t:Body[^>]*>([\s\S]*?)<\/t:Body>/)?.[1] || "";
          const conversationId = block.match(/<t:ConversationId Id="([^"]+)"/)?.[1] || "";
          const receivedAtStr = block.match(/<t:DateTimeReceived>([^<]+)<\/t:DateTimeReceived>/)?.[1];
          const receivedAt = receivedAtStr ? new Date(receivedAtStr).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
          const attachments = [];
          const attMatches = block.matchAll(/<t:FileAttachment>[\s\S]*?<t:AttachmentId Id="([^"]+)"[\s\S]*?<t:Name>([^<]+)<\/t:Name>(?:[\s\S]*?<t:ContentType>([^<]+)<\/t:ContentType>)?(?:[\s\S]*?<t:Size>([^<]+)<\/t:Size>)?/g);
          for (const am of attMatches) {
            attachments.push({
              id: am[1],
              name: am[2],
              contentType: am[3] || "application/octet-stream",
              sizeBytes: Number(am[4]) || 0
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
            textBody: bodyHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
            attachments
          };
        });
      } catch (err) {
        const isThrottled = String(err).includes("ErrorServerBusy") || String(err).includes("503");
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
  async fetchSince(cursor, maxItems = 50) {
    const folderId = await this.resolveFolderId(cursor.folderName || this.config.folderName);
    const isDistinguished = ["inbox", "drafts", "deleteditems", "sentitems", "msgfolderroot"].includes(folderId.toLowerCase());
    const folderXml = isDistinguished ? `<t:DistinguishedFolderId Id="${folderId}"/>` : `<t:FolderId Id="${folderId}"/>`;
    const syncStateXml = cursor.token ? `<m:SyncState>${cursor.token}</m:SyncState>` : "";
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
    let xml = "";
    try {
      xml = await this.ewsRequest(soap);
    } catch (err) {
      if (String(err).includes("ErrorInvalidSyncStateData")) {
        console.warn("[EWS Source] Invalid SyncState token encountered; resetting token and requesting full sync.");
        const resetCursor = { ...cursor, token: void 0 };
        return this.fetchSince(resetCursor, maxItems);
      }
      throw err;
    }
    const syncStateMatch = xml.match(/<m:SyncState>([^<]+)<\/m:SyncState>/);
    const nextSyncState = syncStateMatch ? syncStateMatch[1] : cursor.token;
    const includesLast = xml.includes("<m:IncludesLastItemInRange>true</m:IncludesLastItemInRange>");
    const createdIds = [];
    const createMatches = xml.matchAll(/<t:Create>[\s\S]*?<t:ItemId Id="([^"]+)"/g);
    for (const match of createMatches) {
      createdIds.push(match[1]);
    }
    if (createdIds.length === 0) {
      const defaultSince = new Date(Date.now() - 3 * 24 * 60 * 60 * 1e3).toISOString();
      const sinceDateIso = cursor.lastSyncedAt ? new Date(new Date(cursor.lastSyncedAt).getTime() - 24 * 60 * 60 * 1e3).toISOString() : defaultSince;
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
        lastSyncedAt: (/* @__PURE__ */ new Date()).toISOString(),
        totalSyncedCount: (cursor.totalSyncedCount || 0) + messages.length
      },
      moreAvailable: !includesLast && createdIds.length > 0
    };
  }
  /**
   * Searches for an email in Exchange by its InternetMessageId or ConversationId
   * to obtain the exact EWS ItemId and fresh ChangeKey required for in-thread Reply-All.
   */
  async findItemByMessageIdOrConversation(messageId, conversationId, folderId = EXACT_INAPPROVALS_FOLDER_ID) {
    const cleanMsgId = messageId ? messageId.replace(/&lt;|&gt;|<|>/g, "").trim() : "";
    if (cleanMsgId) {
      try {
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
          <t:FieldURI FieldURI="message:InternetMessageId"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:Restriction>
        <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
          <t:FieldURI FieldURI="message:InternetMessageId"/>
          <t:Constant Value="${cleanMsgId}"/>
        </t:Contains>
      </m:Restriction>
      <m:ParentFolderIds>
        <t:FolderId Id="${folderId}"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;
        const resp = await this.ewsRequest(soap);
        const match = resp.match(/<t:ItemId Id="([^"]+)"(?:\s+ChangeKey="([^"]+)")?/);
        if (match) {
          console.log(`[EWS] Discovered target message by InternetMessageId: ${match[1].substring(0, 30)}...`);
          return { itemId: match[1], changeKey: match[2] || "" };
        }
      } catch (err) {
        console.warn(`[EWS] Search by InternetMessageId note:`, err?.message || err);
      }
    }
    if (conversationId) {
      try {
        const convSoap = `<?xml version="1.0" encoding="utf-8"?>
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
          <t:FieldURI FieldURI="item:ConversationId"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ParentFolderIds>
        <t:FolderId Id="${folderId}"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>`;
        const resp = await this.ewsRequest(convSoap);
        const messageBlocks = [...resp.matchAll(/<t:Message>([\s\S]*?)<\/t:Message>/g)];
        for (const mb of messageBlocks) {
          const block = mb[1];
          if (block.includes(conversationId)) {
            const idMatch = block.match(/<t:ItemId Id="([^"]+)"(?:\s+ChangeKey="([^"]+)")?/);
            if (idMatch) {
              console.log(`[EWS] Discovered target message by ConversationId: ${idMatch[1].substring(0, 30)}...`);
              return { itemId: idMatch[1], changeKey: idMatch[2] || "" };
            }
          }
        }
      } catch (err) {
        console.warn(`[EWS] Search by ConversationId note:`, err?.message || err);
      }
    }
    return null;
  }
  /**
   * Creates an in-thread "Reply All" draft in Exchange using EWS ReplyAllToItem.
   * - Preserves the entire email thread (same conversation, topic, and quoted history).
   * - Automatically includes all original "To" and "Cc" recipients.
   * - Automatically includes the user's predefined Outlook signature below the draft text.
   */
  async createDraft(params) {
    const { itemId, changeKey, messageId, conversationId, body, subject, to, signatureHtml, signatureText } = params;
    const activeSignatureHtml = signatureHtml || process.env.OUTLOOK_SIGNATURE_HTML || DEFAULT_OUTLOOK_SIGNATURE_HTML;
    const activeSignatureText = signatureText || process.env.OUTLOOK_SIGNATURE_TEXT || DEFAULT_OUTLOOK_SIGNATURE_TEXT;
    const formattedDraftHtml = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    const fullDraftHtml = `<div style="font-family: Calibri, Aptos, Arial, sans-serif; font-size: 11pt; color: #000000;">${formattedDraftHtml}${activeSignatureHtml}</div>`;
    const fullDraftText = `${body}
${activeSignatureText}`;
    let targetItemId = itemId && !itemId.includes("@") && itemId.length > 40 ? itemId : "";
    let targetChangeKey = changeKey || "";
    if (!targetItemId && (messageId || conversationId || itemId)) {
      const found = await this.findItemByMessageIdOrConversation(messageId || itemId, conversationId);
      if (found) {
        targetItemId = found.itemId;
        targetChangeKey = found.changeKey;
      }
    }
    if (targetItemId) {
      if (!targetChangeKey) {
        try {
          const getXml = `<?xml version="1.0" encoding="utf-8"?>
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
        <t:BaseShape>IdOnly</t:BaseShape>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${targetItemId}"/>
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
          const resp = await this.ewsRequest(getXml);
          const ckMatch = resp.match(/ChangeKey="([^"]+)"/);
          if (ckMatch) targetChangeKey = ckMatch[1];
        } catch (err) {
          console.warn("[EWS] Could not retrieve fresh ChangeKey:", err?.message || err);
        }
      }
      if (targetChangeKey) {
        const replySoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:Items>
        <t:ReplyAllToItem>
          <t:ReferenceItemId Id="${targetItemId}" ChangeKey="${targetChangeKey}" />
          <t:NewBodyContent BodyType="HTML">${fullDraftHtml.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t:NewBodyContent>
        </t:ReplyAllToItem>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;
        try {
          const xml = await this.ewsRequest(replySoap);
          if (xml.includes('ResponseClass="Success"')) {
            const draftIdMatch = xml.match(/<t:ItemId Id="([^"]+)"/);
            const createdDraftId = draftIdMatch ? draftIdMatch[1] : void 0;
            console.log(`[EWS] In-thread Reply-All draft created successfully in same thread with all To/Cc recipients and signature.`);
            return {
              success: true,
              mode: "reply_all",
              draftId: createdDraftId
            };
          } else {
            console.warn(`[EWS] ReplyAllToItem non-success, falling back to standalone draft:`, xml.substring(0, 300));
          }
        } catch (err) {
          console.warn("[EWS] ReplyAllToItem failed, falling back to standalone draft:", err?.message || err);
        }
      }
    }
    console.log(`[EWS] Creating standalone draft in Drafts folder...`);
    const standaloneSoap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:SavedItemFolderId>
        <t:DistinguishedFolderId Id="drafts"/>
      </m:SavedItemFolderId>
      <m:Items>
        <t:Message>
          <t:Subject>${subject.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t:Subject>
          <t:Body BodyType="HTML">${fullDraftHtml.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t:Body>
          <t:ToRecipients>
            <t:Mailbox>
              <t:EmailAddress>${to || "corporate@elitehospital.org"}</t:EmailAddress>
            </t:Mailbox>
          </t:ToRecipients>
        </t:Message>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;
    try {
      const xml = await this.ewsRequest(standaloneSoap);
      if (xml.includes('ResponseClass="Success"')) {
        const draftIdMatch = xml.match(/<t:ItemId Id="([^"]+)"/);
        const createdDraftId = draftIdMatch ? draftIdMatch[1] : void 0;
        console.log(`[EWS] Standalone draft created in Exchange Drafts folder.`);
        return {
          success: true,
          mode: "standalone",
          draftId: createdDraftId
        };
      }
      return { success: false, mode: "standalone", error: xml.substring(0, 300) };
    } catch (err) {
      return { success: false, mode: "standalone", error: err?.message || String(err) };
    }
  }
};

// src/mail/parser/hisApprovalParser.ts
import * as cheerio from "cheerio";

// src/lib/arabic-normalizer.ts
function normalizeArabic(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 15)).replace(/[أإآا]/g, "\u0627").replace(/[ىيی]/g, "\u064A").replace(/[كک]/g, "\u0643").replace(/[ةهھۀ]/g, "\u0647").replace(/[ئؤ]/g, "\u0621").replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, " ").replace(/\s+/g, " ").trim();
}
var HOMOGLYPH_MAP = {
  // Greek
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u0397": "H",
  "\u0399": "I",
  "\u039A": "K",
  "\u039C": "M",
  "\u039D": "N",
  "\u039F": "O",
  "\u03A1": "P",
  "\u03A4": "T",
  "\u03A7": "X",
  "\u03B1": "a",
  "\u03B2": "b",
  "\u03B5": "e",
  "\u03B7": "h",
  "\u03B9": "i",
  "\u03BA": "k",
  "\u03BC": "m",
  "\u03BD": "n",
  "\u03BF": "o",
  "\u03C1": "p",
  "\u03C4": "t",
  "\u03C7": "x",
  // Cyrillic
  "\u0410": "A",
  "\u0412": "B",
  "\u0415": "E",
  "\u041D": "H",
  "\u041C": "M",
  "\u041E": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0406": "I",
  "\u0430": "a",
  "\u0435": "e",
  "\u043E": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
  "\u043D": "h",
  "\u0433": "r"
};
function normalizeHomoglyphs(str) {
  if (!str) return "";
  return str.replace(/[\u0391-\u03c7\u0400-\u045f]/g, (ch) => HOMOGLYPH_MAP[ch] || ch);
}
function normalizeText(str) {
  if (!str) return "";
  let normalized = normalizeHomoglyphs(str).toLowerCase();
  normalized = normalized.replace(/\b([a-z])\s*\.\s*/g, "$1");
  normalized = normalized.replace(/\bporta\s*[- ]\s*cath\b/g, "portacath").replace(/\bport\s*[- ]\s*a\s*[- ]\s*cath\b/g, "portacath").replace(/\bpig\s*[- ]\s*tail\b/g, "pigtail").replace(/\btrue?\s*[- ]\s*cut\b/g, "trucut").replace(/\bintercostal\s*tube\b/g, "intercostal tube");
  normalized = normalized.replace(/\s*[-/,]\s*(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)\b/g, "").replace(/\s+\b(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)$/g, "");
  return normalized.replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 15)).replace(/[أإآا]/g, "\u0627").replace(/[ىيی]/g, "\u064A").replace(/[كک]/g, "\u0643").replace(/[ةهھۀ]/g, "\u0647").replace(/[ئؤ]/g, "\u0621").replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, " ").replace(/\s+/g, " ").trim();
}
function cleanContractorName(str) {
  if (!str) return "";
  let cleaned = str.replace(/<[^>]+>/g, " ").replace(/^Name:\s*/i, "").replace(/^Contractor(?:\s*Name)?\s*[:\s]*/i, "");
  cleaned = cleaned.replace(/\(?\bmain\b\)?/gi, " ");
  cleaned = cleaned.replace(/(?:^|\s+)(?:ال)?شرك[ةه](?=\s+|$)/gu, " ");
  cleaned = cleaned.replace(/^(?:Cash|كاش)\s+(?=[\u0600-\u06FF])/i, "");
  cleaned = cleaned.replace(/[-–—:_]+/g, " ");
  if (/^MT[\u0600-\u06FF]/i.test(cleaned.trim())) {
    cleaned = cleaned.trim().replace(/^MT\s*/i, "") + " MT";
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (/^(?:Contractor|تعاقد|شركة|شركه)$/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}
function stripSentFromSignatures(input) {
  if (!input) return "";
  return input.replace(/(?:Sent\s+from|Sent\s+with|Send\s+from)\s+[^\r\n.<>]+/gi, " ").replace(/Get\s+Outlook(?:\s+for\s+[a-zA-Z]+)?/gi, " ").replace(/(?:تم\s+الإرسال\s+من|تم\s+الارسال\s+من|أرسلت\s+من|ارسلت\s+من)\s+[^\r\n.<>]+/gi, " ").replace(/(?:احصل|أحصل)\s+على\s+[^\r\n.<>]+/gi, " ").replace(/From:\s*[^<]+Sent:\s*[^<]+To:[^\r\n.<>]*/gi, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}
function cleanHisProcedureQuery(query2) {
  if (!query2) return "";
  let trimmed = normalizeHomoglyphs(query2).trim();
  trimmed = trimmed.replace(/\s*(?:حيث\s*(?:انه|أنها|أنه|انها)|نظرا\s*(?:لانه|لأنها|لوجود|لأنه)|بسبب|نظرا|لتشخيص)\s+.*$/i, "");
  trimmed = trimmed.replace(/\s*(?:due to|because of|for evaluation of|for suspected)\s+.*$/i, "");
  if (/^(?:t\.?e\.?e\.?)(?:\s*-\s*investigation|\s*-\s*procedure|\s*echocardiography)?$/i.test(trimmed)) {
    return "Transesophageal Echocardiography (TEE)";
  }
  return trimmed.replace(/\s*-\s*investigation\b/gi, "").replace(/\binvestigation\b/gi, "").replace(/\s*-\s*procedure\b/gi, "").replace(/\s*-\s*service\b/gi, "").replace(/\s*-\s*profile\b/gi, "").replace(/\b(citrulinated)\b/gi, "citrullinated").replace(/\(d\.s\)/gi, "(d's)").replace(/\s+/g, " ").trim();
}
var MEDICAL_SYNONYMS = {
  // Cardiology / Cath Lab / Interventions
  "pci": ["therapeutic cardiac catheter", "balloon diltation+stent", "balloon dilatation", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629", "\u062F\u0639\u0627\u0645\u0629", "\u062A\u0648\u0633\u064A\u0639 \u0628\u0627\u0644\u0628\u0627\u0644\u0648\u0646"],
  "staged pci": ["therapeutic cardiac catheter", "balloon diltation+stent", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629", "\u062F\u0639\u0627\u0645\u0629"],
  "primary pci": ["therapeutic cardiac catheter", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629", "\u062F\u0639\u0627\u0645\u0629"],
  "ptca": ["therapeutic cardiac catheter", "balloon dilatation", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629"],
  "coronary angiography": ["diagnostic cardiac catheter", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u062A\u0634\u062E\u064A\u0635\u064A\u0629", "\u0642\u0633\u0637\u0631\u0629 \u062A\u0634\u062E\u064A\u0635\u064A\u0629"],
  "cardiac catheter": ["diagnostic cardiac catheter", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u062A\u0634\u062E\u064A\u0635\u064A\u0629", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629"],
  "\u0642\u0633\u0637\u0631\u0629 \u0642\u0644\u0628": ["diagnostic cardiac catheter", "therapeutic cardiac catheter", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u062A\u0634\u062E\u064A\u0635\u064A\u0629", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629"],
  "\u0642\u0633\u0637\u0631\u0629 \u062A\u0634\u062E\u064A\u0635\u064A\u0629": ["diagnostic cardiac catheter", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u062A\u0634\u062E\u064A\u0635\u064A\u0629"],
  "\u0642\u0633\u0637\u0631\u0629 \u0639\u0644\u0627\u062C\u064A\u0629": ["therapeutic cardiac catheter", "balloon diltation+stent", "\u0642\u0633\u0637\u0631\u0629 \u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0639\u0644\u0627\u062C\u064A\u0629"],
  "cabg": ["open heart", "\u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0645\u0641\u062A\u0648\u062D"],
  "open heart": ["open heart", "\u0627\u0644\u0642\u0644\u0628 \u0627\u0644\u0645\u0641\u062A\u0648\u062D"],
  "\u0642\u0644\u0628 \u0645\u0641\u062A\u0648\u062D": ["open heart"],
  "tee": ["transesophageal echocardiography", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0642\u0644\u0628 \u0639\u0646 \u0637\u0631\u064A\u0642 \u0627\u0644\u0645\u0631\u064A\u0621"],
  "\u0645\u0631\u064A\u0621": ["transesophageal echocardiography", "tee"],
  "tte": ["echocardiography", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u0642\u0644\u0628", "\u0627\u064A\u0643\u0648"],
  "echo": ["echocardiography", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u0642\u0644\u0628", "\u0627\u064A\u0643\u0648"],
  "echocardiography": ["echocardiography", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u0642\u0644\u0628", "\u0627\u064A\u0643\u0648"],
  "\u0627\u064A\u0643\u0648": ["echocardiography", "echo", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u0642\u0644\u0628"],
  "pacemaker": ["single chamber pacemaker", "dual chamber pacemaker", "\u0645\u0646\u0638\u0645 \u0636\u0631\u0628\u0627\u062A \u0627\u0644\u0642\u0644\u0628"],
  "\u0645\u0646\u0638\u0645 \u0636\u0631\u0628\u0627\u062A": ["pacemaker", "\u0645\u0646\u0638\u0645 \u0636\u0631\u0628\u0627\u062A \u0627\u0644\u0642\u0644\u0628"],
  "ablation": ["simple ablation", "cryo ablation", "\u062F\u0631\u0627\u0633\u0629 \u0643\u0647\u0631\u0648\u0641\u0633\u064A\u0648\u0644\u0648\u062C\u064A\u0627 \u0627\u0644\u0642\u0644\u0628 \u0648\u0627\u0644\u0643\u064A"],
  "\u0643\u0647\u0631\u0648\u0641\u0633\u064A\u0648\u0644\u0648\u062C\u064A\u0627": ["ablation", "\u062F\u0631\u0627\u0633\u0629 \u0643\u0647\u0631\u0648\u0641\u0633\u064A\u0648\u0644\u0648\u062C\u064A\u0627 \u0627\u0644\u0642\u0644\u0628"],
  // Endoscopy / GIT
  "colonoscopy": ["lower git endoscopy", "\u0645\u0646\u0638\u0627\u0631 \u0642\u0648\u0644\u0648\u0646", "\u0645\u0646\u0638\u0627\u0631 \u0627\u0644\u0642\u0648\u0644\u0648\u0646"],
  "\u0645\u0646\u0638\u0627\u0631 \u0642\u0648\u0644\u0648\u0646": ["lower git endoscopy", "colonoscopy"],
  "gastroscopy": ["upper git endoscopy", "\u0645\u0646\u0638\u0627\u0631 \u0645\u0639\u062F\u0629", "\u0645\u0646\u0638\u0627\u0631 \u0627\u0644\u0645\u0639\u062F\u0629"],
  "\u0645\u0646\u0638\u0627\u0631 \u0645\u0639\u062F\u0629": ["upper git endoscopy", "gastroscopy"],
  "ogd": ["upper git endoscopy", "\u0645\u0646\u0638\u0627\u0631 \u0645\u0639\u062F\u0629"],
  "upper endoscopy": ["upper git endoscopy", "\u0645\u0646\u0638\u0627\u0631 \u062C\u0647\u0627\u0632 \u0647\u0636\u0645\u064A \u0639\u0644\u0648\u064A"],
  "lower endoscopy": ["lower git endoscopy", "\u0645\u0646\u0638\u0627\u0631 \u062C\u0647\u0627\u0632 \u0647\u0636\u0645\u064A \u0633\u0641\u0644\u064A"],
  "ercp": ["ercp diagnostic", "ercp with stent", "\u0645\u0646\u0638\u0627\u0631 \u062A\u0634\u062E\u064A\u0635\u064A \u0644\u0644\u0642\u0646\u0648\u0627\u062A \u0627\u0644\u0645\u0631\u0627\u0631\u064A\u0629", "\u0645\u0646\u0638\u0627\u0631 \u0642\u0646\u0648\u0627\u062A \u0645\u0631\u0627\u0631\u064A\u0629"],
  "\u0642\u0646\u0648\u0627\u062A \u0645\u0631\u0627\u0631\u064A\u0629": ["ercp", "\u0645\u0646\u0638\u0627\u0631 \u0642\u0646\u0648\u0627\u062A \u0645\u0631\u0627\u0631\u064A\u0629"],
  "polypectomy": ["removal of duodenal polyps", "\u0625\u0632\u0627\u0644\u0629 \u0632\u0648\u0627\u0626\u062F \u0628\u0627\u0644\u0642\u0648\u0644\u0648\u0646", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0632\u0648\u0627\u0626\u062F"],
  "\u0632\u0648\u0627\u0626\u062F \u0628\u0627\u0644\u0642\u0648\u0644\u0648\u0646": ["removal of duodenal polyps", "polypectomy"],
  "gastric balloon": ["gastric balloon insertion", "\u062A\u0631\u0643\u064A\u0628 \u0628\u0627\u0644\u0648\u0646 \u0645\u0639\u062F\u0629"],
  "\u0628\u0627\u0644\u0648\u0646 \u0645\u0639\u062F\u0629": ["gastric balloon"],
  // General Surgery / Laparoscopy
  "cholecystectomy": ["\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u0645\u0631\u0627\u0631\u0629", "\u0645\u0631\u0627\u0631\u0629 \u0628\u0627\u0644\u0645\u0646\u0638\u0627\u0631", "gallbladder"],
  "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u0645\u0631\u0627\u0631\u0629": ["cholecystectomy", "laparoscopic cholecystectomy", "\u0645\u0631\u0627\u0631\u0629"],
  "\u0645\u0631\u0627\u0631\u0629": ["cholecystectomy", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u0645\u0631\u0627\u0631\u0629"],
  "appendectomy": ["\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u0632\u0627\u0626\u062F\u0629", "\u0632\u0627\u0626\u062F\u0629 \u062F\u0648\u062F\u064A\u0629"],
  "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u0632\u0627\u0626\u062F\u0629": ["appendectomy", "\u0632\u0627\u0626\u062F\u0629 \u062F\u0648\u062F\u064A\u0629"],
  "\u0632\u0627\u0626\u062F\u0629": ["appendectomy", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u0632\u0627\u0626\u062F\u0629"],
  "hernia": ["\u0641\u062A\u0642", "hernioplasty", "repair of hernia", "\u0627\u0635\u0644\u0627\u062D \u0641\u062A\u0642"],
  "hernioplasty": ["hernia", "\u0641\u062A\u0642", "\u0627\u0635\u0644\u0627\u062D \u0641\u062A\u0642"],
  "\u0641\u062A\u0642": ["hernia", "hernioplasty", "\u0627\u0635\u0644\u0627\u062D \u0641\u062A\u0642"],
  "splenectomy": ["\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0637\u062D\u0627\u0644"],
  "\u0637\u062D\u0627\u0644": ["splenectomy", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0637\u062D\u0627\u0644"],
  "thyroidectomy": ["\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u063A\u062F\u0629 \u0627\u0644\u062F\u0631\u0642\u064A\u0629", "\u063A\u062F\u0629 \u062F\u0631\u0642\u064A\u0629"],
  "\u063A\u062F\u0629 \u062F\u0631\u0642\u064A\u0629": ["thyroidectomy", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0627\u0644\u063A\u062F\u0629 \u0627\u0644\u062F\u0631\u0642\u064A\u0629"],
  "mastectomy": ["\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u062B\u062F\u064A", "\u0623\u0648\u0631\u0627\u0645 \u0627\u0644\u062B\u062F\u064A"],
  "fistula": ["\u0646\u0627\u0633\u0648\u0631", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0646\u0627\u0633\u0648\u0631"],
  "\u0646\u0627\u0633\u0648\u0631": ["fistula", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0646\u0627\u0633\u0648\u0631"],
  "fissure": ["\u0634\u0631\u062E", "\u0639\u0644\u0627\u062C \u0634\u0631\u062E \u0634\u0631\u062C\u064A"],
  "\u0634\u0631\u062E": ["fissure"],
  "hemorrhoids": ["\u0628\u0648\u0627\u0633\u064A\u0631", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0628\u0648\u0627\u0633\u064A\u0631"],
  "\u0628\u0648\u0627\u0633\u064A\u0631": ["hemorrhoids"],
  // Neurology / Neurophysiology
  "eeg": ["electroencephalography", "\u0631\u0633\u0645 \u0645\u062E", "\u0631\u0633\u0645 \u0627\u0644\u0645\u062E"],
  "electroencephalography": ["eeg", "\u0631\u0633\u0645 \u0645\u062E"],
  "\u0631\u0633\u0645 \u0645\u062E": ["eeg", "electroencephalography", "\u0631\u0633\u0645 \u0627\u0644\u0645\u062E"],
  "emg": ["electromyography", "\u0631\u0633\u0645 \u0639\u0636\u0644\u0627\u062A"],
  "\u0631\u0633\u0645 \u0639\u0636\u0644\u0627\u062A": ["emg", "electromyography"],
  "ncs": ["nerve conduction", "\u0633\u0631\u0639\u0629 \u062A\u0648\u0635\u064A\u0644 \u0627\u0644\u0623\u0639\u0635\u0627\u0628"],
  "\u0631\u0633\u0645 \u0627\u0639\u0635\u0627\u0628": ["ncs", "nerve conduction", "\u0633\u0631\u0639\u0629 \u062A\u0648\u0635\u064A\u0644 \u0627\u0644\u0623\u0639\u0635\u0627\u0628"],
  // Urology
  "cystoscopy": ["\u0645\u0646\u0638\u0627\u0631 \u0645\u062B\u0627\u0646\u0629"],
  "\u0645\u0646\u0638\u0627\u0631 \u0645\u062B\u0627\u0646\u0629": ["cystoscopy"],
  "turp": ["\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0628\u0631\u0648\u0633\u062A\u0627\u062A\u0627 \u0628\u0627\u0644\u0645\u0646\u0638\u0627\u0631", "\u0628\u0631\u0648\u0633\u062A\u0627\u062A\u0627"],
  "\u0628\u0631\u0648\u0633\u062A\u0627\u062A\u0627": ["turp", "prostatectomy", "\u0627\u0633\u062A\u0626\u0635\u0627\u0644 \u0628\u0631\u0648\u0633\u062A\u0627\u062A\u0627"],
  "ureteroscopy": ["\u0645\u0646\u0638\u0627\u0631 \u062D\u0627\u0644\u0628", "\u062A\u0641\u062A\u064A\u062A \u062D\u0635\u0648\u0629 \u0628\u0627\u0644\u0644\u064A\u0632\u0631"],
  "\u0645\u0646\u0638\u0627\u0631 \u062D\u0627\u0644\u0628": ["ureteroscopy"],
  "dj stent": ["\u062F\u0639\u0627\u0645\u0629 \u062D\u0627\u0644\u0628"],
  "\u062F\u0639\u0627\u0645\u0629 \u062D\u0627\u0644\u0628": ["dj stent"],
  // Radiology
  "ct": ["\u0627\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629", "\u0623\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629", "computed tomography"],
  "\u0645\u0642\u0637\u0639\u064A\u0629": ["ct", "computed tomography", "\u0623\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629"],
  "mri": ["\u0631\u0646\u064A\u0646 \u0645\u063A\u0646\u0627\u0637\u064A\u0633\u064A", "\u0623\u0634\u0639\u0629 \u0627\u0644\u0631\u0646\u064A\u0646 \u0627\u0644\u0645\u063A\u0646\u0627\u0637\u064A\u0633\u064A"],
  "\u0631\u0646\u064A\u0646": ["mri", "magnetic resonance imaging"],
  "doppler": ["\u062F\u0648\u0628\u0644\u0631", "\u062F\u0648\u0628\u0644\u0643\u0633 \u0645\u0644\u0648\u0646"],
  "\u062F\u0648\u0628\u0644\u0631": ["doppler", "duplex"],
  "sonar": ["\u0645\u0648\u062C\u0627\u062A \u0635\u0648\u062A\u064A\u0629", "\u0633\u0648\u0646\u0627\u0631"],
  "\u0633\u0648\u0646\u0627\u0631": ["ultrasound", "sonar", "\u0645\u0648\u062C\u0627\u062A \u0635\u0648\u062A\u064A\u0629"],
  "cxr": ["x - ray chest", "x-ray chest", "chest x-ray", "\u0623\u0634\u0639\u0629 \u0639\u0644\u064A \u0627\u0644\u0635\u062F\u0631"],
  "kub": ["x - ray abdomen", "urography", "\u0623\u0634\u0639\u0629 \u0639\u0644\u064A \u0627\u0644\u0628\u0637\u0646"],
  "ctpa": ["ct pulmonary angiography", "\u062A\u0635\u0648\u064A\u0631 \u0627\u0644\u0634\u0631\u064A\u0627\u0646 \u0627\u0644\u0631\u0626\u0648\u064A \u0628\u0627\u0644\u0623\u0634\u0639\u0629 \u0627\u0644\u0645\u0642\u0637\u0639\u064A\u0629"],
  "mrcp": ["magnetic resonance cholangiopancreatography", "\u0623\u0634\u0639\u0629 \u0631\u0646\u064A\u0646 \u0645\u063A\u0646\u0627\u0637\u064A\u0633\u064A \u0639\u0644\u064A \u0627\u0644\u0642\u0646\u0648\u0627\u062A \u0627\u0644\u0645\u0631\u0627\u0631\u064A\u0629"],
  "triphasic": ["triphasic ct", "ct liver triphasic", "\u0623\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629 \u062D\u0644\u0632\u0648\u0646\u064A\u0629 \u0639\u0644\u064A \u0634\u0631\u0627\u064A\u064A\u0646 \u0627\u0644\u0643\u0628\u062F", "\u062A\u0631\u0627\u064A\u0641\u0627\u0632\u064A\u0643"],
  "\u062A\u0631\u0627\u064A\u0641\u0627\u0632\u064A\u0643": ["triphasic ct", "ct liver triphasic", "\u0623\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629 \u062D\u0644\u0632\u0648\u0646\u064A\u0629 \u0639\u0644\u064A \u0634\u0631\u0627\u064A\u064A\u0646 \u0627\u0644\u0643\u0628\u062F"],
  "hsg": ["hysterosalpingography", "\u0627\u0634\u0639\u0629 \u0628\u0627\u0644\u0635\u0628\u063A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0631\u062D\u0645 \u0648\u0627\u0644\u0627\u0646\u0627\u0628\u064A\u0628"],
  "ivu": ["intravenous pyelogram", "\u0627\u0634\u0639\u0629 \u0628\u0627\u0644\u0635\u0628\u063A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0645\u0633\u0627\u0644\u0643 \u0627\u0644\u0628\u0648\u0644\u064A\u0629"],
  "ivp": ["intravenous pyelogram", "\u0627\u0634\u0639\u0629 \u0628\u0627\u0644\u0635\u0628\u063A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0645\u0633\u0627\u0644\u0643 \u0627\u0644\u0628\u0648\u0644\u064A\u0629"],
  "bmft": ["barium meal follow through", "\u0627\u0634\u0639\u0629 \u0628\u0627\u0631\u064A\u0648\u0645 \u0639\u0644\u0649 \u0627\u0644\u0627\u0645\u0639\u0627\u0621 \u0627\u0644\u062F\u0642\u064A\u0642\u0629"],
  "barium swallow": ["barium swallow", "\u0627\u0634\u0639\u0629 \u0628\u0627\u0644\u0628\u0627\u0631\u064A\u0648\u0645 \u0639\u0644\u0649 \u0627\u0644\u0645\u0631\u064A\u0621"],
  "barium enema": ["barium enema", "\u062D\u0642\u0646\u0629 \u0628\u0627\u0631\u064A\u0648\u0645 \u0634\u0631\u062C\u064A\u0629", "\u0627\u0634\u0639\u0629 \u0628\u0627\u0644\u0628\u0627\u0631\u064A\u0648\u0645 \u0639\u0644\u0649 \u0627\u0644\u0642\u0648\u0644\u0648\u0646"],
  "carotid doppler": ["doppler carotid", "\u062F\u0648\u0628\u0644\u0631 \u0639\u0644\u0649 \u0634\u0631\u0627\u064A\u064A\u0646 \u0627\u0644\u0631\u0642\u0628\u0629"],
  "dvt": ["venous doppler lower extremity", "\u062F\u0648\u0628\u0644\u0631 \u0627\u0648\u0631\u062F\u0629 \u0627\u0644\u0633\u0627\u0642\u064A\u0646"],
  "bone scan": ["bone scan", "\u0645\u0633\u062D \u0630\u0631\u064A \u0639\u0644\u0649 \u0627\u0644\u0639\u0638\u0627\u0645"],
  "\u0645\u0633\u062D \u0630\u0631\u064A": ["bone scan", "thyroid scan", "pet-ct"],
  // Ultrasound & Doppler colloquial Arabic queries
  "\u0633\u0648\u0646\u0627\u0631 \u0628\u0637\u0646 \u0648\u062D\u0648\u0636": ["us abdomen and pelvis", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u0628\u0637\u0646 \u0648\u0627\u0644\u062D\u0648\u0636", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0628\u0637\u0646 \u0648\u0627\u0644\u062D\u0648\u0636", "\u0633\u0648\u0646\u0627\u0631 \u0628\u0637\u0646 \u0648 \u062D\u0648\u0636"],
  "\u0633\u0648\u0646\u0627\u0631 \u0628\u0637\u0646": ["us abdomen", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u0628\u0637\u0646", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0628\u0637\u0646"],
  "\u0633\u0648\u0646\u0627\u0631 \u062D\u0648\u0636": ["us pelvis", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u064A \u0627\u0644\u062D\u0648\u0636", "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u0649 \u0627\u0644\u062D\u0648\u0636"],
  "\u062F\u0648\u0628\u0644\u0631 \u0627\u0648\u0631\u062F\u0629 \u0627\u0644\u0633\u0627\u0642\u064A\u0646": ["doppler venous system both lower limbs", "\u062F\u0648\u0628\u0644\u0631 \u0639\u0644\u064A \u0623\u0648\u0631\u062F\u0629 \u0627\u0644\u0623\u0637\u0631\u0627\u0641 \u0627\u0644\u0633\u0641\u0644\u064A", "\u062F\u0648\u0628\u0644\u0631 \u0627\u0648\u0631\u062F\u0629 \u0627\u0644\u0637\u0631\u0641\u064A\u0646 \u0627\u0644\u0633\u0641\u0644\u064A\u064A\u0646"],
  "\u062F\u0648\u0628\u0644\u0631 \u0634\u0631\u0627\u064A\u064A\u0646 \u0627\u0644\u0633\u0627\u0642\u064A\u0646": ["doppler arterial system both lower limbs", "\u062F\u0648\u0628\u0644\u0631 \u0639\u0644\u064A \u0634\u0631\u0627\u064A\u064A\u0646 \u0627\u0644\u0623\u0637\u0631\u0627\u0641 \u0627\u0644\u0633\u0641\u0644\u064A", "\u062F\u0648\u0628\u0644\u0631 \u0634\u0631\u0627\u064A\u064A\u0646 \u0627\u0644\u0637\u0631\u0641\u064A\u0646 \u0627\u0644\u0633\u0641\u0644\u064A\u064A\u0646"],
  "\u062A\u0631\u0643\u064A\u0628 \u0628\u0648\u0631\u062A \u0643\u0627\u062B": ["porta cath insertion", "\u062A\u0631\u0643\u064A\u0628 \u062C\u0647\u0627\u0632 \u0628\u0648\u0631\u062A \u0643\u0627\u062B"],
  "\u0631\u0641\u0639 \u0628\u0648\u0631\u062A \u0643\u0627\u062B": ["porta cath removal", "\u0631\u0641\u0639 \u0628\u0648\u0631\u062A \u0643\u0627\u062B"],
  // Dialysis / ICU / Interventions / Acute (Batch 1)
  "hd session": ["\u063A\u0633\u064A\u0644 \u0643\u0644\u0648\u064A", "\u062C\u0644\u0633\u0629 \u063A\u0633\u064A\u0644 \u0643\u0644\u0648\u064A", "dialysis"],
  "hemodialysis": ["\u063A\u0633\u064A\u0644 \u0643\u0644\u0648\u064A", "\u062C\u0644\u0633\u0629 \u063A\u0633\u064A\u0644 \u0643\u0644\u0648\u064A", "dialysis"],
  "\u063A\u0633\u064A\u0644 \u0643\u0644\u0648\u064A": ["hemodialysis", "hd session", "dialysis"],
  "pig tail": ["\u062A\u0631\u0643\u064A\u0628 \u0628\u064A\u062C \u062A\u064A\u0644", "pig tail catheter", "pig tail insertion"],
  "\u0628\u064A\u062C \u062A\u064A\u0644": ["pig tail insertion", "pig tail catheter", "\u062A\u0631\u0643\u064A\u0628 \u0628\u064A\u062C \u062A\u064A\u0644"],
  "port-a-cath": ["port-a-cath", "porta cath", "porta cath insertion", "chemoport", "tivad", "\u062C\u0647\u0627\u0632 \u0639\u0644\u0627\u062C \u0643\u064A\u0645\u0627\u0648\u064A", "\u0628\u0648\u0631\u062A \u0643\u0627\u062B"],
  "portacath": ["port-a-cath", "porta cath", "porta cath insertion", "chemoport", "tivad", "\u062C\u0647\u0627\u0632 \u0639\u0644\u0627\u062C \u0643\u064A\u0645\u0627\u0648\u064A", "\u0628\u0648\u0631\u062A \u0643\u0627\u062B"],
  "\u0628\u0648\u0631\u062A \u0643\u0627\u062B": ["port-a-cath", "porta cath", "porta cath insertion", "chemoport", "\u062C\u0647\u0627\u0632 \u0639\u0644\u0627\u062C \u0643\u064A\u0645\u0627\u0648\u064A"],
  "\u0628\u0648\u0631\u062A\u0627\u0643\u0627\u062A": ["port-a-cath", "porta cath", "porta cath insertion", "chemoport"],
  "evbl": ["esophageal varices band ligation", "\u0631\u0628\u0637 \u062F\u0648\u0627\u0644\u064A \u0627\u0644\u0645\u0631\u064A\u0621", "\u0631\u0628\u0637 \u062F\u0648\u0627\u0644\u064A \u0628\u0627\u0644\u0645\u0646\u0638\u0627\u0631"],
  "\u0631\u0628\u0637 \u062F\u0648\u0627\u0644\u064A": ["esophageal varices band ligation", "evbl", "\u0631\u0628\u0637 \u062F\u0648\u0627\u0644\u064A \u0627\u0644\u0645\u0631\u064A\u0621"],
  "pcn": ["percutaneous nephrostomy", "\u0628\u0630\u0644 \u0643\u0644\u0648\u064A \u0628\u0627\u0644\u0627\u0634\u0639\u0629 \u0627\u0644\u062A\u062F\u0627\u062E\u0644\u064A\u0629"],
  "tru-cut": ["true cut biopsy", "u/s guided true cut biopsy", "\u0639\u064A\u0646\u0629 \u062A\u0631\u0648\u0643\u062A"],
  "\u062A\u0631\u0648\u0643\u062A": ["true cut biopsy", "u/s guided true cut biopsy"],
  "tracheostomy": ["\u0634\u0642 \u062D\u0646\u062C\u0631\u064A", "\u062A\u0631\u0643\u064A\u0628 \u0623\u0646\u0628\u0648\u0628 \u062D\u0646\u062C\u0631\u064A"],
  "audiogram": ["computerized audiogram", "\u0631\u0633\u0645 \u0633\u0645\u0639 \u0628\u0627\u0644\u0643\u0645\u0628\u064A\u0648\u062A\u0631"],
  "audiometry": ["computerized audiogram", "\u0631\u0633\u0645 \u0633\u0645\u0639"],
  "\u0631\u0633\u0645 \u0633\u0645\u0639": ["computerized audiogram", "audiogram"],
  "tapping": ["\u0628\u0632\u0644", "paracentesis"],
  "\u0628\u0632\u0644": ["tapping", "paracentesis"],
  // Surgical Procedures & Bedside Care (Batch 3)
  "lac": ["above elbow cast", "\u062C\u0628\u0633 \u0641\u0648\u0642 \u0627\u0644\u0643\u0648\u0639"],
  "sac": ["below elbow cast", "\u062C\u0628\u0633 \u062A\u062D\u062A \u0627\u0644\u0643\u0648\u0639"],
  "llc": ["above knee cast", "\u062C\u0628\u0633 \u0641\u0648\u0642 \u0627\u0644\u0631\u0643\u0628\u0629"],
  "slc": ["below knee cast", "\u062C\u0628\u0633 \u062A\u062D\u062A \u0627\u0644\u0631\u0643\u0628\u0629"],
  "\u062C\u0628\u0633": ["cast", "above elbow cast", "below elbow cast", "above knee cast", "below knee cast"],
  "\u062C\u0628\u064A\u0631\u0629": ["slab", "posterior slab", "\u062C\u0628\u064A\u0631\u0629 \u062E\u0644\u0641\u064A\u0629"],
  "\u0631\u062F \u0643\u0633\u0631": ["fracture reduction", "\u0631\u062F \u0643\u0633\u0631 \u0628\u0633\u064A\u0637"],
  "\u0631\u062F \u062E\u0644\u0639": ["dislocation reduction", "\u0631\u062F \u062E\u0644\u0639 \u0645\u0641\u0635\u0644"],
  "\u062D\u0642\u0646 \u0645\u0641\u0627\u0635\u0644": ["intra-articular injection", "\u062D\u0642\u0646 \u0645\u0648\u0636\u0639\u064A \u0639\u0638\u0627\u0645 \u0645\u0641\u0627\u0635\u0644"],
  "ett": ["endo tracheal intubation", "endotracheal intubation", "\u0623\u0646\u0628\u0648\u0628\u0629 \u062D\u0646\u062C\u0631\u064A\u0629"],
  "intubation": ["endo tracheal intubation", "\u062A\u0631\u0643\u064A\u0628 \u0627\u0646\u0628\u0648\u0628\u0629 \u062D\u0646\u062C\u0631\u064A\u0629"],
  "\u0627\u0646\u0628\u0648\u0628\u0629 \u062D\u0646\u062C\u0631\u064A\u0629": ["endo tracheal intubation", "\u062A\u0631\u0643\u064A\u0628 \u0627\u0646\u0628\u0648\u0628\u0629 \u0628\u0627\u0644\u0642\u0635\u0628\u0629 \u0627\u0644\u0647\u0648\u0627\u0626\u064A\u0629"],
  "cvp": ["cvp catheter insertion", "\u062A\u0631\u0643\u064A\u0628 \u0642\u0633\u0637\u0631\u0629 \u0648\u0631\u064A\u062F \u0645\u0631\u0643\u0632\u064A"],
  "\u0642\u0633\u0637\u0631\u0629 \u0648\u0631\u064A\u062F\u064A\u0629 \u0645\u0631\u0643\u0632\u064A\u0629": ["cvp catheter insertion", "\u062A\u0631\u0643\u064A\u0628 \u0642\u0633\u0637\u0631\u0629 \u0648\u0631\u064A\u062F \u0645\u0631\u0643\u0632\u064A"],
  "arterial line": ["arterial line insertion", "\u062A\u0631\u0643\u064A\u0628 \u0642\u0633\u0637\u0631\u0629 \u0634\u0631\u064A\u0627\u0646\u064A\u0629"],
  "\u0642\u0633\u0637\u0631\u0629 \u0634\u0631\u064A\u0627\u0646\u064A\u0629": ["arterial line insertion", "\u062A\u0631\u0643\u064A\u0628 \u0642\u0633\u0637\u0631\u0629 \u0634\u0631\u064A\u0627\u0646\u064A\u0629"],
  "chest tube": ["insertion of intercostal tube", "\u062A\u0631\u0643\u064A\u0628 \u0623\u0646\u0628\u0648\u0628\u0629 \u0635\u062F\u0631\u064A\u0629"],
  "\u0623\u0646\u0628\u0648\u0628\u0629 \u0635\u062F\u0631\u064A\u0629": ["insertion of intercostal tube", "\u062A\u0631\u0643\u064A\u0628 \u0623\u0646\u0628\u0648\u0628\u0629 \u0635\u062F\u0631\u064A\u0629"],
  "lumbar puncture": ["c.s.f tapping", "\u0628\u0630\u0644 \u0646\u062E\u0627\u0639\u064A", "\u0628\u0630\u0644 \u0627\u0644\u0633\u0627\u0626\u0644 \u0627\u0644\u0633\u062D\u0627\u0626\u064A"],
  "\u0628\u0630\u0644 \u0646\u062E\u0627\u0639\u064A": ["c.s.f tapping", "lumbar puncture", "\u0628\u0630\u0644 \u0627\u0644\u0633\u0627\u0626\u0644 \u0627\u0644\u0633\u062D\u0627\u0626\u064A"],
  "paracentesis": ["\u0628\u0630\u0644 \u0628\u0637\u0646", "\u0628\u0630\u0644 \u062A\u062C\u0645\u0639 \u0633\u0627\u0626\u0644 \u0641\u064A \u0627\u0644\u0628\u0637\u0646", "paracentesis"],
  "\u0628\u0630\u0644 \u0628\u0637\u0646": ["paracentesis", "\u0628\u0630\u0644 \u062A\u062C\u0645\u0639 \u0633\u0627\u0626\u0644 \u0641\u064A \u0627\u0644\u0628\u0637\u0646"],
  "pericardiocentesis": ["\u0628\u0630\u0644 \u062A\u0627\u0645\u0648\u0631", "\u0628\u0630\u0644 \u0645\u0646 \u062A\u0627\u0645\u0648\u0631 \u0627\u0644\u0642\u0644\u0628"],
  "\u063A\u064A\u0627\u0631 \u062C\u0631\u0648\u062D": ["wound dressing", "\u063A\u064A\u0627\u0631 \u0639\u0644\u064A \u062C\u0631\u062D", "wound cleaning"],
  "\u0641\u0643 \u063A\u0631\u0632": ["stitch removal", "removal of surgical stitches", "\u0641\u0643 \u063A\u0631\u0632 \u062C\u0631\u0627\u062D\u064A\u0629"],
  "\u063A\u0631\u0632 \u062C\u0631\u0627\u062D\u064A\u0629": ["surgical stitches", "suturing", "\u062E\u064A\u0627\u0637\u0629 \u062C\u0631\u0648\u062D"],
  "\u062E\u064A\u0627\u0637\u0629 \u062C\u0631\u0648\u062D": ["surgical stitches", "suturing", "\u062E\u064A\u0627\u0637\u0629 \u062C\u0631\u0648\u062D"],
  "\u0642\u0633\u0637\u0631\u0629 \u0628\u0648\u0644\u064A\u0629": ["insertion of urinary catheter", "\u062A\u0631\u0643\u064A\u0628 \u0642\u0633\u0637\u0631\u0629 \u0628\u0648\u0644\u064A\u0629"],
  "foley": ["insertion of urinary catheter", "\u0642\u0633\u0637\u0631\u0629 \u0628\u0648\u0644\u064A\u0629"],
  "ctg": ["fetal monitoring by cardiotocography", "\u0645\u0631\u0627\u0642\u0628\u0629 \u0645\u0639\u062F\u0644 \u0646\u0628\u0636 \u0627\u0644\u062C\u0646\u064A\u0646"],
  "holter": ["holter monitor", "\u062C\u0647\u0627\u0632 \u0647\u0648\u0644\u062A\u0631", "\u062A\u0631\u0643\u064A\u0628 \u062C\u0647\u0627\u0632 \u0647\u0648\u0644\u062A\u0631"],
  "\u0647\u0648\u0644\u062A\u0631": ["holter monitor", "\u062C\u0647\u0627\u0632 \u0647\u0648\u0644\u062A\u0631"],
  "spirometry": ["pulmonary function test", "\u0642\u064A\u0627\u0633 \u0643\u0641\u0627\u0621\u0629 \u0627\u0644\u0631\u0626\u062A\u064A\u0646"],
  "\u0648\u0638\u0627\u0626\u0641 \u062A\u0646\u0641\u0633": ["pulmonary function test", "spirometry"],
  "fees": ["flexible endoscopic evaluation of swallowing", "\u062A\u0642\u064A\u064A\u0645 \u0627\u0644\u0628\u0644\u0639 \u0628\u0627\u0644\u0645\u0646\u0638\u0627\u0631"],
  "\u062A\u0642\u064A\u064A\u0645 \u0628\u0644\u0639": ["flexible endoscopic evaluation of swallowing", "fees"],
  "\u0639\u0644\u0627\u062C \u0636\u0648\u0626\u064A": ["phototherapy", "\u0639\u0644\u0627\u062C \u0636\u0648\u0626\u064A \u0644\u062D\u062F\u064A\u062B\u064A \u0627\u0644\u0648\u0644\u0627\u062F\u0629"],
  "\u0641\u0635\u0644 \u0628\u0644\u0627\u0632\u0645\u0627": ["plasma pharesis", "plasmapheresis", "\u0627\u062C\u0631\u0627\u0621 \u0641\u0635\u0644 \u0628\u0644\u0627\u0632\u0645\u0627"],
  "plasmapheresis": ["plasma pharesis", "\u0627\u062C\u0631\u0627\u0621 \u0641\u0635\u0644 \u0628\u0644\u0627\u0632\u0645\u0627"],
  // Routine Clinical Laboratory & Endocrine (Batch 4)
  "cbc": ["complete blood count", "\u0635\u0648\u0631\u0629 \u062F\u0645 \u0643\u0627\u0645\u0644\u0629", "\u0635\u0648\u0631\u0629 \u062F\u0645", "blood picture"],
  "\u0635\u0648\u0631\u0629 \u062F\u0645": ["complete blood count", "cbc", "\u0635\u0648\u0631\u0629 \u062F\u0645 \u0643\u0627\u0645\u0644\u0629"],
  "esr": ["erythrocyte sedimentation rate", "\u0633\u0631\u0639\u0629 \u062A\u0631\u0633\u064A\u0628", "\u0633\u0631\u0639\u0629 \u0627\u0644\u062A\u0631\u0633\u064A\u0628"],
  "\u0633\u0631\u0639\u0629 \u062A\u0631\u0633\u064A\u0628": ["esr", "erythrocyte sedimentation rate"],
  "pt": ["prothrombin time and inr", "prothrombin time", "\u062A\u062D\u0644\u064A\u0644 \u0633\u064A\u0648\u0644\u0629", "\u0633\u064A\u0648\u0644\u0629 \u0627\u0644\u062F\u0645"],
  "inr": ["prothrombin time and inr", "international normalized ratio", "\u062A\u062D\u0644\u064A\u0644 \u0633\u064A\u0648\u0644\u0629"],
  "\u0633\u064A\u0648\u0644\u0629": ["prothrombin time and inr", "pt inr", "\u0633\u064A\u0648\u0644\u0629 \u0627\u0644\u062F\u0645"],
  "ptt": ["partial thromboplastin time", "aptt", "\u0632\u0645\u0646 \u0627\u0644\u062A\u062C\u0644\u0637 \u0627\u0644\u062C\u0632\u0626\u064A"],
  "d-dimer": ["d-dimer quantitative", "d dimer", "\u062F\u064A \u062F\u0627\u064A\u0645\u0631"],
  "\u062F\u064A \u062F\u0627\u064A\u0645\u0631": ["d-dimer quantitative", "d-dimer"],
  "creatinine": ["serum creatinine", "\u0648\u0638\u0627\u0626\u0641 \u0643\u0644\u0649", "\u0643\u0631\u064A\u0627\u062A\u064A\u0646\u064A\u0646"],
  "\u0648\u0638\u0627\u0626\u0641 \u0643\u0644\u0649": ["serum creatinine", "blood urea", "\u0643\u0631\u064A\u0627\u062A\u064A\u0646\u064A\u0646", "\u064A\u0648\u0631\u064A\u0627"],
  "\u0643\u0631\u064A\u0627\u062A\u064A\u0646\u064A\u0646": ["serum creatinine", "creatinine"],
  "\u064A\u0648\u0631\u064A\u0627": ["blood urea", "urea", "\u0628\u0648\u0644\u064A\u0646\u0627"],
  "\u062D\u0645\u0636 \u0627\u0644\u0628\u0648\u0644\u064A\u0643": ["serum uric acid", "uric acid", "\u0646\u0642\u0631\u0633"],
  "\u0632\u0644\u0627\u0644 \u0628\u0627\u0644\u0628\u0648\u0644": ["microalbuminuria", "albumin creatinine ratio", "protein in urine"],
  "\u062A\u062D\u0644\u064A\u0644 \u0628\u0648\u0644": ["complete urine analysis", "urine analysis", "\u0641\u062D\u0635 \u0628\u0648\u0644 \u0631\u0648\u062A\u064A\u0646\u064A"],
  "\u062A\u062D\u0644\u064A\u0644 \u0628\u0631\u0627\u0632": ["complete stool analysis", "stool analysis", "\u0641\u062D\u0635 \u0628\u0631\u0627\u0632 \u0631\u0648\u062A\u064A\u0646\u064A"],
  "\u062F\u0645 \u062E\u0641\u064A": ["fecal occult blood test", "occult blood in stool", "fobt"],
  "\u0643\u0627\u0644\u0628\u0631\u0648\u062A\u0643\u062A\u064A\u0646": ["fecal calprotectin", "calprotectin"],
  "alt": ["sgpt", "alanin aminotransferase", "\u0627\u0646\u0632\u064A\u0645\u0627\u062A \u0643\u0628\u062F"],
  "sgpt": ["alt", "alanin aminotransferase", "\u0627\u0646\u0632\u064A\u0645\u0627\u062A \u0643\u0628\u062F"],
  "ast": ["sgot", "aspartate aminotransferase", "\u0627\u0646\u0632\u064A\u0645\u0627\u062A \u0643\u0628\u062F"],
  "sgot": ["ast", "aspartate aminotransferase", "\u0627\u0646\u0632\u064A\u0645\u0627\u062A \u0643\u0628\u062F"],
  "\u0627\u0646\u0632\u064A\u0645\u0627\u062A \u0643\u0628\u062F": ["alt", "ast", "sgpt", "sgot"],
  "\u0648\u0638\u0627\u0626\u0641 \u0643\u0628\u062F": ["alt", "ast", "bilirubin", "albumin"],
  "\u0627\u0644\u0635\u0641\u0631\u0627\u0621": ["total and direct bilirubin", "bilirubin total and direct"],
  "\u0627\u0644\u0628\u064A\u0648\u0645\u064A\u0646": ["serum albumin", "albumin"],
  "\u0641\u0648\u0633\u0641\u0627\u062A\u064A\u0632 \u0642\u0644\u0648\u064A": ["alkaline phosphatase", "alp"],
  "\u0635\u0648\u062F\u064A\u0648\u0645": ["serum sodium", "sodium"],
  "\u0628\u0648\u062A\u0627\u0633\u064A\u0648\u0645": ["serum potassium", "potassium"],
  "\u0643\u0627\u0644\u0633\u064A\u0648\u0645": ["serum calcium", "calcium total"],
  "\u0641\u064A\u0631\u064A\u062A\u064A\u0646": ["serum ferritin", "\u0645\u062E\u0632\u0648\u0646 \u0627\u0644\u062D\u062F\u064A\u062F"],
  "\u0645\u062E\u0632\u0648\u0646 \u0627\u0644\u062D\u062F\u064A\u062F": ["serum ferritin", "ferritin"],
  "fbs": ["fasting blood sugar", "fasting blood glucose", "\u0633\u0643\u0631 \u0635\u0627\u0626\u0645"],
  "\u0633\u0643\u0631 \u0635\u0627\u0626\u0645": ["fasting blood sugar", "fbs"],
  "2hpp": ["2 hours post prandial blood sugar", "\u0633\u0643\u0631 \u0641\u0627\u0637\u0631"],
  "\u0633\u0643\u0631 \u0641\u0627\u0637\u0631": ["2 hours post prandial blood sugar", "2hpp"],
  "rbs": ["random blood sugar", "\u0633\u0643\u0631 \u0639\u0634\u0648\u0627\u0626\u064A"],
  "\u0633\u0643\u0631 \u0639\u0634\u0648\u0627\u0626\u064A": ["random blood sugar", "rbs"],
  "hba1c": ["glycated hemoglobin", "\u0627\u0644\u0633\u0643\u0631 \u0627\u0644\u062A\u0631\u0627\u0643\u0645\u064A", "\u0633\u0643\u0631 \u062A\u0631\u0627\u0643\u0645\u064A"],
  "\u0633\u0643\u0631 \u062A\u0631\u0627\u0643\u0645\u064A": ["glycated hemoglobin", "hba1c", "\u0627\u0644\u0633\u0643\u0631 \u0627\u0644\u062A\u0631\u0627\u0643\u0645\u064A"],
  "\u0643\u0648\u0644\u064A\u0633\u062A\u0631\u0648\u0644": ["serum total cholesterol", "cholesterol"],
  "\u062F\u0647\u0648\u0646 \u062B\u0644\u0627\u062B\u064A\u0629": ["serum triglycerides", "triglycerides"],
  "\u062F\u0647\u0648\u0646 \u0643\u0627\u0645\u0644\u0629": ["full lipid profile", "lipid profile"],
  "troponin": ["troponin i quantitative", "troponin t", "\u062A\u0631\u0648\u0628\u0648\u0646\u064A\u0646"],
  "\u062A\u0631\u0648\u0628\u0648\u0646\u064A\u0646": ["troponin i quantitative", "troponin", "hs-ctni"],
  "abg": ["arterial blood gas", "\u063A\u0627\u0632\u0627\u062A \u062F\u0645 \u0634\u0631\u064A\u0627\u0646\u064A"],
  "\u063A\u0627\u0632\u0627\u062A \u062F\u0645": ["arterial blood gas", "abg"],
  "tsh": ["thyroid stimulating hormone", "\u0647\u0631\u0645\u0648\u0646 \u0627\u0644\u063A\u062F\u0629 \u0627\u0644\u062F\u0631\u0642\u064A\u0629", "\u062A\u062D\u0644\u064A\u0644 \u062A\u064A \u0627\u0633 \u0627\u062A\u0634"],
  "\u0627\u0644\u063A\u062F\u0629 \u0627\u0644\u062F\u0631\u0642\u064A\u0629": ["tsh", "free t3", "free t4"],
  "pth": ["intact pth pth 1-84", "parathyroid hormone", "\u0628\u0627\u0631\u0627\u062B\u0648\u0631\u0645\u0648\u0646", "\u0647\u0631\u0645\u0648\u0646 \u0627\u0644\u063A\u062F\u0629 \u0627\u0644\u062C\u0627\u0631 \u062F\u0631\u0642\u064A\u0629"],
  "\u0628\u0627\u0631\u0627\u062B\u0648\u0631\u0645\u0648\u0646": ["intact pth pth 1-84", "pth", "parathormone"],
  "\u0641\u064A\u062A\u0627\u0645\u064A\u0646 \u062F": ["25-oh vitamin d total", "vitamin d3", "vitamin d"],
  "\u062A\u062D\u0644\u064A\u0644 \u062D\u0645\u0644": ["beta hcg quantitative", "pregnancy test in blood"],
  "\u0628\u0631\u0648\u0644\u0627\u0643\u062A\u064A\u0646": ["serum prolactin", "\u0647\u0631\u0645\u0648\u0646 \u0627\u0644\u0644\u0628\u0646"],
  "\u0645\u062E\u0632\u0648\u0646 \u0627\u0644\u0645\u0628\u064A\u0636": ["anti mullerian hormone", "amh"],
  "psa": ["total psa prostate specific antigen", "prostate specific antigen", "\u062F\u0644\u0627\u0644\u0627\u062A \u0627\u0648\u0631\u0627\u0645 \u0627\u0644\u0628\u0631\u0648\u0633\u062A\u0627\u062A\u0627"]
};
function expandMedicalSynonyms(input) {
  if (!input) return [];
  const cleanQ = cleanHisProcedureQuery(input);
  const norm = normalizeText(cleanQ);
  const normAr = normalizeArabic(cleanQ);
  const results = /* @__PURE__ */ new Set([cleanQ, norm, normAr]);
  for (const [key, syns] of Object.entries(MEDICAL_SYNONYMS)) {
    const isEnglishKey = /^[a-z0-9\s-]+$/i.test(key);
    const normKey = normalizeText(key);
    let matched = false;
    if (isEnglishKey && key.length <= 4) {
      matched = new RegExp(`\\b${key}\\b`, "i").test(cleanQ);
    } else {
      matched = normKey && norm.includes(normKey) || norm.includes(key) || normAr.includes(key);
    }
    if (matched) {
      syns.forEach((s) => results.add(s));
    }
  }
  return Array.from(results).filter(Boolean);
}
function hasAntibodyConflict(query2, candidate) {
  if (!query2 || !candidate) return false;
  const isotypes = ["iga", "igg", "igm", "ige"];
  const qLower = query2.toLowerCase();
  const cLower = candidate.toLowerCase();
  const qIso = isotypes.filter((iso) => new RegExp(`\\b${iso}\\b`, "i").test(qLower));
  const cIso = isotypes.filter((iso) => new RegExp(`\\b${iso}\\b`, "i").test(cLower));
  if (qIso.length > 0 && cIso.length > 0) {
    return !qIso.some((iso) => cIso.includes(iso));
  }
  return false;
}
function hasLabInvestigationConflict(query2, candidate) {
  if (!query2 || !candidate) return false;
  const q = query2.toLowerCase();
  const c = candidate.toLowerCase();
  const isQCulture = /\bculture\b|مزرع[ةه]/i.test(q);
  const isCCulture = /\bculture\b|مزرع[ةه]/i.test(c);
  if (isQCulture !== isCCulture) {
    if (isQCulture && /\banalysis\b|chemistry|cell count|تحليل كيمياء/i.test(c)) return true;
    if (isCCulture && /\banalysis\b|chemistry|cell count|تحليل كيمياء/i.test(q)) return true;
  }
  const isQStain = /\bstain\b|صبغ[ةه]/i.test(q);
  const isCStain = /\bstain\b|صبغ[ةه]/i.test(c);
  if (isQStain !== isCStain) {
    if (isQStain && /\banalysis\b|chemistry|cell count|culture/i.test(c)) return true;
    if (isCStain && /\banalysis\b|chemistry|cell count|culture/i.test(q)) return true;
  }
  const isQCytology = /\bcytology\b|سيتولوج/i.test(q);
  const isCCytology = /\bcytology\b|سيتولوج/i.test(c);
  if (isQCytology !== isCCytology) {
    if (isQCytology && /\banalysis\b|chemistry|cell count|culture|stain/i.test(c)) return true;
    if (isCCytology && /\banalysis\b|chemistry|cell count|culture|stain/i.test(q)) return true;
  }
  const isQPCR = /\bpcr\b|filmarray|biofire|molecular/i.test(q);
  const isCPCR = /\bpcr\b|filmarray|biofire|molecular/i.test(c);
  if (isQPCR !== isCPCR) {
    if (isQPCR && /\banalysis\b|chemistry|cell count|culture|stain|cytology/i.test(c)) return true;
    if (isCPCR && /\banalysis\b|chemistry|cell count|culture|stain|cytology/i.test(q)) return true;
  }
  const isQLactate = /\blactate\b|لاكتات/i.test(q);
  const isCLactate = /\blactate\b|لاكتات/i.test(c);
  if (isQLactate !== isCLactate) {
    if (isQLactate && /chemistry & cell count|cell count/i.test(c)) return true;
    if (isCLactate && /chemistry & cell count|cell count/i.test(q)) return true;
  }
  const oneSiteRe = /(?:one|two|three|\d+)\s*sites?|مكان\s*واحد|مكانين|ثلاث[ةه]?\s*اماكن|مغناطيس|magnetic|ليزر|laser/i;
  const physioQueryRe = /physio|physical therapy|علاج\s*طبيع|عنايه\s*صدر|عناية\s*صدر|اطراف|أطراف|limbs/i;
  if (oneSiteRe.test(c) && !oneSiteRe.test(q) && physioQueryRe.test(q) && !/ليزر|laser|مغناطيس|magnetic/i.test(q)) return true;
  const isQLaser = /\blaser\b|ليزر/i.test(q);
  const isCLaser = /\blaser\b|ليزر/i.test(c);
  if (isQLaser !== isCLaser) {
    const physioRe = /physio|physical therapy|علاج\s*طبيع|عنايه\s*صدر|عناية\s*صدر|chest\s*\+|اطراف|أطراف|limbs?/i;
    if (isCLaser && physioRe.test(q)) return true;
    if (isQLaser && physioRe.test(c)) return true;
  }
  return false;
}
function isAccommodationOrGenericFee(name) {
  if (!name) return false;
  const n = normalizeText(name);
  const a = normalizeArabic(name);
  return /\b(bed|room|accommodation|stay|icu day|ccu day|nursing|care unit)\b/i.test(n) || /إقامة|اقامة|سرير|عناية مركزة|رعاية مركزة|رسم دخول|رسوم فتح ملف|كشف طوارئ|استشارة|مرور طبيب/i.test(a);
}
function extractRefusalReason(snippet) {
  if (!snippet || !snippet.trim()) return "";
  const norm = snippet.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
  if (norm.includes("\u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A") || norm.includes("\u0637\u0631\u0641 \u0627\u0644\u062A\u0639\u0627\u0642\u062F \u0648\u0627\u0644\u0645\u0631\u064A\u0636 \u0641\u064A \u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A")) {
    return "\u062A\u0646\u0633\u064A\u0642 \u0627\u0644\u062A\u062D\u0644\u064A\u0644 \u0628\u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A";
  }
  if (norm.includes("\u0644\u0639\u062F\u0645 \u0645\u062F \u0627\u0644\u0627\u0642\u0627\u0645\u0647") || norm.includes("\u0631\u0641\u0639 \u0627\u0644\u062D\u062F \u0627\u0644\u0627\u0642\u0635\u064A")) {
    return "\u0644\u0639\u062F\u0645 \u0645\u062F \u0627\u0644\u0625\u0642\u0627\u0645\u0629 \u0648\u0631\u0641\u0639 \u0627\u0644\u062D\u062F \u0627\u0644\u0623\u0642\u0635\u0649";
  }
  if (norm.includes("\u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u064A") || norm.includes("\u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u0649")) {
    return "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0623\u0647\u0644 \u0644\u0642\u0633\u0645 \u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u0649";
  }
  if (norm.includes("\u0627\u0631\u0633\u0627\u0644 \u0627\u0644\u0627\u0647\u0644") || norm.includes("\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0647\u0644") || norm.includes("\u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u0644\u0644\u062A\u063A\u0637\u064A\u0647") || norm.includes("\u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u0644\u0644\u062A\u063A\u0637\u064A\u0629")) {
    return "\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u0644\u0644\u062A\u063A\u0637\u064A\u0629";
  }
  if (norm.includes("\u0631\u0633\u064A\u0628\u0634\u0646") || norm.includes("\u0631\u064A\u0633\u0628\u0634\u0646")) {
    return "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u0631\u064A\u0633\u0628\u0634\u0646 \u0644\u0644\u062A\u063A\u0637\u064A\u0629";
  }
  if (norm.includes("\u0643\u0627\u0634 \u0637\u0631\u0641 \u0627\u0644\u0627\u0647\u0644") || norm.includes("\u0643\u0627\u0634 \u0637\u0631\u0641 \u0627\u0644\u0623\u0647\u0644") || norm.includes("\u0643\u0627\u0634")) {
    return "\u0643\u0627\u0634 \u0637\u0631\u0641 \u0627\u0644\u0623\u0647\u0644";
  }
  if (norm.includes("\u062A\u0627\u0645\u064A\u0646\u064A\u0627") || norm.includes("\u062A\u0627\u0645\u0646\u064A\u0627")) {
    return "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649 \u062A\u0623\u0645\u064A\u0646\u064A\u0627\u064B";
  }
  if (norm.includes("\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0647") || norm.includes("\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0629")) {
    return "\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0629";
  }
  return "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649";
}

// src/services/aiMatchService.ts
import { GoogleGenAI, Type } from "@google/genai";

// src/lib/whatsapp-generator.ts
function extractCleanProcedurePhrase(rawText) {
  if (!rawText) return "";
  const rawLines = rawText.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  for (const line of rawLines) {
    const stripped = stripSentFromSignatures(line).trim();
    const engLetters = (stripped.match(/[a-zA-Z]/g) || []).length;
    const araLetters = (stripped.match(/[\u0600-\u06FF]/g) || []).length;
    if (engLetters >= 4 && engLetters > araLetters) {
      const cleanLine = stripped.replace(/^[-*•\d.)\s]+/, "").trim();
      const lower = cleanLine.toLowerCase();
      if (!lower.startsWith("get outlook") && !lower.startsWith("sent from") && !lower.startsWith("inpatient") && !lower.startsWith("mrn") && !lower.startsWith("bed")) {
        return cleanLine;
      }
    }
  }
  let text = stripSentFromSignatures(rawText).trim();
  if (!text) return "";
  const engMatches = text.match(/\b([A-Za-z][A-Za-z0-9\s()/-]{3,}[A-Za-z0-9)])\b/g);
  if (engMatches) {
    for (const match of engMatches) {
      const m = match.trim();
      const lower = m.toLowerCase();
      if (m.length >= 4 && !lower.includes("inpatient") && !lower.includes("approval") && !lower.includes("patient") && !lower.includes("physician") && !lower.includes("contractor") && !lower.includes("admission") && !lower.includes("diagnosis") && !lower.includes("request details") && !lower.includes("selected services") && !lower.includes("sent from") && !lower.includes("get outlook") && !lower.startsWith("mrn") && !lower.startsWith("bed") && !lower.startsWith("zone") && !lower.startsWith("icu")) {
        return m;
      }
    }
  }
  const clinicalMatch = text.match(
    /(?:واوصي بعمل|واوصى بعمل|أوصى بعمل|اوصي بعمل|اوصى بعمل|ويحتاج الى عمل|ويحتاج الي عمل|ويحتاج لعمل|يحتاج الى عمل|يحتاج الي عمل|يحتاج لعمل|بحاجة لاجراء|بحاجة لإجراء|بحاجة الى|بحاجة الي|وتم طلب عمل|وتم طلب|تم طلب عمل|تم طلب|(?:برجاء|نرجو|يرجى)\s+(?:من\s+سيادتكم\s+)?(?:الموافقة|الموافقه|موافقة|موافقه)\s+(?:علي\s+عمل|على\s+عمل|علي|على)?|برجاء عمل|المطلوب عمل|المطلوب موافقة على|المطلوب موافقة علي|المطلوب موافقة|المطلوب موافقه|المطلوب|يحتاج الى|يحتاج الي|اوصى ب|اوصي ب|(?:وتحتاج|تحتاج|ويحتاج|يحتاج)\s+(?:الحاله|الحالة|المريض|المريضة)\s+(?:لـ?|إلى|الى|إلي|الي))\s*(.+)/is
  );
  if (clinicalMatch && clinicalMatch[1]) {
    text = clinicalMatch[1].trim();
  }
  text = text.replace(/و?\s*بحاجة للبقاء.*$/is, "");
  text = text.replace(/(?:\s+(?:متابعة|لمتابعة|لمتابعه|لتقييم|لحين|نظرا|نظراً|بسبب|بعد)\s+.*)$/is, "");
  text = text.replace(/الحالة\s+كاش.*$/is, "");
  text = text.replace(/@\w+.*$/is, "");
  text = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  text = text.replace(/^(?:يعاني|تعاني)\s+(?:المريض|المريضة|الحالة|الطفل|الطفله)\s+من\s+[^و]+و\s*(?:يحتاج|تحتاج|نحتاج)?\s*(?:الى|الي)?\s*/is, "");
  text = text.replace(/^طفل\s+يعانى\s+من\s+[^و]+و\s*/is, "");
  return text.trim();
}
function formatProcedureForCmWhatsapp(proc) {
  const lower = proc.toLowerCase().trim();
  if (lower.includes("transesophageal") || lower === "tee" || lower === "t.e.e" || lower.includes("\u0639\u0646 \u0637\u0631\u064A\u0642 \u0627\u0644\u0645\u0631\u064A\u0621") || lower.includes("\u0627\u064A\u0643\u0648 \u0628\u0627\u0644\u0645\u0646\u0638\u0627\u0631") || lower.includes("\u0625\u064A\u0643\u0648 \u0628\u0627\u0644\u0645\u0646\u0638\u0627\u0631")) {
    return "\u0645\u0648\u062C\u0627\u062A \u0641\u0648\u0642 \u0635\u0648\u062A\u064A\u0629 \u0639\u0644\u0649 \u0627\u0644\u0642\u0644\u0628 \u0639\u0646 \u0637\u0631\u064A\u0642 \u0627\u0644\u0645\u0631\u064A\u0621 (Transesophageal Echocardiography - TEE)";
  }
  if (lower.includes("mri brain with contrast") || lower.includes("mri") && lower.includes("brain") && lower.includes("contrast")) {
    return "\u0623\u0634\u0639\u0629 \u0631\u0646\u064A\u0646 \u0645\u063A\u0646\u0627\u0637\u064A\u0633\u064A \u0639\u0644\u0649 \u0627\u0644\u0645\u062E \u0628\u0627\u0644\u0635\u0628\u063A\u0629 (MRI Brain With Contrast)";
  }
  if (lower.includes("ct pancreas triphasic")) {
    return "\u0623\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629 \u062B\u0644\u0627\u062B\u064A\u0629 \u0627\u0644\u0645\u0631\u0627\u062D\u0644 \u0639\u0644\u0649 \u0627\u0644\u0628\u0646\u0643\u0631\u064A\u0627\u0633 (CT Pancreas Triphasic)";
  }
  if (lower.includes("pig tail")) {
    return "\u062A\u0631\u0643\u064A\u0628 \u0642\u0633\u0637\u0631\u0629 \u0628\u064A\u062C \u062A\u064A\u0644 (Pig Tail Insertion)";
  }
  return proc;
}
function extractProcedureFromApprovalReply(text) {
  if (!text) return "";
  const clean = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const m1 = clean.match(
    /(?:لا\s*مانع\s*من\s*(?:الدخول[^\n\r:،,-]{0,35})?(?:ل?[إا]جراء|ل?عمل|وعمل)|الموافقة\s*على\s*(?:عمل|إجراء|اجراء)?)\s*[:\s]*([^\n\r،,-]+?)(?=\s*(?:-|–|تحت|بحد|الحد|شامل|مع|فقط|$))/i
  );
  if (m1 && m1[1] && m1[1].trim().length > 3) {
    const res = m1[1].trim();
    if (!res.toLowerCase().includes("inpatient") && !res.toLowerCase().includes("clinical evaluation")) {
      return res;
    }
  }
  const m2 = clean.match(
    /(?:موافقة\s+على|معتمد\s+لـ?)\s*[:\s]*([^\n\r،,-]+?)(?=\s*(?:-|–|تحت|بحد|الحد|شامل|مع|فقط|$))/i
  );
  if (m2 && m2[1] && m2[1].trim().length > 3) {
    const res = m2[1].trim();
    if (!res.toLowerCase().includes("inpatient") && !res.toLowerCase().includes("clinical evaluation")) {
      return res;
    }
  }
  return "";
}
function detectPriceApprovalMode(record) {
  if (record.priceApprovalRequested) return "request";
  const text = [
    record.existingApprovalSnippet,
    record.replySnippet,
    record.aiThreadSummary,
    record.statusReasonArabic,
    record.coverageConditions
  ].filter(Boolean).join(" ").normalize("NFKC").replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647").replace(/ى/g, "\u064A");
  if (/خارج\s*(?:ال)?تعاقد/.test(text)) return "request";
  if (!/موافق[ةه]?\s+سعري[ةه]?/.test(text)) return null;
  const isRequest = /(?:احضار|لاحضار|بإحضار|باحضار|عمل|اعمل|لعمل|مطلوب|المطلوب|يجب|سوف\s+يتم|سيتم|برجاء|الرجاء|نرجو)\s+(?:يتم\s+)?(?:احضار\s+)?(?:اصل\s+)?موافق[ةه]?\s+سعري[ةه]?/.test(text);
  return isRequest ? "request" : "approved";
}
function formatPriceAmount(record) {
  if (record.creditLimitText) return record.creditLimitText;
  const n = record.creditLimit || record.approvedAmountLimit;
  return n && n > 0 ? `${n.toLocaleString("en-US")} \u062C.\u0645` : "";
}
function generateCmWhatsappMessage(record) {
  const patient = (record.patientName || "\u0627\u0644\u0645\u0631\u064A\u0636").trim();
  let bedInfo = (record.bed || "").trim();
  bedInfo = bedInfo.replace(/Physician.*$/i, "").trim();
  if (bedInfo && !bedInfo.toLowerCase().startsWith("bed") && !bedInfo.toLowerCase().startsWith("inpatient") && !bedInfo.toLowerCase().startsWith("icu") && !bedInfo.toLowerCase().startsWith("observation")) {
    bedInfo = `Bed ${bedInfo}`;
  }
  const line1 = bedInfo ? `*${patient}* - ${bedInfo}` : `*${patient}*`;
  let rawContractor = (record.contractorNormalized || record.contractorRaw || "\u0627\u0644\u062A\u0639\u0627\u0642\u062F").trim();
  if (rawContractor.includes("\u0645\u0633\u062A\u0634\u0641\u0649 \u0625\u064A\u0644\u064A\u062A") || rawContractor === "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F") {
    rawContractor = "\u0627\u0644\u062A\u0639\u0627\u0642\u062F";
  }
  const line2 = cleanContractorName(rawContractor) || rawContractor;
  let rawList = [];
  if (record.requestedServices && record.requestedServices.length > 0) {
    rawList = record.requestedServices.map((s) => s.name.trim()).filter(Boolean);
  } else if (record.matchedProcedures && record.matchedProcedures.length > 0) {
    rawList = record.matchedProcedures.map((m) => m.matchedName || m.serviceName).filter(Boolean);
  }
  rawList = rawList.filter((s) => {
    const l = s.toLowerCase();
    return !l.includes("clinical inpatient evaluation") && !l.includes("inpatient clinical evaluation") && !l.includes("clinical evaluation");
  });
  const fromReply = extractProcedureFromApprovalReply(
    (record.existingApprovalSnippet || "") + " " + (record.replySnippet || "")
  );
  let cleanedServices = rawList.map(extractCleanProcedurePhrase).map(formatProcedureForCmWhatsapp).filter(Boolean);
  let procText = "";
  if (fromReply) {
    const cleanFromReply = extractCleanProcedurePhrase(fromReply);
    if (cleanedServices.length > 0 && !cleanedServices.some((s) => s.includes(cleanFromReply) || cleanFromReply.includes(s))) {
      const primaryService = cleanedServices[0].replace(/\/\s*first\s*\d+\s*hours?/i, "").trim();
      procText = `${cleanFromReply} (${primaryService})`;
    } else {
      procText = cleanFromReply;
    }
  } else if (cleanedServices.length > 0) {
    procText = cleanedServices.join(" \u0648 ");
  } else if (record.diagnosis && !record.diagnosis.toLowerCase().includes("evaluation") && !record.diagnosis.toLowerCase().includes("staff")) {
    procText = record.diagnosis;
  } else {
    procText = "\u0627\u0644\u062F\u062E\u0648\u0644 \u0648\u0627\u0644\u0625\u062C\u0631\u0627\u0621\u0627\u062A \u0627\u0644\u0645\u0642\u0631\u0631\u0629";
  }
  const isApproved = record.status === "approved" || record.status === "conditionally_approved" || Boolean(record.hasExistingApproval);
  const isRefused = record.status === "refused" || Boolean(record.isRefused);
  let limitFormatted = "";
  if (record.creditLimitText) {
    limitFormatted = ` (\u062D\u062F \u0623\u0642\u0635\u0649: ${record.creditLimitText})`;
  } else if (record.creditLimit && record.creditLimit > 0) {
    limitFormatted = ` (\u062D\u062F \u0623\u0642\u0635\u0649: ${record.creditLimit.toLocaleString("en-US")} \u062C.\u0645)`;
  } else if (record.approvedAmountLimit && record.approvedAmountLimit > 0) {
    limitFormatted = ` (\u062D\u062F \u0623\u0642\u0635\u0649: ${record.approvedAmountLimit.toLocaleString("en-US")} \u062C.\u0645)`;
  }
  let copayFormatted = "";
  if (record.patientSharePercentage && record.patientSharePercentage > 0) {
    copayFormatted = ` (\u0646\u0633\u0628\u0629 \u0627\u0644\u062A\u062D\u0645\u0644: ${record.patientSharePercentage}%)`;
  }
  const unlisted = (record.matchedProcedures || []).filter(
    (m) => m.status === "unmatched" && (m.suggestedPrice || 0) > 0 && !isAccommodationOrGenericFee(m.serviceName)
  );
  const unlistedLines = unlisted.map((m) => {
    const name = formatProcedureForCmWhatsapp(extractCleanProcedurePhrase(m.serviceName)) || m.serviceName;
    const amt = ` \u0628\u0645\u0628\u0644\u063A ${m.suggestedPrice.toLocaleString("en-US")} \u062C.\u0645`;
    return { name, text: `\u0645\u0637\u0644\u0648\u0628 \u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629${amt} \u0639\u0644\u0649: ${name}` };
  });
  if (unlistedLines.length > 0 && !isApproved && !isRefused) {
    const body = unlistedLines.length === 1 ? unlistedLines[0].text : unlistedLines.map((u) => u.text).join(" | ");
    return `${line1}
${line2}
*${body}*`;
  }
  const priceMode = detectPriceApprovalMode(record);
  const priceAmount = record.priceApprovalRequested && record.priceApprovalAmount ? `${record.priceApprovalAmount.toLocaleString("en-US")} \u062C.\u0645` : formatPriceAmount(record);
  const priceText = priceAmount ? `\u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629 \u0628\u0645\u0628\u0644\u063A ${priceAmount}` : "\u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629";
  let line3 = "";
  if (priceMode === "request") {
    line3 = `*\u0645\u0637\u0644\u0648\u0628 ${priceText}${procText ? ` \u0639\u0644\u0649: ${procText}` : ""}*`;
  } else if (isApproved && priceMode === "approved") {
    line3 = `*\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649: ${procText} - ${priceText}*`;
  } else if (isApproved) {
    const condText = (record.coverageConditions || record.statusReasonArabic || "").trim();
    if (condText && (condText.startsWith("\u0645\u063A\u0637\u0627\u0629 \u0644\u0645\u062F\u0629") || condText.startsWith("\u0645\u063A\u0637\u0627\u0647 \u0644\u0645\u062F\u0647") || condText.startsWith("\u0645\u0634\u0631\u0648\u0637"))) {
      line3 = `*\u0645\u0648\u0627\u0641\u0642\u0629 \u0645\u0634\u0631\u0648\u0637\u0629 \u0639\u0644\u0649: ${procText} (${condText})*`;
    } else if (condText && (condText.startsWith("\u0645\u0627 \u0639\u062F\u0627") || condText.startsWith("\u0645\u0627\u0639\u062F\u0627") || condText.includes("\u062F\u0627\u062E\u0644 \u0627\u0644\u0645\u0633\u062A\u0634\u0641\u0649") || condText.includes("\u062F\u0627\u062E\u0644 \u0627\u0644\u0645\u0633\u062A\u0634\u0641\u064A"))) {
      line3 = `*\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649: ${procText} (${condText})*`;
    } else {
      line3 = `*\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649: ${procText}${limitFormatted}${copayFormatted}*`;
    }
  } else if (isRefused) {
    const refusalReason = extractRefusalReason(
      record.statusReasonArabic || record.refusalSnippet || record.coverageConditions
    );
    line3 = refusalReason ? `*\u062A\u0645 \u0631\u0641\u0636 \u0637\u0644\u0628 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649: ${procText} (${refusalReason})*` : `*\u062A\u0645 \u0631\u0641\u0636 \u0637\u0644\u0628 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649: ${procText}*`;
  } else {
    let actionPrefix = "";
    if (procText.startsWith("\u0633\u062D\u0628") || procText.startsWith("\u0639\u0645\u0644") || procText.startsWith("\u062A\u0631\u0643\u064A\u0628") || procText.startsWith("\u0627\u062C\u0631\u0627\u0621") || procText.startsWith("\u0625\u062C\u0631\u0627\u0621")) {
      actionPrefix = "";
    } else if (procText.startsWith("\u062A\u062D\u0644\u064A\u0644")) {
      actionPrefix = "\u0633\u062D\u0628 ";
    } else if (procText.startsWith("\u062F\u0639\u0627\u0645\u0629") || procText.startsWith("\u062F\u0639\u0627\u0645\u0647") || procText.startsWith("\u0642\u0633\u0637\u0631\u0629") || procText.startsWith("\u0642\u0633\u0637\u0631\u0647") || procText.startsWith("\u0627\u0646\u0628\u0648\u0628") || procText.startsWith("\u0623\u0646\u0628\u0648\u0628")) {
      actionPrefix = "\u062A\u0631\u0643\u064A\u0628 ";
    } else {
      actionPrefix = "\u0639\u0645\u0644 ";
    }
    line3 = `*\u0627\u0644\u0645\u0637\u0644\u0648\u0628 \u0645\u0648\u0627\u0641\u0642\u0629 ${actionPrefix}${procText}*`;
  }
  return `${line1}
${line2}
${line3}`;
}

// src/mail/parser/hisApprovalParser.ts
var REFUSAL_KEYWORDS = [
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0647",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0629",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A\u0647",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A\u0629",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A \u062A\u0627\u0645\u064A\u0646\u064A\u0627",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649 \u062A\u0623\u0645\u064A\u0646\u064A\u0627",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649 \u062A\u0623\u0645\u064A\u0646\u064A\u0627\u064B",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A \u062A\u0627\u0645\u0646\u064A\u0627",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649 \u062A\u0627\u0645\u0646\u064A\u0627",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A \u062A\u0627\u0645\u064A\u0646\u0627",
  "\u0627\u0644\u062D\u0627\u0644\u0647 \u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0647",
  "\u0627\u0644\u062D\u0627\u0644\u0629 \u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0629",
  "\u0627\u0644\u062D\u0627\u0644\u0629 \u063A\u064A\u0631 \u0645\u063A\u0637\u064A\u0629",
  "\u062C\u0645\u064A\u0639 \u0627\u0644\u0627\u062C\u0631\u0627\u0621\u0627\u062A \u0644\u0644\u062D\u0627\u0644\u0647 \u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0647",
  "\u062C\u0645\u064A\u0639 \u0627\u0644\u0625\u062C\u0631\u0627\u0621\u0627\u062A \u0644\u0644\u062D\u0627\u0644\u0629 \u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0629",
  "\u0644\u0639\u062F\u0645 \u0645\u062F \u0627\u0644\u0627\u0642\u0627\u0645\u0647 \u0648\u0631\u0641\u0639 \u0627\u0644\u062D\u062F \u0627\u0644\u0627\u0642\u0635\u064A",
  "\u0644\u0639\u062F\u0645 \u0645\u062F \u0627\u0644\u0625\u0642\u0627\u0645\u0629 \u0648\u0631\u0641\u0639 \u0627\u0644\u062D\u062F \u0627\u0644\u0623\u0642\u0635\u0649",
  "\u0644\u0639\u062F\u0645 \u0645\u062F \u0627\u0644\u0627\u0642\u0627\u0645\u0647",
  "\u0644\u0639\u062F\u0645 \u0645\u062F \u0627\u0644\u0625\u0642\u0627\u0645\u0629",
  "\u0644\u0639\u062F\u0645 \u0631\u0641\u0639 \u0627\u0644\u062D\u062F \u0627\u0644\u0627\u0642\u0635\u064A",
  "\u0644\u0639\u062F\u0645 \u0631\u0641\u0639 \u0627\u0644\u062D\u062F \u0627\u0644\u0623\u0642\u0635\u0649",
  "\u0643\u0627\u0634 \u0637\u0631\u0641 \u0627\u0644\u0627\u0647\u0644",
  "\u0643\u0627\u0634 \u0637\u0631\u0641 \u0627\u0644\u0623\u0647\u0644",
  "\u0643\u0627\u0634 \u0637\u0631\u0641 \u0627\u0644\u0645\u0631\u064A\u0636",
  "\u0639\u0644\u064A \u062D\u0633\u0627\u0628 \u0627\u0644\u0645\u0631\u064A\u0636",
  "\u0639\u0644\u0649 \u062D\u0633\u0627\u0628 \u0627\u0644\u0645\u0631\u064A\u0636",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0627\u0647\u0644 \u0644\u0644\u0631\u0633\u064A\u0628\u0634\u0646",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u0631\u064A\u0633\u0628\u0634\u0646",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0627\u0647\u0644 \u0644\u0644\u0631\u0633\u064A\u0628\u0634\u0646 \u0644\u0644\u062A\u063A\u0637\u064A\u0647",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u0631\u064A\u0633\u0628\u0634\u0646 \u0644\u0644\u062A\u063A\u0637\u064A\u0629",
  "\u0627\u0631\u0633\u0627\u0644 \u0627\u0644\u0627\u0647\u0644 \u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A",
  "\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A",
  "\u0627\u0631\u0633\u0627\u0644 \u0627\u0644\u0627\u0647\u0644 \u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u0644\u0644\u062A\u063A\u0637\u064A\u0647",
  "\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u062D\u0633\u0627\u0628\u0627\u062A \u0644\u0644\u062A\u063A\u0637\u064A\u0629",
  "\u0627\u0631\u0633\u0627\u0644 \u0627\u0644\u0627\u0647\u0644 \u0644\u0644\u062A\u063A\u0637\u064A\u0647",
  "\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u062A\u063A\u0637\u064A\u0629",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0627\u0647\u0644 \u0644\u0644\u062A\u063A\u0637\u064A\u0647",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0644\u0623\u0647\u0644 \u0644\u0644\u062A\u063A\u0637\u064A\u0629",
  "\u0642\u0633\u0645 \u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u064A",
  "\u0642\u0633\u0645 \u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u0649",
  "\u062A\u0648\u062C\u064A\u0647 \u0627\u0647\u0644 \u0627\u0644\u062D\u0627\u0644\u0647 \u0644\u0642\u0633\u0645 \u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u064A",
  "\u062A\u0648\u062C\u064A\u0647 \u0623\u0647\u0644 \u0627\u0644\u062D\u0627\u0644\u0629 \u0644\u0642\u0633\u0645 \u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u0649",
  "\u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u064A",
  "\u062D\u0633\u0627\u0628\u0627\u062A \u0627\u0644\u0645\u0631\u0636\u0649",
  "\u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A",
  "\u0641\u064A \u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A",
  "\u0641\u0649 \u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A",
  "\u062A\u0646\u0633\u064A\u0642 \u0639\u0645\u0644 \u0627\u0644\u062A\u062D\u0644\u064A\u0644 \u0637\u0631\u0641 \u0627\u0644\u062A\u0639\u0627\u0642\u062F \u0648\u0627\u0644\u0645\u0631\u064A\u0636 \u0641\u064A \u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A",
  "\u0637\u0631\u0641 \u0627\u0644\u062A\u0639\u0627\u0642\u062F \u0648\u0627\u0644\u0645\u0631\u064A\u0636 \u0641\u064A \u0645\u0639\u0645\u0644 \u062E\u0627\u0631\u062C\u064A",
  "\u0645\u0631\u0641\u0648\u0636",
  "\u0631\u0641\u0636",
  "\u063A\u064A\u0631 \u0645\u0639\u062A\u0645\u062F",
  "not approved",
  "rejected",
  "\u0646\u0639\u062A\u0630\u0631 \u0639\u0646 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0646\u0639\u062A\u0630\u0631 \u0639\u0646 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0629",
  "\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0647",
  "\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u0639\u0627\u0642\u062F"
];
var APPROVAL_KEYWORDS = [
  // Direct Arabic approvals
  "\u0644\u0627 \u0645\u0627\u0646\u0639",
  "\u0644\u0627\u0645\u0627\u0646\u0639",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0645\u0646 \u0627\u0644\u062F\u062E\u0648\u0644",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0645\u0646 \u0627\u0644\u062F\u062E\u0648\u0644",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0645\u0646 \u0639\u0645\u0644 \u0627\u0644\u0644\u0627\u0632\u0645",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0645\u0646 \u0639\u0645\u0644 \u0627\u0644\u0644\u0627\u0632\u0645",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0637\u0628\u0642\u0627 \u0644\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0637\u0628\u0642\u0627 \u0644\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0645\u0646 \u0639\u0645\u0644 \u0627\u0644\u0639\u0645\u0644\u064A\u0647",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0645\u0646 \u0639\u0645\u0644 \u0627\u0644\u0639\u0645\u0644\u064A\u0647",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0645\u0646 \u0639\u0645\u0644 \u0627\u0644\u0639\u0645\u0644\u064A\u0629",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0645\u0646 \u0639\u0645\u0644 \u0627\u0644\u0639\u0645\u0644\u064A\u0629",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0645\u0646 \u0627\u062C\u0631\u0627\u0621",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0645\u0646 \u0627\u062C\u0631\u0627\u0621",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0645\u0646 \u062A\u0642\u062F\u064A\u0645",
  "\u0644\u0627\u0645\u0627\u0646\u0639 \u0645\u0646 \u062A\u0642\u062F\u064A\u0645",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0648\u0641\u0642\u0627 \u0644\u0644\u0627\u0626\u062D\u0629",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0648\u0641\u0642\u0627 \u0644\u0644\u0627\u0626\u062D\u0647",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u062D\u0633\u0628 \u0627\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0628\u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0644\u0627 \u0645\u0627\u0646\u0639 \u0628\u0627\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0639\u0627\u0642\u062F",
  // Attachments / Forwarded approvals
  "\u0645\u0631\u0641\u0642 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u0627\u0644\u064A\u0643\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u0627\u0644\u064A\u0643\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u0625\u0644\u064A\u0643\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u0625\u0644\u064A\u0643\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u0644\u0633\u064A\u0627\u062F\u062A\u0643\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u0644\u0633\u064A\u0627\u062F\u062A\u0643\u0645 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u0637\u064A\u0647 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u0637\u064A\u0647 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u062A\u0642\u0631\u064A\u0631 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u062A\u0642\u0631\u064A\u0631 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u0635\u0648\u0631\u0629 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0645\u0631\u0641\u0642 \u0635\u0648\u0631\u0647 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0631\u0641\u0642 \u0635\u0648\u0631\u0647 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  // Price & contractual terms
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0633\u0639\u0631\u064A\u0629 \u0637\u0631\u0641\u0649",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0627\u0644\u0633\u0639\u0631\u064A\u0647 \u0637\u0631\u0641\u0649",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0633\u0639\u0631\u064A\u0629 \u0637\u0631\u0641\u0646\u0627",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0627\u0644\u0633\u0639\u0631\u064A\u0647 \u0637\u0631\u0641\u0646\u0627",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0627\u0644\u0633\u0639\u0631\u064A\u0629",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0627\u0644\u0633\u0639\u0631\u064A\u0647",
  "\u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629",
  "\u0645\u0648\u0627\u0641\u0642\u0647 \u0633\u0639\u0631\u064A\u0647",
  "\u062A\u0633\u0639\u064A\u0631\u0629 \u0633\u0639\u0631\u064A\u0629",
  "\u062A\u0633\u0639\u064A\u0631\u0647 \u0633\u0639\u0631\u064A\u0647",
  "\u062A\u0633\u0639\u064A\u0631\u0629",
  "\u062A\u0633\u0639\u064A\u0631\u0647",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0639\u0644\u0649",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u064A",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0639\u0644\u064A",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u0649",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0639\u0644\u0649",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629 \u0639\u0644\u064A",
  "\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647 \u0639\u0644\u064A",
  "\u0645\u0648\u0627\u0641\u0642\u0629 \u0628\u0627\u0644\u0644\u0627\u0626\u062D\u0629",
  "\u0645\u0648\u0627\u0641\u0642\u0647 \u0628\u0627\u0644\u0644\u0627\u0626\u062D\u0647",
  "\u0628\u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0628\u0627\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0648\u0641\u0642\u0627 \u0644\u062A\u0639\u0644\u064A\u0645\u0627\u062A \u0627\u0644\u062A\u0634\u063A\u064A\u0644",
  "\u0648\u0641\u0642\u0627\u064B \u0644\u062A\u0639\u0644\u064A\u0645\u0627\u062A \u0627\u0644\u062A\u0634\u063A\u064A\u0644",
  "\u0637\u0628\u0642\u0627 \u0644\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u0637\u0628\u0642\u0627\u064B \u0644\u0644\u062A\u0639\u0627\u0642\u062F",
  "\u064A\u0636\u0627\u0641 \u0639\u0644\u064A \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0647",
  "\u064A\u0636\u0627\u0641 \u0639\u0644\u0649 \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0629",
  "\u0628\u0641\u0627\u062A\u0648\u0631\u0647 \u0627\u0644\u0634\u0631\u0627\u0621",
  "\u0628\u0641\u0627\u062A\u0648\u0631\u0629 \u0627\u0644\u0634\u0631\u0627\u0621",
  "\u0645\u0639\u062A\u0645\u062F",
  "\u0645\u0648\u0627\u0641\u0642",
  "\u0646\u062D\u064A\u0637\u0643\u0645 \u0639\u0644\u0645\u0627 \u0628\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0646\u062D\u064A\u0637\u0643\u0645 \u0639\u0644\u0645\u0627 \u0628\u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  // English approval keywords
  "approved",
  "approve",
  "approval granted",
  "approval confirmed",
  "kind regards"
];
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/");
}
function cleanTextFromHtml(input) {
  if (!input) return "";
  return input.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function extractCleanReplyBody(html, text) {
  if (html) {
    let cleaned = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    const separatorRegexes = [
      /<hr[\s>]/i,
      /<div[^>]*id=["\x27]?divRplyFwdMsg["\x27]?/i,
      /<div[^>]*id=["\x27]?ms-outlook-mobile-body-separator-line["\x27]?/i,
      /<div[^>]*class=["\x27]?gmail_quote["\x27]?/i,
      /<div[^>]*class=["\x27]?gmail_attr["\x27]?/i,
      /<blockquote[\s>]/i,
      /-----Original Message-----/i,
      /----- Original Message -----/i,
      /<b[^>]*>From:<\/b>/i,
      /<b[^>]*>Sent:<\/b>/i,
      /From:\s*HIS\s*Notifications/i,
      /From:\s*Approvals/i,
      /<b>من:<\/b>/i,
      /<b>أرسلت:<\/b>/i
    ];
    let earliestIdx = cleaned.length;
    for (const r of separatorRegexes) {
      const match = cleaned.search(r);
      if (match !== -1 && match < earliestIdx) {
        earliestIdx = match;
      }
    }
    if (earliestIdx === cleaned.length) {
      const isInitialRequest = /Patient\s+Information/i.test(cleaned) || /SELECTED\s+SERVICES/i.test(cleaned) || /Patient\s+Barcode/i.test(cleaned) || /Type:\s*Request/i.test(cleaned) || /Category:\s*Approval/i.test(cleaned) || /HIS\s*Notifications/i.test(cleaned);
      if (isInitialRequest) {
        return "";
      }
    }
    const topHtml = cleaned.substring(0, earliestIdx);
    const $ = cheerio.load(topHtml);
    let reply = $("body").text().replace(/\s+/g, " ").trim();
    if (!reply) {
      reply = cleanTextFromHtml(topHtml);
    }
    reply = cleanTextFromHtml(reply);
    reply = reply.replace(/Get Outlook for (?:iOS|Android)/gi, "").replace(/Sent from my (?:iPhone|iPad|Galaxy)/gi, "").replace(/تم الإرسال من (?:هاتفي|Outlook)/gi, "").trim();
    if (/Patient\s+Information/i.test(reply) || /SELECTED\s+SERVICES/i.test(reply) || /Type:\s*Request/i.test(reply)) {
      return "";
    }
    if (reply.length > 0) return reply;
  }
  const textSeparators = [
    /-----Original Message-----/i,
    /----- Original Message -----/i,
    /From:\s*[^\n\r]+Sent:/i,
    /On\s+.+wrote:/i,
    /Get Outlook for/i,
    /From:\s*HIS\s*Notifications/i,
    /From:\s*Approvals/i
  ];
  let raw = text || "";
  let cut = raw.length;
  for (const sep of textSeparators) {
    const match = raw.search(sep);
    if (match !== -1 && match < cut) {
      cut = match;
    }
  }
  const candidate = cleanTextFromHtml(raw.substring(0, cut).trim());
  if (/Patient\s+Information/i.test(candidate) || /SELECTED\s+SERVICES/i.test(candidate) || /Type:\s*Request/i.test(candidate)) {
    return "";
  }
  return candidate;
}
function extractCreditLimit(text) {
  if (!text) return {};
  const normalized = text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e]/g, " ");
  const pattern = /(?:الحد\s+ال[اأإآ]قص[ىي]|بحد\s+[اأإآ]قص[ىي]|سقف\s+الموافق[ةه]|بمبلغ\s+لا\s+يتجاوز|في\s+حدود|موافق[ةه](?:\s+سعري[ةه])?\s+بمبلغ|معتمد\s+بمبلغ|لا\s+مانع(?:[^\d\n\r]{0,30})بمبلغ|تحصيل\s+مبلغ|مبلغ\s+(?:ت[اأإآ]مين\s+)?|(?:maximum\s+)?limit(?:\s+of)?|approved\s+limit|ceiling)(?:[^\d\n\r]{0,25})(\d+(?:[\.,]\d+)?)\s*(الف|ألف|الاف|آلاف|k)?/i;
  const match = normalized.match(pattern);
  if (match) {
    let num = parseFloat(match[1].replace(/,/g, ""));
    const unit = match[2]?.toLowerCase() || "";
    if (unit.includes("\u0627\u0644\u0641") || unit.includes("\u0623\u0644\u0641") || unit.includes("\u0627\u0644\u0627\u0641") || unit.includes("\u0622\u0644\u0627\u0641") || unit === "k") {
      num = num * 1e3;
    }
    if (!isNaN(num) && num > 0) {
      return {
        limit: num,
        formatted: `${num.toLocaleString("en-US")} EGP`
      };
    }
  }
  return {};
}
function extractCoPayment(text) {
  if (!text) return {};
  const normalized = text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e]/g, " ");
  const pattern = /(?:co-?payment(?:\s+of)?|co-?pay|copay|patient\s+share|تحمل(?:\s+المريض)?|نسبة(?:\s+ال)?تحمل)(?:[^\d\n\r%]{0,25})(\d+(?:\.\d+)?)\s*(?:%|بالمائة|بالمائه|في\s+الم(?:ي|ائ)ة)?/i;
  const match = normalized.match(pattern);
  if (match) {
    const val = parseFloat(match[1]);
    if (!isNaN(val) && val > 0 && val <= 100) {
      return {
        percentage: val,
        formatted: `${val}%`
      };
    }
  }
  const revMatch = normalized.match(/(\d+(?:\.\d+)?)\s*%\s*(?:co-?pay(?:ment)?|تحمل)/i);
  if (revMatch) {
    const val = parseFloat(revMatch[1]);
    if (!isNaN(val) && val > 0 && val <= 100) {
      return {
        percentage: val,
        formatted: `${val}%`
      };
    }
  }
  return {};
}
function detectConditionalCoverage(text, cleanReply) {
  const target = cleanReply && cleanReply.trim().length > 0 ? cleanReply : text || "";
  if (!target.trim()) return { isConditional: false };
  const norm = target.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
  const exceptMatch = norm.match(/(?:ماعدا|ما\s+عدا|باستثناء|عدا)\s+(.+?)(?:غير\s+مغط[ىياه]+|خارج\s+التغطي[ةه]|كاش|طرف\s+المريض)/i);
  if (exceptMatch) {
    const item = exceptMatch[1].trim();
    return {
      isConditional: true,
      conditionText: `\u0645\u0627 \u0639\u062F\u0627 ${item.toUpperCase()} \u063A\u064A\u0631 \u0645\u063A\u0637\u0649`,
      snippet: target.trim()
    };
  }
  const noteMatch = norm.match(/علما\s+(?:بان|بان)\s+(.+?غير\s+مغط[ىياه]+.*?)(?:داخل\s+المستشف[ىي]|$|\.|\n)/i);
  if (noteMatch) {
    let cond = noteMatch[1].trim();
    if (!cond.includes("\u062F\u0627\u062E\u0644 \u0627\u0644\u0645\u0633\u062A\u0634\u0641")) {
      cond += " \u062F\u0627\u062E\u0644 \u0627\u0644\u0645\u0633\u062A\u0634\u0641\u0649";
    }
    return {
      isConditional: true,
      conditionText: cond,
      snippet: target.trim()
    };
  }
  const durationMatch = norm.match(/(?:بان\s+)?(?:الحال[ةه]\s+)?مغط[ىياه]+\s+لمد[ةه]\s+(.+?)(?:$|\.|\n)/i);
  if (durationMatch) {
    return {
      isConditional: true,
      conditionText: `\u0645\u063A\u0637\u0627\u0629 \u0644\u0645\u062F\u0629 ${durationMatch[1].trim()}`,
      snippet: target.trim()
    };
  }
  return { isConditional: false };
}
function detectRefusal(text, subject, cleanReply) {
  const conditional = detectConditionalCoverage(text, cleanReply);
  if (conditional.isConditional) {
    return { hasRefusal: false, snippet: "" };
  }
  if (cleanReply && cleanReply.trim().length > 0) {
    const normReply = cleanReply.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
    for (const kw of REFUSAL_KEYWORDS) {
      const kwNorm = kw.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
      if (normReply.includes(kwNorm)) {
        return { hasRefusal: true, snippet: cleanReply.trim(), reason: extractRefusalReason(cleanReply) };
      }
    }
  }
  const normText = (text || "").normalize("NFKC");
  const normSubj = (subject || "").normalize("NFKC");
  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined.toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
  for (const kw of REFUSAL_KEYWORDS) {
    const kwNorm = kw.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
    const idx = normalized.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 150);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < combined.length) snippet = snippet + "...";
      return { hasRefusal: true, snippet, reason: extractRefusalReason(snippet) };
    }
  }
  return { hasRefusal: false, snippet: "" };
}
function detectExistingApproval(text, subject, cleanReply) {
  const conditional = detectConditionalCoverage(text, cleanReply);
  if (conditional.isConditional) {
    const credit2 = extractCreditLimit(cleanReply) || extractCreditLimit(text);
    const copay2 = extractCoPayment(cleanReply) || extractCoPayment(text);
    return {
      hasApproval: true,
      snippet: cleanReply?.trim() || conditional.snippet || "",
      isConditional: true,
      conditionText: conditional.conditionText,
      creditLimit: credit2.limit,
      creditLimitText: credit2.formatted,
      patientSharePercentage: copay2.percentage
    };
  }
  const refusalCheck = detectRefusal(text, subject, cleanReply);
  if (refusalCheck.hasRefusal) {
    return { hasApproval: false, snippet: "" };
  }
  if (cleanReply && cleanReply.trim().length > 0) {
    const normReply = cleanReply.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647").replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, "\u0644\u0627 \u0645\u0627\u0646\u0639");
    const credit2 = extractCreditLimit(cleanReply) || extractCreditLimit(text);
    const copay2 = extractCoPayment(cleanReply) || extractCoPayment(text);
    if (!/خارج\s*(?:ال)?تعاقد/.test(normReply)) {
      const attachedMatch = normReply.search(/مرفق\s+(?:اليكم|إليكم|لسيادتكم|طيه|تقرير\s+|صورة\s+|صوره\s+)?(?:ال)?موافق/);
      if (attachedMatch !== -1) {
        return {
          hasApproval: true,
          snippet: cleanReply.trim(),
          creditLimit: credit2.limit,
          creditLimitText: credit2.formatted,
          patientSharePercentage: copay2.percentage
        };
      }
      const approvalSearchText2 = normReply.replace(
        /(?:الرجاء|رجاء|برجاء|نرجو|يرجي|يرجى|المطلوب|مطلوب|نطلب|طلب)\s+(?:من\s+سيادتكم\s+)?(?:ال)?موافق[ةه]?(?![\u0600-\u06FF])/g,
        " "
      ).replace(
        /(?:يجب|سوف|سيتم|يتم|لاحضار|احضار|بإحضار|باحضار|عمل|اعمل|لعمل|برجاء\s+احضار)\s+(?:يتم\s+)?(?:احضار\s+)?(?:اصل\s+)?(?:ال)?موافق[ةه]?(?:\s+سعري[ةه])?(?![\u0600-\u06FF])/g,
        " "
      );
      for (const kw of APPROVAL_KEYWORDS) {
        const kwNorm = kw.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647").replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, "\u0644\u0627 \u0645\u0627\u0646\u0639");
        const idx = kwNorm === "\u0645\u0648\u0627\u0641\u0642" ? approvalSearchText2.search(/(?<![\u0600-\u06FF])موافق(?![\u0600-\u06FF])/) : approvalSearchText2.indexOf(kwNorm);
        if (idx !== -1) {
          return {
            hasApproval: true,
            snippet: cleanReply.trim(),
            creditLimit: credit2.limit,
            creditLimitText: credit2.formatted,
            patientSharePercentage: copay2.percentage
          };
        }
      }
      if (credit2.limit) {
        return {
          hasApproval: true,
          snippet: cleanReply.trim(),
          creditLimit: credit2.limit,
          creditLimitText: credit2.formatted,
          patientSharePercentage: copay2.percentage
        };
      }
    }
  }
  const normText = (text || "").normalize("NFKC");
  const normSubj = (subject || "").normalize("NFKC");
  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined.toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647").replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, "\u0644\u0627 \u0645\u0627\u0646\u0639");
  const credit = extractCreditLimit(combined);
  const copay = extractCoPayment(combined);
  if (/خارج\s*(?:ال)?تعاقد/.test(normalized)) {
    return { hasApproval: false, snippet: "" };
  }
  const approvalSearchText = normalized.replace(
    /(?:الرجاء|رجاء|برجاء|نرجو|يرجي|يرجى|المطلوب|مطلوب|نطلب|طلب)\s+(?:من\s+سيادتكم\s+)?(?:ال)?موافق[ةه]?(?![\u0600-\u06FF])/g,
    " "
  ).replace(
    /(?:يجب|سوف|سيتم|يتم|لاحضار|احضار|بإحضار|باحضار|عمل|اعمل|لعمل|برجاء\s+احضار)\s+(?:يتم\s+)?(?:احضار\s+)?(?:اصل\s+)?(?:ال)?موافق[ةه]?(?:\s+سعري[ةه])?(?![\u0600-\u06FF])/g,
    " "
  );
  const attachedIdx = approvalSearchText.search(/مرفق\s+(?:اليكم|إليكم|لسيادتكم|طيه|تقرير\s+|صورة\s+|صوره\s+)?(?:ال)?موافق/);
  if (attachedIdx !== -1) {
    const start = Math.max(0, attachedIdx - 25);
    const end = Math.min(combined.length, attachedIdx + 120);
    let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
    if (start > 0) snippet = "..." + snippet;
    return {
      hasApproval: true,
      snippet,
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
      patientSharePercentage: copay.percentage
    };
  }
  for (const kw of APPROVAL_KEYWORDS) {
    const kwNorm = kw.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647").replace(/(?<![\u0600-\u06FF])لا\s*مانع/g, "\u0644\u0627 \u0645\u0627\u0646\u0639");
    const idx = kwNorm === "\u0645\u0648\u0627\u0641\u0642" ? approvalSearchText.search(/(?<![\u0600-\u06FF])موافق(?![\u0600-\u06FF])/) : approvalSearchText.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 150);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < combined.length) snippet = snippet + "...";
      return {
        hasApproval: true,
        snippet,
        creditLimit: credit.limit,
        creditLimitText: credit.formatted,
        patientSharePercentage: copay.percentage
      };
    }
  }
  if (credit.limit && approvalSearchText === normalized) {
    return {
      hasApproval: true,
      snippet: stripSentFromSignatures(combined.substring(0, 150)).trim(),
      creditLimit: credit.limit,
      creditLimitText: credit.formatted,
      patientSharePercentage: copay.percentage
    };
  }
  return { hasApproval: false, snippet: "" };
}
function detectReplies(parsed) {
  const subject = parsed.subject || "";
  const isReSubject = /^(re|رد|fw|fwd)\s*:/i.test(subject.trim());
  const hasInReplyTo = Boolean(parsed.inReplyTo);
  const hasReferences = Array.isArray(parsed.references) ? parsed.references.length > 0 : Boolean(parsed.references);
  const rawContent = (parsed.text || "") + "\n" + (parsed.html || "");
  const hasQuotedMarkers = /-----Original Message-----/i.test(rawContent) || /From:.*Sent:.*To:/is.test(rawContent) || /On\s+.+wrote:/i.test(rawContent) || /بتاريخ\s+.+كتب/i.test(rawContent) || /id=["\x27]?divRplyFwdMsg["\x27]?/i.test(rawContent) || /id=["\x27]?ms-outlook-mobile-body-separator-line["\x27]?/i.test(rawContent);
  if (isReSubject || hasInReplyTo || hasReferences || hasQuotedMarkers || parsed.cleanReply && parsed.cleanReply.length > 0) {
    if (parsed.cleanReply && parsed.cleanReply.length > 0) {
      return {
        hasReplies: true,
        snippet: parsed.cleanReply
      };
    }
    let replySnippet = "";
    const cleanContent = cleanTextFromHtml(parsed.text || (parsed.html ? parsed.html : ""));
    const sentences = cleanContent.split(/[.\n\r]+/).map((s) => s.trim()).filter((s) => s.length > 4);
    for (const s of sentences) {
      if (!s.toLowerCase().includes("inpatient approval") && !s.toLowerCase().includes("patient information") && !s.toLowerCase().includes("selected services") && !s.toLowerCase().includes("from:") && !s.toLowerCase().includes("to:") && !s.toLowerCase().includes("sent:") && !s.toLowerCase().includes("subject:")) {
        replySnippet = stripSentFromSignatures(s);
        if (replySnippet.length > 4) break;
      }
    }
    return {
      hasReplies: true,
      snippet: replySnippet ? `"${replySnippet}"` : ""
    };
  }
  return { hasReplies: false, snippet: "" };
}
function parseHisApprovalEmail(msg) {
  const decodedHtml = decodeHtmlEntities(msg.htmlBody || msg.textBody || "");
  const $ = cheerio.load(decodedHtml);
  const fullText = $("body").text().replace(/\s+/g, " ").trim() || decodedHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const subjectMatch = msg.subject.match(/(?:RE:\s*)?(?:\[URGENT\]\s*)?Inpatient Approval\s*-\s*(.+?)\s*\(MRN:\s*(\d+)\)/i);
  let patientName = subjectMatch ? subjectMatch[1].trim() : "";
  let mrn = subjectMatch ? subjectMatch[2].trim() : "";
  let admissionDate = "";
  let admissionType = "Inpatient";
  let bed = "Inpatient Bed";
  let physician = "Hospital Staff";
  let contractorRaw = "";
  let diagnosis = "";
  let requestDetails = "";
  $("tr").each((_, tr) => {
    const cells = $(tr).find("td, th");
    if (cells.length < 2) return;
    for (let i = 0; i < cells.length; i++) {
      const cellText = cells.eq(i).text().replace(/\s+/g, " ").trim();
      const nextCell = i + 1 < cells.length ? cells.eq(i + 1) : null;
      const nextCellText = nextCell ? nextCell.text().replace(/\s+/g, " ").trim() : "";
      if (!patientName && /^Patient(?:\s*Name)?\s*[:\s]*$/i.test(cellText) && nextCellText) {
        patientName = nextCellText;
      }
      if (!admissionDate && /^Admission(?:\s*Date)?\s*[:\s]*$/i.test(cellText) && nextCellText) {
        admissionDate = nextCellText;
      }
      if (/^(?:Admission|Visit)\s*Type\s*[:\s]*$/i.test(cellText)) {
        const fullRowText = $(tr).text();
        admissionType = fullRowText.includes("Inpatient") ? "Inpatient" : "Outpatient";
        const bedMatch = fullRowText.match(/Bed:\s*([^–\n<]+)/i);
        if (bedMatch) bed = bedMatch[1].replace(/Physician.*$/i, "").trim();
      }
      if ((!physician || physician === "Hospital Staff") && /^Physician\s*[:\s]*$/i.test(cellText) && nextCellText) {
        physician = nextCellText;
      }
      if (!contractorRaw && /^(?:Contractor(?:\s*Name)?|Company(?:\s*Name)?|Customer(?:\s*Name)?|جهة\s*التعاقد|الجهة\s*التعاقدية|اسم\s*الشركة|التعاقد|الشركة)\s*[:\s]*$/i.test(cellText) && nextCellText) {
        const cleaned = cleanContractorName(nextCellText);
        if (cleaned && cleaned.toLowerCase() !== "contractor" && !cleaned.includes("\u0645\u0633\u062A\u0634\u0641\u0649 \u0625\u064A\u0644\u064A\u062A")) {
          contractorRaw = cleaned;
        }
      }
      if (!diagnosis && /^Diagnosis\s*[:\s]*$/i.test(cellText) && nextCellText) {
        diagnosis = nextCellText;
      }
    }
  });
  $("td, th, p, div, span").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!contractorRaw) {
      const cMatch = text.match(/^(?:Contractor(?:\s*Name)?|Company(?:\s*Name)?|جهة\s*التعاقد|الجهة\s*التعاقدية|اسم\s*الشركة)\s*[:\s]+(.+)$/i);
      if (cMatch) {
        const cleaned = cleanContractorName(cMatch[1]);
        if (cleaned && cleaned.toLowerCase() !== "contractor" && !cleaned.includes("\u0645\u0633\u062A\u0634\u0641\u0649 \u0625\u064A\u0644\u064A\u062A")) {
          contractorRaw = cleaned;
        }
      }
    }
    if (!patientName) {
      const pMatch = text.match(/^Patient(?:\s*Name)?\s*[:\s]+(.+)$/i);
      if (pMatch) patientName = pMatch[1].trim();
    }
    if (!physician || physician === "Hospital Staff") {
      const phMatch = text.match(/^Physician\s*[:\s]+(.+)$/i);
      if (phMatch) physician = phMatch[1].trim();
    }
    if (!diagnosis) {
      const dMatch = text.match(/^Diagnosis\s*[:\s]+(.+)$/i);
      if (dMatch) diagnosis = dMatch[1].trim();
    }
    if (!bed || bed === "Inpatient Bed") {
      const bMatch = text.match(/Bed:\s*([^–\n<]+)/i);
      if (bMatch) bed = bMatch[1].replace(/Physician.*$/i, "").trim();
    }
    if (text.includes("Request Details")) {
      const container = $(el).closest("div, table").find("div, p, span").last().text().trim();
      if (container && container !== text) requestDetails = container;
    }
  });
  if (!patientName) {
    const pMatch = fullText.match(/Patient Name:\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i) || fullText.match(/(?:حاله|حالة)\s*[:\/]\s*([^<\n\r]+?)(?=\s*(?:Contractor|Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|جهة|الجهة|الرقم|$))/i);
    if (pMatch) patientName = pMatch[1].replace(/(?:Contractor|Visit Type|MRN).*/i, "").trim();
  }
  if (!mrn) {
    const bMatch = fullText.match(/Patient Barcode:\s*(\d+)/i) || fullText.match(/(?:MRN|الرقم الطبي)\s*[:\/\s]*(\d+)/i) || msg.subject.match(/\(MRN:\s*(\d+)\)/i);
    if (bMatch) mrn = bMatch[1].trim();
  }
  if (!contractorRaw) {
    const cMatch = fullText.match(/Contractor(?:\s*Name)?\s*[:\s]+([^<\n\r]+?)(?=\s+(?:Visit|Admission|Physician|Diagnosis|Bed|Request|Selected|$))/i) || fullText.match(/(?:جهة\s*التعاقد|الجهة\s*التعاقدية)\s*[:\s]+([^<\n\r]+?)(?=\s+(?:التشخيص|الطبيب|رقم|تاريخ|$))/i);
    if (cMatch) {
      const candidate = cleanContractorName(cMatch[1].trim());
      if (candidate && candidate.toLowerCase() !== "contractor" && !candidate.includes("\u0645\u0633\u062A\u0634\u0641\u0649 \u0625\u064A\u0644\u064A\u062A")) {
        contractorRaw = candidate;
      }
    }
  }
  if (!diagnosis) {
    const diagMatch = fullText.match(/Diagnosis[:\s]+([^\n\r<]+)/i);
    if (diagMatch) diagnosis = diagMatch[1].trim();
  }
  if (contractorRaw) {
    contractorRaw = cleanContractorName(contractorRaw);
  }
  const requestedServices = [];
  $("tr").each((_, tr) => {
    const rowText = $(tr).text();
    const isExcluded = rowText.includes("Patient Name") || rowText.includes("Admission Date") || rowText.includes("Admission Type") || rowText.includes("Physician") || rowText.includes("Contractor") || rowText.includes("Diagnosis") || rowText.includes("Service Name") || rowText.includes("TOTAL AMOUNT") || rowText.includes("SELECTED SERVICES") || rowText.includes("Bed:");
    if (!isExcluded) {
      const cells = $(tr).find("td");
      if (cells.length >= 2) {
        const srvName = cells.eq(0).text().trim();
        const priceStr = cells.eq(1).text().replace(/[^0-9.]/g, "").trim();
        const priceNum = parseFloat(priceStr);
        if (srvName && !isNaN(priceNum) && priceNum > 0) {
          requestedServices.push({
            name: srvName,
            rawPrice: priceNum
          });
        }
      }
    }
  });
  if (requestedServices.length === 0 && requestDetails) {
    const cleanDetails = extractCleanProcedurePhrase(requestDetails);
    if (cleanDetails && cleanDetails.length > 3) {
      requestedServices.push({
        name: cleanDetails,
        rawPrice: 0
      });
    }
  }
  const cleanReply = extractCleanReplyBody(msg.htmlBody, msg.textBody);
  const isReply = /^(re|رد|fw|fwd)\s*:/i.test(msg.subject) || Boolean(msg.inReplyTo) || cleanReply.length > 0;
  const refusal = isReply ? detectRefusal(fullText, msg.subject, cleanReply) : { hasRefusal: false, snippet: "" };
  const approval = isReply ? detectExistingApproval(fullText, msg.subject, cleanReply) : { hasApproval: false, snippet: "" };
  const replies = isReply ? detectReplies({
    subject: msg.subject,
    text: msg.textBody,
    html: msg.htmlBody,
    cleanReply
  }) : { hasReplies: false, snippet: "" };
  const credit = isReply ? (cleanReply ? extractCreditLimit(cleanReply) : null) || extractCreditLimit(fullText) || {} : {};
  const copay = isReply ? (cleanReply ? extractCoPayment(cleanReply) : null) || extractCoPayment(fullText) || {} : {};
  return {
    patientName: patientName || "\u063A\u064A\u0631 \u0645\u0633\u062C\u0644",
    mrn: mrn || "000000",
    bed,
    admissionType,
    physician,
    contractorRaw: contractorRaw || "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F",
    contractorNormalized: contractorRaw ? cleanContractorName(contractorRaw) : "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F",
    priceListYear: "2025",
    diagnosis: diagnosis || "Clinical Inpatient Evaluation",
    requestedServices,
    financialTerms: {
      approvedAmountLimit: credit.limit || null,
      patientSharePercentage: copay.percentage || null,
      coverageConditions: approval.conditionText || approval.snippet || cleanReply || void 0
    },
    hasReplies: isReply,
    hasExistingApproval: isReply && approval.hasApproval,
    isRefused: isReply && refusal.hasRefusal,
    isConditionalApproval: isReply && Boolean(approval.isConditional),
    refusalReason: isReply && refusal.hasRefusal ? refusal.reason : void 0,
    statusReasonArabic: isReply ? refusal.hasRefusal ? refusal.snippet : approval.hasApproval ? approval.conditionText || approval.snippet : cleanReply || void 0 : void 0,
    cleanReplyBody: isReply && cleanReply ? cleanReply : void 0,
    isReplyMessage: isReply,
    attachments: msg.attachments || [],
    rawBody: msg.htmlBody || msg.textBody || ""
  };
}

// src/lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
var getEnv = (key) => {
  if (typeof import.meta !== "undefined" && import.meta.env?.[key]) {
    return String(import.meta.env[key]);
  }
  if (typeof process !== "undefined" && process.env?.[key]) {
    return String(process.env[key]);
  }
  return "";
};
var supabaseUrl = getEnv("VITE_SUPABASE_URL") || getEnv("SUPABASE_URL");
var supabaseAnonKey = getEnv("VITE_SUPABASE_ANON_KEY") || getEnv("SUPABASE_ANON_KEY");
var supabaseServiceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") || getEnv("SUPABASE_SERVICE_KEY");
var isSupabaseConfigured = () => {
  return typeof supabaseUrl === "string" && supabaseUrl.startsWith("https://") && typeof supabaseAnonKey === "string" && supabaseAnonKey.length > 20;
};
var isSupabaseAdminConfigured = () => {
  return typeof supabaseUrl === "string" && supabaseUrl.startsWith("https://") && typeof supabaseServiceKey === "string" && supabaseServiceKey.length > 20;
};
var supabase = isSupabaseConfigured() ? createClient(supabaseUrl, supabaseAnonKey) : null;
var supabaseAdmin = isSupabaseAdminConfigured() ? createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
}) : supabase;

// src/mail/storage/cursorManager.ts
var client = supabaseAdmin || supabase;
var DEFAULT_FOLDER = "InApprovals";
async function loadCursorFromPostgres(folderName = DEFAULT_FOLDER) {
  const fallbackCursor = {
    folderName,
    token: void 0,
    lastSyncedAt: (/* @__PURE__ */ new Date(0)).toISOString(),
    totalSyncedCount: 0
  };
  if (!client) {
    console.warn("[Cursor Manager] Supabase client unavailable; using fresh cursor.");
    return fallbackCursor;
  }
  try {
    const { data, error } = await client.from("sync_checkpoints").select("folder_name, sync_state_token, last_synced_at, total_synced_count").eq("folder_name", folderName).maybeSingle();
    if (error) {
      console.warn(`[Cursor Manager] Failed to load watermark for "${folderName}":`, error.message);
      return fallbackCursor;
    }
    if (!data) {
      return fallbackCursor;
    }
    return {
      folderName: data.folder_name,
      token: data.sync_state_token || void 0,
      lastSyncedAt: data.last_synced_at || (/* @__PURE__ */ new Date(0)).toISOString(),
      totalSyncedCount: Number(data.total_synced_count) || 0
    };
  } catch (err) {
    console.error(`[Cursor Manager] Unexpected error reading cursor:`, err.message || err);
    return fallbackCursor;
  }
}
async function saveCursorToPostgres(cursor, itemsIncrement = 0) {
  if (!client) {
    return false;
  }
  try {
    const newTotal = (cursor.totalSyncedCount || 0) + itemsIncrement;
    const { error } = await client.from("sync_checkpoints").upsert(
      {
        folder_name: cursor.folderName,
        sync_state_token: cursor.token || null,
        last_synced_at: (/* @__PURE__ */ new Date()).toISOString(),
        total_synced_count: newTotal
      },
      { onConflict: "folder_name" }
    );
    if (error) {
      console.error(`[Cursor Manager] Failed to save watermark for "${cursor.folderName}":`, error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Cursor Manager] Unexpected error writing cursor:`, err.message || err);
    return false;
  }
}
async function triggerPhiRetentionPurge(retentionDays = 30) {
  if (!client) return { success: false };
  try {
    const { data, error } = await client.rpc("purge_expired_raw_emails", {
      retention_days: retentionDays
    });
    if (error) {
      console.warn("[PHI Retention Purge] RPC error:", error.message);
      return { success: false };
    }
    const res = data;
    const total = (res?.purged_staging_count || 0) + (res?.purged_approvals_count || 0);
    if (total > 0) {
      console.log(`[PHI Retention Purge] \u{1F9F9} Purged raw bodies for ${total} records older than ${retentionDays} days.`);
    }
    return { success: true, purgedCount: total };
  } catch (err) {
    console.warn("[PHI Retention Purge] Error executing purge:", err.message || err);
    return { success: false };
  }
}

// src/mail/attachments/attachmentHandler.ts
import crypto from "crypto";
import path from "path";
var BUCKET_NAME = "approval-attachments";
var MAX_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024;
var ALLOWED_MIME_TYPES = /* @__PURE__ */ new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/tiff"
]);
var ALLOWED_EXTENSIONS = /* @__PURE__ */ new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".tiff",
  ".tif"
]);
function validateAttachment(att) {
  if (att.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
    return {
      valid: false,
      reason: `File size ${att.sizeBytes} exceeds maximum allowed size of 15MB`
    };
  }
  const ext = path.extname(att.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `Extension "${ext}" is not permitted for medical attachments`
    };
  }
  if (att.contentType && !ALLOWED_MIME_TYPES.has(att.contentType.toLowerCase())) {
    if (att.contentType !== "application/octet-stream") {
      return {
        valid: false,
        reason: `MIME type "${att.contentType}" is not in the allowed list`
      };
    }
  }
  return { valid: true };
}
async function uploadAttachmentToStorage(approvalId, att, buffer) {
  const validation = validateAttachment(att);
  if (!validation.valid) {
    console.warn(`[Attachment Security] \u26A0\uFE0F Skipped attachment "${att.name}": ${validation.reason}`);
    return {
      ...att,
      contentBase64: void 0
      // Drop raw content from memory
    };
  }
  const client4 = supabaseAdmin;
  if (!client4) {
    console.warn("[Attachment Storage] Supabase Admin client not configured; skipping cloud upload.");
    return {
      ...att,
      contentBase64: void 0
    };
  }
  const year = (/* @__PURE__ */ new Date()).getFullYear().toString();
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").substring(0, 16);
  const ext = path.extname(att.name).toLowerCase() || ".bin";
  const safeName = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `approvals/${year}/${approvalId}/${hash}_${safeName}`;
  try {
    const { error: uploadError } = await client4.storage.from(BUCKET_NAME).upload(storagePath, buffer, {
      contentType: att.contentType || "application/octet-stream",
      upsert: true
    });
    if (uploadError) {
      console.error(`[Attachment Storage] Failed to upload ${storagePath}:`, uploadError.message);
      return { ...att, contentBase64: void 0 };
    }
    const { data: signedData, error: signError } = await client4.storage.from(BUCKET_NAME).createSignedUrl(storagePath, 3600);
    return {
      name: att.name,
      contentType: att.contentType,
      sizeBytes: buffer.length,
      storagePath,
      signedUrl: signError ? void 0 : signedData?.signedUrl,
      contentBase64: void 0
    };
  } catch (err) {
    console.error(`[Attachment Storage] Unexpected error uploading ${att.name}:`, err.message || err);
    return { ...att, contentBase64: void 0 };
  }
}

// src/services/approvalPostgresService.ts
import crypto2 from "crypto";
var client2 = supabaseAdmin || supabase;
function toDeterministicUuid(seed) {
  const hash = crypto2.createHash("sha256").update(seed).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    "a" + hash.slice(17, 20),
    hash.slice(20, 32)
  ].join("-");
}
async function persistApprovalToPostgres(record) {
  if (!client2) {
    return { success: false, error: "Supabase client is not configured." };
  }
  const convKey = record.conversationId;
  const deliveryKey = record.messageId || record.exchangeItemId;
  const rawSeed = convKey || deliveryKey || record.id || record.mrn;
  let uuid = toDeterministicUuid(rawSeed);
  let receivedIso = record.receivedAt && record.receivedAt.toDate ? record.receivedAt.toDate().toISOString() : typeof record.receivedAt === "string" ? record.receivedAt : (/* @__PURE__ */ new Date()).toISOString();
  if (convKey) {
    try {
      const { data: existing } = await client2.from("inpatient_approvals").select("id, received_at").eq("conversation_id", convKey).maybeSingle();
      if (existing?.id) {
        uuid = existing.id;
        if (existing.received_at && new Date(existing.received_at) < new Date(receivedIso)) {
          receivedIso = existing.received_at;
        }
      }
    } catch {
    }
  } else if (deliveryKey) {
    try {
      const { data: existing } = await client2.from("inpatient_approvals").select("id, received_at").eq("exchange_message_id", deliveryKey).maybeSingle();
      if (existing?.id) {
        uuid = existing.id;
        if (existing.received_at && new Date(existing.received_at) < new Date(receivedIso)) {
          receivedIso = existing.received_at;
        }
      }
    } catch {
    }
  }
  const contentHash = crypto2.createHash("sha256").update(
    `${record.conversationId || ""}|${record.messageId || ""}|${record.mrn || ""}|${record.receivedAt || ""}|${record.diagnosis || ""}`
  ).digest("hex");
  const mrnHash = crypto2.createHash("sha256").update(`salt_elite_approvals_${record.mrn || ""}`).digest("hex");
  const allowedStatuses = ["received", "parsed", "matched", "needs_review", "draft_created", "answered", "refused"];
  const dbStatus = allowedStatuses.includes(record.status || "") ? record.status : "received";
  const payload = {
    id: uuid,
    exchange_message_id: record.messageId || record.exchangeItemId || null,
    content_hash: contentHash,
    conversation_id: record.conversationId || `conv_${uuid.slice(0, 8)}`,
    received_at: receivedIso,
    patient_identifier_hash: mrnHash,
    patient_name: record.patientName || "\u0645\u0631\u064A\u0636 \u063A\u064A\u0631 \u0645\u062D\u062F\u062F",
    mrn: record.mrn || "000000",
    bed: record.bed || null,
    admission_type: record.admissionType || "Inpatient",
    physician: record.physician || null,
    contractor_raw: record.contractorRaw || null,
    contractor_normalized: record.contractorNormalized || null,
    contractor_officer: record.contractorOfficer || null,
    price_list_year: record.priceListYear || "2025",
    diagnosis: record.diagnosis || null,
    requested_services: record.requestedServices || [],
    matched_procedures: record.matchedProcedures || [],
    financial_terms: {
      patientSharePercentage: record.patientSharePercentage ?? -1,
      approvedAmountLimit: record.approvedAmountLimit ?? record.creditLimit ?? -1,
      creditLimitText: record.creditLimitText ?? null,
      coverageConditions: record.coverageConditions ?? ""
    },
    status: dbStatus,
    status_reason_arabic: record.statusReasonArabic ? record.statusReasonArabic.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() : null,
    state_timestamps: {
      received_at: receivedIso,
      updated_at: (/* @__PURE__ */ new Date()).toISOString(),
      ...record.draftedAt ? { drafted_at: record.draftedAt } : {},
      ...record.answeredAt ? { answered_at: record.answeredAt } : {}
    },
    suggested_draft_reply: record.draftBody || record.suggestedDraftReply || null,
    cm_whatsapp_message: record.cmWhatsappMessage || null,
    has_replies: Boolean(record.hasReplies),
    has_existing_approval: Boolean(record.hasExistingApproval),
    is_refused: Boolean(record.isRefused),
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    const { data, error } = await client2.from("inpatient_approvals").upsert(payload, {
      onConflict: "id"
    }).select("id").single();
    if (error) {
      console.error("[Postgres Approvals] Upsert error:", error.message);
      return { success: false, error: error.message };
    }
    return { success: true, id: data?.id || uuid };
  } catch (err) {
    console.error("[Postgres Approvals] Exception during upsert:", err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

// src/firebase.ts
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut
} from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  getFirestore,
  doc,
  setDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  writeBatch,
  serverTimestamp
} from "firebase/firestore";
var getEnvVar = (key) => {
  if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[key]) {
    return String(import.meta.env[key]).trim();
  }
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    return String(process.env[key]).trim();
  }
  return "";
};
var firebaseConfig = {
  apiKey: getEnvVar("VITE_FIREBASE_API_KEY"),
  authDomain: getEnvVar("VITE_FIREBASE_AUTH_DOMAIN"),
  projectId: getEnvVar("VITE_FIREBASE_PROJECT_ID"),
  storageBucket: getEnvVar("VITE_FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: getEnvVar("VITE_FIREBASE_MESSAGING_SENDER_ID"),
  appId: getEnvVar("VITE_FIREBASE_APP_ID"),
  firestoreDatabaseId: getEnvVar("VITE_FIREBASE_DATABASE_ID") || void 0
};
var useEnv = Boolean(firebaseConfig.apiKey && firebaseConfig.apiKey.startsWith("AIzaSy"));
console.log("Firebase Init Config Debug (Safe):", {
  usingEnvOverrides: useEnv,
  apiKeyLength: firebaseConfig.apiKey ? firebaseConfig.apiKey.length : 0,
  apiKeyPrefix: firebaseConfig.apiKey ? firebaseConfig.apiKey.substring(0, 6) : "none",
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  firestoreDatabaseId: firebaseConfig.firestoreDatabaseId
});
var safeFirebaseConfig = {
  ...firebaseConfig,
  apiKey: firebaseConfig.apiKey || "AIzaSy_mock_api_key_for_test_runner",
  projectId: firebaseConfig.projectId || "mock-firebase-project"
};
var app = initializeApp(safeFirebaseConfig);
var authInstance;
try {
  authInstance = getAuth(app);
} catch (err) {
  authInstance = {
    currentUser: null
  };
}
function setupOptimizedFirestore() {
  const isNode = typeof window === "undefined";
  if (isNode) {
    const nodeSettings = {
      localCache: memoryLocalCache()
    };
    try {
      if (firebaseConfig.firestoreDatabaseId) {
        return initializeFirestore(app, nodeSettings, firebaseConfig.firestoreDatabaseId);
      }
      return initializeFirestore(app, nodeSettings);
    } catch {
      return firebaseConfig.firestoreDatabaseId ? getFirestore(app, firebaseConfig.firestoreDatabaseId) : getFirestore(app);
    }
  }
  const multiTabSettings = {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    }),
    experimentalAutoDetectLongPolling: true
  };
  try {
    if (firebaseConfig.firestoreDatabaseId) {
      return initializeFirestore(app, multiTabSettings, firebaseConfig.firestoreDatabaseId);
    }
    return initializeFirestore(app, multiTabSettings);
  } catch (err) {
    console.warn("Persistent IndexedDB cache unavailable, falling back to memory cache:", err?.message || err);
    try {
      const memorySettings = {
        localCache: memoryLocalCache(),
        experimentalAutoDetectLongPolling: true
      };
      if (firebaseConfig.firestoreDatabaseId) {
        return initializeFirestore(app, memorySettings, firebaseConfig.firestoreDatabaseId);
      }
      return initializeFirestore(app, memorySettings);
    } catch {
      return firebaseConfig.firestoreDatabaseId ? getFirestore(app, firebaseConfig.firestoreDatabaseId) : getFirestore(app);
    }
  }
}
var db = setupOptimizedFirestore();
var googleProvider = new GoogleAuthProvider();

// src/services/approvalFirestoreSync.ts
import { doc as doc2, setDoc as setDoc2 } from "firebase/firestore";
async function mirrorApprovalToFirestore(record) {
  if (!db || !record.id) return;
  try {
    const docRef = doc2(db, "inpatient_approvals", record.id);
    const firestorePayload = {
      id: record.id,
      messageId: record.messageId || null,
      conversationId: record.conversationId || null,
      receivedAt: record.receivedAt || (/* @__PURE__ */ new Date()).toISOString(),
      patientName: record.patientName || "\u063A\u064A\u0631 \u0645\u0633\u062C\u0644",
      mrn: record.mrn || "000000",
      bed: record.bed || null,
      admissionType: record.admissionType || "Inpatient",
      physician: record.physician || null,
      contractorRaw: record.contractorRaw || null,
      contractorNormalized: record.contractorNormalized || null,
      contractorOfficer: record.contractorOfficer || null,
      priceListYear: record.priceListYear || "2025",
      diagnosis: record.diagnosis || null,
      requestedServices: record.requestedServices || [],
      matchedProcedures: record.matchedProcedures || [],
      financialTerms: {
        patientSharePercentage: record.patientSharePercentage ?? -1,
        approvedAmountLimit: record.approvedAmountLimit ?? -1,
        creditLimitText: record.creditLimitText ?? null,
        coverageConditions: record.coverageConditions ?? ""
      },
      status: record.status || "received",
      statusReasonArabic: record.statusReasonArabic || null,
      suggestedDraftReply: record.suggestedDraftReply || record.draftBody || null,
      draftBody: record.draftBody || record.suggestedDraftReply || null,
      cmWhatsappMessage: record.cmWhatsappMessage || null,
      hasReplies: Boolean(record.hasReplies),
      hasExistingApproval: Boolean(record.hasExistingApproval),
      isRefused: Boolean(record.isRefused),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await setDoc2(docRef, firestorePayload, { merge: true });
  } catch (err) {
    console.warn(`[Firestore Mirror] Failed to mirror approval ${record.id}:`, err?.message || err);
  }
}

// src/services/contractorOfficerResolver.ts
import fs from "fs";
import path2 from "path";
import * as XLSX from "xlsx";
var OFFICER_DISPLAY_NAMES = {
  "\u0632\u064A\u0627\u062F": "\u0632\u064A\u0627\u062F",
  "\u0646\u0627\u062F\u064A\u0646": "\u0646\u0627\u062F\u064A\u0646",
  "\u0627\u0628\u0648 \u0627\u0644\u0648\u0641\u0627": "\u0645\u062D\u0645\u062F \u0627\u0628\u0648 \u0627\u0644\u0648\u0641\u0627",
  "\u062F\u064A\u0627\u0646\u0627": "\u062F\u064A\u0627\u0646\u0627",
  "\u062C\u0627\u0628\u0631": "\u0645\u062D\u0645\u062F \u062C\u0627\u0628\u0631",
  "\u062D\u0645\u0632\u0629": "\u0623\u062D\u0645\u062F \u062D\u0645\u0632\u0629",
  "\u0637\u0627\u0631\u0642": "\u0637\u0627\u0631\u0642"
};
var STOP_WORDS = /* @__PURE__ */ new Set([
  "\u0634\u0631\u0643\u0647",
  "\u0634\u0631\u0643\u0629",
  "\u0641\u062D\u0635",
  "\u0643\u0627\u0634",
  "cash",
  "co",
  "company",
  "\u0645\u062C\u0645\u0648\u0639\u0647",
  "\u0645\u062C\u0645\u0648\u0639\u0629",
  "group",
  "egypt",
  "\u0645\u0635\u0631",
  "\u0644\u0644\u062A\u0627\u0645\u064A\u0646",
  "\u0644\u0644\u062A\u0623\u0645\u064A\u0646",
  "\u0644\u0644\u062A\u0627\u0645\u064A\u0646\u0627\u062A",
  "\u0644\u0644\u062A\u0623\u0645\u064A\u0646\u0627\u062A",
  "\u0644\u0644\u0628\u062A\u0631\u0648\u0644",
  "\u0628\u062A\u0631\u0648\u0644",
  "\u0644\u0644\u0631\u0639\u0627\u064A\u0629",
  "\u0644\u0644\u062E\u062F\u0645\u0627\u062A",
  "\u0627\u0644\u0637\u0628\u064A\u0629",
  "\u0627\u0644\u0635\u062D\u064A\u0629"
]);
var TRANSLITERATION_PAIRS = {
  "globemed": ["\u062C\u0644\u0648\u0628 \u0645\u064A\u062F", "\u062C\u0644\u0648\u0628\u0645\u064A\u062F"],
  "enayatisr": ["\u0639\u0646\u0627\u064A\u0647 \u0645\u0635\u0631", "\u0639\u0646\u0627\u064A\u0629 \u0645\u0635\u0631"],
  "gasco": ["\u062C\u0627\u0633\u0643\u0648"],
  "alico": ["\u0627\u0644\u064A\u0643\u0648", "\u0645\u064A\u062A\u0644\u0627\u064A\u0641 \u0627\u0644\u064A\u0643\u0648", "metlife"],
  "mednet": ["\u0645\u064A\u062F\u0646\u062A", "\u0645\u064A\u062F \u0646\u062A"],
  "medright": ["\u0645\u064A\u062F\u0631\u0627\u064A\u062A", "\u0645\u064A\u062F \u0631\u0627\u064A\u062A", "med right"],
  "axa": ["\u0627\u0643\u0633\u0627", "\u0623\u0643\u0633\u0627"],
  "gig": ["\u062C\u064A \u0627\u064A \u062C\u064A", "gig egypt"],
  "dms": ["\u0627\u0644\u0645\u0627\u0633\u064A\u0629", "\u0627\u0644\u0645\u0627\u0633\u064A\u0647"],
  "nextcare": ["\u0646\u0643\u0633\u062A \u0643\u064A\u0631", "\u0646\u064A\u0643\u0633\u062A \u0643\u064A\u0631", "next care"],
  "wepco": ["\u0648\u064A\u0628\u0643\u0648"],
  "petromaint": ["\u0628\u062A\u0631\u0648\u0645\u0646\u062A"],
  "ethydco": ["\u0627\u064A\u062B\u062F\u0643\u0648", "\u0627\u062B\u064A\u062F\u0643\u0648"],
  "sidpec": ["\u0633\u064A\u062F\u0628\u0643"],
  "amoc": ["\u0627\u0645\u0648\u0643"],
  "eprom": ["\u0627\u064A\u0628\u0631\u0648\u0645"],
  "gupco": ["\u062C\u0627\u0628\u0643\u0648"],
  "bapetco": ["\u0628\u062F\u0631 \u0627\u0644\u062F\u064A\u0646 \u0644\u0644\u0628\u062A\u0631\u0648\u0644", "\u0628\u062F\u0631 \u0627\u0644\u062F\u064A\u0646"]
};
function normalizeContractorText(text) {
  if (!text) return "";
  return String(text).toLowerCase().replace(/[\u064B-\u065F\u200e\u200f\u00a0]/g, "").replace(/[ـ]/g, "").replace(/[أإآ]/g, "\u0627").replace(/ة/g, "\u0647").replace(/[ىئ]/g, "\u064A").replace(/ؤ/g, "\u0648").replace(/[^\u0600-\u06FFa-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function getContractorTokens(text) {
  const norm = normalizeContractorText(text);
  if (!norm) return [];
  return norm.split(" ").map((t) => t.replace(/^ال(?=.{3,})/, "")).filter((t) => t && !STOP_WORDS.has(t));
}
var cachedMappings = [];
var cachedOfficers = {};
var lastExcelMtime = 0;
var lastExcelPath = "";
function loadContractorOfficersFromExcel(excelPath = path2.resolve(process.cwd(), "contacts_table.xlsx")) {
  try {
    if (!fs.existsSync(excelPath)) {
      console.warn(`[ContractorResolver] Excel file not found at ${excelPath}. Using fallback cache.`);
      return cachedMappings;
    }
    const stat = fs.statSync(excelPath);
    if (stat.mtimeMs === lastExcelMtime && excelPath === lastExcelPath && cachedMappings.length > 0) {
      return cachedMappings;
    }
    console.log(`[ContractorResolver] Reading latest contractor officers from ${excelPath}...`);
    const fileBuffer = fs.readFileSync(excelPath);
    const readFn = XLSX.read || XLSX.default?.read;
    const utils2 = XLSX.utils || XLSX.default?.utils;
    const wb = readFn(fileBuffer, { type: "buffer" });
    const sheetName = wb.SheetNames.includes("Contacts") ? "Contacts" : wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const rows = utils2.sheet_to_json(sheet, { header: 1 });
    if (!rows || rows.length < 2) {
      console.warn("[ContractorResolver] Invalid or empty sheet format in Excel file.");
      return cachedMappings;
    }
    const headerRow = rows[0];
    const phoneRow = rows.find((r) => r.some((c) => String(c).includes("+20")));
    const officerCols = [];
    const officersMap = {};
    for (let c = 1; c < headerRow.length; c++) {
      const rawHeader = String(headerRow[c] || "").trim();
      if (!rawHeader) continue;
      const normHeader = normalizeContractorText(rawHeader);
      let officerKey = Object.keys(OFFICER_DISPLAY_NAMES).find(
        (k) => normalizeContractorText(k) === normHeader
      ) || rawHeader;
      const displayName = OFFICER_DISPLAY_NAMES[officerKey] || rawHeader;
      const phone = phoneRow && phoneRow[c] ? String(phoneRow[c]).trim() : void 0;
      const info = {
        name: displayName,
        columnHeader: rawHeader,
        phone
      };
      officerCols.push({ colIdx: c, header: rawHeader, officer: info });
      officersMap[displayName] = info;
    }
    const mappings = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row === phoneRow) continue;
      for (const col of officerCols) {
        const cellValue = row[col.colIdx];
        if (!cellValue) continue;
        const rawName = String(cellValue).trim();
        if (!rawName || rawName.startsWith("+20") || rawName.length < 2) continue;
        const normTokens = getContractorTokens(rawName);
        if (normTokens.length === 0 && normalizeContractorText(rawName).length === 0) continue;
        const aliases = [rawName];
        const parenMatch = rawName.match(/\(([^)]+)\)/);
        if (parenMatch && parenMatch[1]) {
          aliases.push(parenMatch[1].trim());
        }
        const cleanedWithoutParen = rawName.replace(/\([^)]+\)/g, "").trim();
        if (cleanedWithoutParen && cleanedWithoutParen !== rawName) {
          aliases.push(cleanedWithoutParen);
        }
        const normRaw = normalizeContractorText(rawName);
        for (const [eng, arList] of Object.entries(TRANSLITERATION_PAIRS)) {
          if (normRaw.includes(eng) || arList.some((ar) => normRaw.includes(normalizeContractorText(ar)))) {
            aliases.push(eng);
            aliases.push(...arList);
          }
        }
        mappings.push({
          rawName,
          canonicalName: cleanedWithoutParen || rawName,
          normalizedTokens: normTokens,
          officer: col.officer,
          aliases
        });
      }
    }
    try {
      const jsonPath = path2.resolve(process.cwd(), "data", "contractors.json");
      if (fs.existsSync(jsonPath)) {
        const contractorsJson = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        if (Array.isArray(contractorsJson)) {
          for (const item of contractorsJson) {
            if (!item.name) continue;
            const itemAliases = Array.isArray(item.aliases) ? item.aliases : [item.name];
            const match = mappings.find(
              (m) => normalizeContractorText(m.rawName) === normalizeContractorText(item.name) || normalizeContractorText(m.canonicalName) === normalizeContractorText(item.name) || m.aliases.some((a) => itemAliases.some((ia) => normalizeContractorText(a) === normalizeContractorText(ia)))
            );
            if (match) {
              match.canonicalName = item.name.trim();
              if (item.contractorOfficer && item.contractorOfficer.trim()) {
                match.officer = {
                  name: item.contractorOfficer.trim(),
                  columnHeader: match.officer?.columnHeader || item.contractorOfficer.trim(),
                  phone: match.officer?.phone || ""
                };
              }
              for (const alias of itemAliases) {
                if (!match.aliases.includes(alias)) {
                  match.aliases.push(alias);
                }
              }
            } else {
              mappings.push({
                canonicalName: item.name.trim(),
                rawName: item.name.trim(),
                normalizedTokens: getContractorTokens(item.name),
                officer: {
                  name: item.contractorOfficer && item.contractorOfficer.trim() ? item.contractorOfficer.trim() : "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F",
                  columnHeader: item.contractorOfficer && item.contractorOfficer.trim() ? item.contractorOfficer.trim() : "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F",
                  phone: ""
                },
                aliases: Array.from(/* @__PURE__ */ new Set([item.name.trim(), ...itemAliases]))
              });
            }
          }
        }
      }
    } catch (err) {
    }
    cachedMappings = mappings;
    cachedOfficers = officersMap;
    lastExcelMtime = stat.mtimeMs;
    lastExcelPath = excelPath;
    console.log(
      `[ContractorResolver] Loaded ${mappings.length} contractor mappings across ${officerCols.length} officers.`
    );
    return cachedMappings;
  } catch (err) {
    console.error("[ContractorResolver] Error reading contacts_table.xlsx:", err);
    return cachedMappings;
  }
}
function calculateTokenScore(queryTokens, targetTokens) {
  if (!queryTokens.length || !targetTokens.length) return 0;
  const setQ = new Set(queryTokens);
  const setT = new Set(targetTokens);
  let matches = 0;
  for (const q of setQ) {
    if (setT.has(q)) {
      matches += 1;
    } else {
      for (const t of setT) {
        if (q.length > 3 && t.length > 3 && (q.startsWith(t) || t.startsWith(q))) {
          matches += 0.8;
          break;
        }
      }
    }
  }
  const precision = matches / setQ.size;
  const recall = matches / setT.size;
  if (precision === 0 || recall === 0) return 0;
  return 2 * precision * recall / (precision + recall);
}
function resolveOfficerByContractor(rawQuery, excelPath) {
  if (!rawQuery || !rawQuery.trim()) {
    return {
      matched: false,
      officerName: "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F (\u064A\u062A\u0637\u0644\u0628 \u062A\u062D\u062F\u064A\u062F \u0645\u0646\u0633\u0642 \u0627\u0644\u0633\u064A\u0644\u0632)",
      contractorNormalized: "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F",
      confidenceScore: 0,
      matchType: "unmatched"
    };
  }
  const mappings = loadContractorOfficersFromExcel(excelPath);
  if (!mappings.length) {
    return {
      matched: false,
      officerName: "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F (\u064A\u062A\u0637\u0644\u0628 \u062A\u062D\u062F\u064A\u062F \u0645\u0646\u0633\u0642 \u0627\u0644\u0633\u064A\u0644\u0632)",
      contractorNormalized: rawQuery.trim(),
      confidenceScore: 0,
      matchType: "unmatched"
    };
  }
  const queryNorm = normalizeContractorText(rawQuery);
  const queryTokens = getContractorTokens(rawQuery);
  for (const m of mappings) {
    for (const alias of m.aliases) {
      if (normalizeContractorText(alias) === queryNorm) {
        return {
          matched: true,
          officerName: m.officer.name,
          officerPhone: m.officer.phone,
          contractorNormalized: m.canonicalName,
          confidenceScore: 1,
          matchType: "exact"
        };
      }
    }
  }
  const queryTokenKey = queryTokens.join("");
  if (queryTokenKey) {
    for (const m of mappings) {
      if (m.normalizedTokens.join("") === queryTokenKey) {
        return {
          matched: true,
          officerName: m.officer.name,
          officerPhone: m.officer.phone,
          contractorNormalized: m.canonicalName,
          confidenceScore: 0.98,
          matchType: "alias"
        };
      }
    }
  }
  for (const m of mappings) {
    for (const alias of m.aliases) {
      const aliasNorm = normalizeContractorText(alias);
      if (aliasNorm.length >= 4 && (queryNorm.includes(aliasNorm) || aliasNorm.includes(queryNorm))) {
        return {
          matched: true,
          officerName: m.officer.name,
          officerPhone: m.officer.phone,
          contractorNormalized: m.canonicalName,
          confidenceScore: 0.92,
          matchType: "substring"
        };
      }
    }
  }
  let bestMapping = null;
  let bestScore = 0;
  for (const m of mappings) {
    const score = calculateTokenScore(queryTokens, m.normalizedTokens);
    if (score > bestScore) {
      bestScore = score;
      bestMapping = m;
    }
  }
  if (bestMapping && bestScore >= 0.65) {
    return {
      matched: true,
      officerName: bestMapping.officer.name,
      officerPhone: bestMapping.officer.phone,
      contractorNormalized: bestMapping.canonicalName,
      confidenceScore: Math.round(bestScore * 100) / 100,
      matchType: "token_overlap"
    };
  }
  return {
    matched: false,
    officerName: "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F (\u064A\u062A\u0637\u0644\u0628 \u062A\u062D\u062F\u064A\u062F \u0645\u0646\u0633\u0642 \u0627\u0644\u0633\u064A\u0644\u0632)",
    contractorNormalized: rawQuery.trim(),
    confidenceScore: bestScore ? Math.round(bestScore * 100) / 100 : 0,
    matchType: "unmatched"
  };
}

// src/services/aliasService.ts
var cachedEntries = null;
var exactAliasMap = null;
var abbrevMap = null;
function buildIndexes(entries) {
  cachedEntries = entries;
  exactAliasMap = /* @__PURE__ */ new Map();
  abbrevMap = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const official = entry.official_name;
    for (const ab of entry.abbreviations) {
      const k = ab.toUpperCase().trim();
      if (!abbrevMap.has(k)) abbrevMap.set(k, []);
      const list = abbrevMap.get(k);
      if (!list.includes(official)) list.push(official);
    }
    for (const a of entry.aliases_en) {
      const norm = normalizeText(a);
      if (norm) {
        if (!exactAliasMap.has(norm)) exactAliasMap.set(norm, []);
        const list = exactAliasMap.get(norm);
        if (!list.includes(official)) list.push(official);
      }
    }
    for (const a of entry.aliases_ar) {
      const norm = normalizeArabic(a);
      if (norm) {
        if (!exactAliasMap.has(norm)) exactAliasMap.set(norm, []);
        const list = exactAliasMap.get(norm);
        if (!list.includes(official)) list.push(official);
      }
    }
  }
}
function initCatalogAliasesSync() {
  if (cachedEntries || typeof window !== "undefined") return;
  try {
    const fs3 = __require("fs");
    const path4 = __require("path");
    const filePath = path4.resolve(process.cwd(), "public", "catalog_aliases.json");
    if (fs3.existsSync(filePath)) {
      const raw = fs3.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      buildIndexes(data);
    }
  } catch {
  }
}
if (typeof window === "undefined") {
  try {
    initCatalogAliasesSync();
  } catch {
  }
}
function findOfficialNamesForQuery(query2, arabicQuery) {
  if (!exactAliasMap || !abbrevMap) {
    initCatalogAliasesSync();
    if (!exactAliasMap || !abbrevMap) return [];
  }
  const results = /* @__PURE__ */ new Set();
  const cleanEng = cleanHisProcedureQuery(query2);
  const qEngNorm = normalizeText(cleanEng);
  const qRawNorm = normalizeText(query2);
  const qUpper = query2.toUpperCase().trim();
  const qAraNorm = arabicQuery ? normalizeArabic(arabicQuery) : normalizeArabic(query2);
  if (abbrevMap.has(qUpper)) {
    for (const name of abbrevMap.get(qUpper)) {
      results.add(name);
    }
  }
  if (qEngNorm && exactAliasMap.has(qEngNorm)) {
    for (const name of exactAliasMap.get(qEngNorm)) {
      results.add(name);
    }
  }
  if (qRawNorm && qRawNorm !== qEngNorm && exactAliasMap.has(qRawNorm)) {
    for (const name of exactAliasMap.get(qRawNorm)) {
      results.add(name);
    }
  }
  if (qAraNorm && exactAliasMap.has(qAraNorm)) {
    for (const name of exactAliasMap.get(qAraNorm)) {
      results.add(name);
    }
  }
  if (results.size === 0 && cachedEntries) {
    const qTokens = (qEngNorm ? qEngNorm.split(/\s+/) : []).filter((t) => t.length >= 3);
    const qAraTokens = (qAraNorm ? qAraNorm.split(/\s+/) : []).filter((t) => t.length >= 3);
    if (qTokens.length >= 2 || qAraTokens.length >= 2) {
      for (const entry of cachedEntries) {
        let matched = false;
        if (qTokens.length >= 2) {
          for (const alias of entry.aliases_en) {
            const aTokens = new Set(normalizeText(alias).split(/\s+/));
            const overlap = qTokens.filter((t) => aTokens.has(t)).length;
            if (overlap === qTokens.length) {
              results.add(entry.official_name);
              matched = true;
              break;
            }
          }
        }
        if (!matched && qAraTokens.length >= 2) {
          for (const alias of entry.aliases_ar) {
            const aTokens = new Set(normalizeArabic(alias).split(/\s+/));
            const overlap = qAraTokens.filter((t) => aTokens.has(t)).length;
            if (overlap === qAraTokens.length) {
              results.add(entry.official_name);
              break;
            }
          }
        }
        if (results.size >= 10) break;
      }
    }
  }
  return Array.from(results);
}
function getAliasesForQuery(query2, arabicQuery) {
  const officialNames = findOfficialNamesForQuery(query2, arabicQuery);
  if (officialNames.length === 0 || !cachedEntries) return [];
  const synonyms = /* @__PURE__ */ new Set();
  const officialSet = new Set(officialNames);
  for (const entry of cachedEntries) {
    if (officialSet.has(entry.official_name)) {
      synonyms.add(entry.official_name);
      for (const a of entry.aliases_en) synonyms.add(a);
      for (const a of entry.aliases_ar) synonyms.add(a);
      for (const ab of entry.abbreviations) synonyms.add(ab);
    }
  }
  return Array.from(synonyms);
}

// src/services/procedureService.ts
function hasClinicalMismatch(queryEngNorm, queryAraNorm, rowEngNorm, rowAraNorm) {
  const queryCombined = `${queryEngNorm} ${queryAraNorm}`;
  const rowCombined = `${rowEngNorm} ${rowAraNorm}`;
  const isTeeQuery = /\b(?:transesophageal|tee|t\.e\.e)\b|ايكو مريئي|عبر المريء/i.test(queryCombined);
  const isTeeRow = /\b(?:transesophageal|tee|t\.e\.e)\b|ايكو مريئي|عبر المريء/i.test(rowCombined);
  if (isTeeQuery !== isTeeRow) return true;
  if (hasAntibodyConflict(queryCombined, rowCombined)) return true;
  if (hasLabInvestigationConflict(queryCombined, rowCombined)) return true;
  return false;
}
var GENERIC_MODALITY_TERMS = /* @__PURE__ */ new Set([
  "ct",
  "mri",
  "sonar",
  "doppler",
  "duplex",
  "ultrasound",
  "computed tomography",
  "magnetic resonance imaging",
  "\u0627\u0634\u0639\u0647 \u0645\u0642\u0637\u0639\u064A\u0647",
  "\u0627\u0634\u0639\u0629 \u0645\u0642\u0637\u0639\u064A\u0629",
  "\u0631\u0646\u064A\u0646 \u0645\u063A\u0646\u0627\u0637\u064A\u0633\u064A",
  "\u0645\u0648\u062C\u0627\u062A \u0635\u0648\u062A\u064A\u0647",
  "\u0645\u0648\u062C\u0627\u062A \u0635\u0648\u062A\u064A\u0629",
  "\u0633\u0648\u0646\u0627\u0631",
  "\u062F\u0648\u0628\u0644\u0631",
  "\u062F\u0648\u0628\u0644\u0643\u0633"
]);
function searchLocalPricelist(cashList, requestedProcedures) {
  const finalResults = [];
  for (const proc of requestedProcedures) {
    const cleanEng = cleanHisProcedureQuery(proc.name);
    const qEng = normalizeText(cleanEng);
    const qEngRaw = normalizeText(proc.name);
    const qAra = proc.arabic ? normalizeArabic(proc.arabic) : "";
    const aliasOfficialNames = proc.aliasOfficialNames || findOfficialNamesForQuery(proc.name, proc.arabic);
    const aliasNorms = new Set(aliasOfficialNames.map((n) => normalizeText(n)));
    const expandedAliases = getAliasesForQuery(proc.name, proc.arabic);
    const synonyms = [...expandMedicalSynonyms(cleanEng || proc.name), ...expandedAliases];
    if (!qEng && !qAra && !qEngRaw && aliasOfficialNames.length === 0) continue;
    const exactMatches = [];
    const partialMatches = [];
    for (const item of cashList) {
      const itemEng = normalizeText(item.nameEnglish);
      const itemAra = normalizeArabic(item.nameArabic);
      if (hasClinicalMismatch(qEng || qEngRaw, qAra, itemEng, itemAra)) {
        continue;
      }
      const isExactEng = Boolean(qEng && (itemEng === qEng || itemEng === qEngRaw));
      const isExactAra = Boolean(qAra && itemAra === qAra);
      const isAliasMatch = Boolean(
        aliasNorms.size > 0 && (aliasNorms.has(itemEng) || itemAra && aliasOfficialNames.some((n) => normalizeArabic(n) === itemAra))
      );
      if (isExactEng || isExactAra || isAliasMatch) {
        exactMatches.push({
          ...item,
          requestedProcedureName: proc.name
        });
        continue;
      }
      const isSubEng = Boolean(qEng && itemEng.includes(qEng));
      const isSubAra = Boolean(qAra && itemAra.includes(qAra));
      if (isSubEng || isSubAra) {
        partialMatches.push({
          ...item,
          requestedProcedureName: proc.name
        });
        continue;
      }
      const qTokens = (qEng || qEngRaw).split(/\s+/).filter((t) => t.length >= 3);
      if (qTokens.length >= 2) {
        const itemTokens = new Set(itemEng.split(/\s+/));
        if (qTokens.every((t) => itemTokens.has(t) || itemEng.includes(t))) {
          partialMatches.push({
            ...item,
            requestedProcedureName: proc.name
          });
          continue;
        }
      }
      if (synonyms.length > 0) {
        let isSynMatch = false;
        let isExactSynMatch = false;
        for (const syn of synonyms) {
          const normSynEn = normalizeText(syn);
          const normSynAr = normalizeArabic(syn);
          if (normSynEn && !GENERIC_MODALITY_TERMS.has(normSynEn) && normSynEn !== qEng) {
            if (itemEng === normSynEn) {
              isExactSynMatch = true;
              break;
            } else if (normSynEn.length >= 5 && itemEng.includes(normSynEn)) {
              isSynMatch = true;
              break;
            }
          }
          if (normSynAr && !GENERIC_MODALITY_TERMS.has(normSynAr) && normSynAr !== qAra) {
            if (itemAra === normSynAr) {
              isExactSynMatch = true;
              break;
            } else if (normSynAr.length >= 5 && itemAra.includes(normSynAr)) {
              isSynMatch = true;
              break;
            }
          }
        }
        if (isExactSynMatch) {
          exactMatches.push({
            ...item,
            requestedProcedureName: proc.name
          });
        } else if (isSynMatch) {
          partialMatches.push({
            ...item,
            requestedProcedureName: proc.name
          });
        }
      }
    }
    if (exactMatches.length > 0) {
      const sortedExact = exactMatches.sort((a, b) => {
        const aEng = normalizeText(a.nameEnglish);
        const bEng = normalizeText(b.nameEnglish);
        const aAra = normalizeArabic(a.nameArabic);
        const bAra = normalizeArabic(b.nameArabic);
        const stemToken = (t) => t.replace(/^(?:و|ف)?(?:ال)?/, "");
        const qTokens = (qEng + " " + qAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aTokens = (aEng + " " + aAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const bTokens = (bEng + " " + bAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aCount = qTokens.filter((t) => aTokens.some((at) => at === t || at.includes(t) || t.includes(at))).length;
        const bCount = qTokens.filter((t) => bTokens.some((bt) => bt === t || bt.includes(t) || t.includes(bt))).length;
        if (aCount !== bCount) {
          return bCount - aCount;
        }
        return b.nameEnglish.length - a.nameEnglish.length;
      });
      finalResults.push(...sortedExact);
    } else if (partialMatches.length > 0) {
      const sortedPartials = partialMatches.sort((a, b) => {
        const aEng = normalizeText(a.nameEnglish);
        const bEng = normalizeText(b.nameEnglish);
        const aAra = normalizeArabic(a.nameArabic);
        const bAra = normalizeArabic(b.nameArabic);
        const qAction = /insertion|تركيب|بذل|drainage/i.test(qEng + " " + qAra) ? "insert" : /removal|رفع|استخراج|ازالة/i.test(qEng + " " + qAra) ? "remove" : null;
        if (qAction === "insert") {
          const aHas = /insertion|تركيب|بذل|drainage/i.test(aEng + " " + aAra);
          const bHas = /insertion|تركيب|بذل|drainage/i.test(bEng + " " + bAra);
          if (aHas && !bHas) return -1;
          if (!aHas && bHas) return 1;
        } else if (qAction === "remove") {
          const aHas = /removal|رفع|استخراج|ازالة/i.test(aEng + " " + aAra);
          const bHas = /removal|رفع|استخراج|ازالة/i.test(bEng + " " + bAra);
          if (aHas && !bHas) return -1;
          if (!aHas && bHas) return 1;
        }
        const stemToken = (t) => t.replace(/^(?:و|ف)?(?:ال)?/, "");
        const qTokens = (qEng + " " + qAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aTokens = (aEng + " " + aAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const bTokens = (bEng + " " + bAra).split(/\s+/).map(stemToken).filter((t) => t.length >= 3);
        const aCount = qTokens.filter((t) => aTokens.some((at) => at === t || at.includes(t) || t.includes(at))).length;
        const bCount = qTokens.filter((t) => bTokens.some((bt) => bt === t || bt.includes(t) || t.includes(bt))).length;
        if (aCount !== bCount) {
          return bCount - aCount;
        }
        const aStarts = qEng && aEng.startsWith(qEng);
        const bStarts = qEng && bEng.startsWith(qEng);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.nameEnglish.length - b.nameEnglish.length;
      });
      finalResults.push(...sortedPartials.slice(0, 5));
    }
  }
  return finalResults;
}

// src/lib/draftReplyBuilder.ts
function buildDraftReplyText(priceListYear, contractor, officer, matchedProcedures) {
  const procedures = matchedProcedures || [];
  const matchedLines = procedures.filter((p) => p.status === "matched").map((p, idx) => `${idx + 1}- ${p.matchedName || p.serviceName}`).join("\n");
  const unmatchedLines = procedures.filter((p) => p.status === "unmatched").map(
    (p) => ` - ${p.serviceName}${p.suggestedPrice && p.suggestedPrice > 0 ? ` : \u0645\u0637\u0644\u0648\u0628 \u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629 \u0628\u0645\u0628\u0644\u063A ${Number(p.suggestedPrice).toLocaleString("en-US")} \u062C.\u0645` : ""}`
  ).join("\n");
  const contractorDisplay = contractor && contractor.trim() ? contractor.trim() : "\u0627\u0644\u062A\u0639\u0627\u0642\u062F";
  const displayYear = priceListYear === "Cash" || /كاش|cash|خصم نادي|خصم نادى/i.test(contractorDisplay) ? "2026" : priceListYear || "2026";
  const officerDisplay = officer && officer.trim() && officer !== "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F" && !officer.includes("\u064A\u062A\u0637\u0644\u0628 \u062A\u062D\u062F\u064A\u062F") ? officer.trim() : "\u0645\u0633\u0626\u0648\u0644 \u0627\u0644\u0633\u064A\u0644\u0632 \u0627\u0644\u0645\u062E\u062A\u0635";
  let text = `Price list: Elite Hospital ${displayYear}
Contractor: ${contractorDisplay}
\u0627\u0644\u0645\u0633\u0626\u0648\u0644 \u0645\u0646 \u0642\u0633\u0645 \u0627\u0644\u0633\u064A\u0644\u0632: ${officerDisplay}
Corporate Email: corporate@elitehospital.org
 
\u0627\u0644\u0625\u062C\u0631\u0627\u0621\u0627\u062A \u0627\u0644\u0645\u062A\u0648\u0627\u062C\u062F\u0629 \u0628\u0644\u0627\u0626\u062D\u0629 \u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0639\u0627\u0642\u062F:
${matchedLines || "\u0644\u0627 \u062A\u0648\u062C\u062F \u0625\u062C\u0631\u0627\u0621\u0627\u062A \u0645\u0637\u0627\u0628\u0642\u0629 \u0645\u0628\u0627\u0634\u0631\u0629 \u0628\u0627\u0644\u0644\u0627\u0626\u062D\u0629"}`;
  if (unmatchedLines) {
    text += `

[\u26A0\uFE0F  \u0627\u0644\u0625\u062C\u0631\u0627\u0621\u0627\u062A \u0627\u0644\u062A\u0627\u0644\u064A\u0629 \u063A\u064A\u0631 \u0645\u062F\u0631\u062C\u0629 \u0641\u064A \u0644\u0627\u0626\u062D\u0629 \u0623\u0633\u0639\u0627\u0631 \u0627\u0644\u062A\u0639\u0627\u0642\u062F (\u0645\u0637\u0644\u0648\u0628 \u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629):
${unmatchedLines}]`;
  }
  text += `

@corporate@elitehospital.org`;
  return text;
}

// src/mail/syncEngine.ts
var client3 = supabaseAdmin || supabase;
async function getExistingApprovalByConversation(conversationId) {
  if (!client3 || !conversationId) return null;
  try {
    const { data, error } = await client3.from("inpatient_approvals").select("*").eq("conversation_id", conversationId).maybeSingle();
    if (error) {
      console.warn(`[Sync Engine] Error checking conversation existence:`, error.message);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
async function isMessageAlreadyIngested(messageId) {
  if (!client3) return false;
  try {
    const { data, error } = await client3.from("inpatient_approvals").select("id").eq("exchange_message_id", messageId).maybeSingle();
    if (error) {
      console.warn(`[Sync Engine] Error checking message existence:`, error.message);
      return false;
    }
    return Boolean(data);
  } catch {
    return false;
  }
}
function matchServicesAgainstPricelist(services, year = "2025") {
  const targetYear = ["2023", "2024", "2025", "2026"].includes(year) ? year : "2025";
  let catalog = [];
  try {
    const filePath = path3.resolve(process.cwd(), "public", `${targetYear}_cash.json`);
    if (fs2.existsSync(filePath)) {
      catalog = JSON.parse(fs2.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.warn(`[Sync Engine] Failed to load catalog for ${targetYear}:`, err);
  }
  return services.map((srv) => {
    const localMatches = searchLocalPricelist(catalog, [{ name: srv.name }]);
    if (localMatches.length > 0) {
      const best = localMatches[0];
      return {
        serviceName: srv.name,
        matchedName: best.nameEnglish || best.nameArabic,
        code: best.code,
        status: "matched",
        suggestedPrice: Number(best.price) || void 0
      };
    }
    const cleanSrv = cleanHisProcedureQuery(srv.name);
    const normSrv = normalizeArabic(normalizeText(cleanSrv || srv.name));
    let bestMatch = null;
    let maxScore = 0;
    for (const item of catalog) {
      const normAr = normalizeArabic(normalizeText(item.nameArabic || ""));
      const normEn = normalizeText(item.nameEnglish || "").toLowerCase();
      if (normAr && (normSrv.includes(normAr) || normAr.includes(normSrv))) {
        const score = normAr.length / Math.max(normAr.length, normSrv.length);
        if (score > maxScore) {
          maxScore = score;
          bestMatch = item;
        }
      } else if (normEn && (normSrv.includes(normEn) || normEn.includes(normSrv))) {
        const score = Math.min(normEn.length, normSrv.length) / Math.max(normEn.length, normSrv.length);
        if (score > maxScore) {
          maxScore = score;
          bestMatch = item;
        }
      }
    }
    if (bestMatch && maxScore >= 0.5) {
      return {
        serviceName: srv.name,
        matchedName: bestMatch.nameArabic || bestMatch.nameEnglish,
        code: bestMatch.code,
        status: "matched",
        suggestedPrice: Number(bestMatch.price) || void 0
      };
    }
    return {
      serviceName: srv.name,
      matchedName: "\u063A\u064A\u0631 \u0645\u062F\u0631\u062C \u0628\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0623\u0633\u0639\u0627\u0631",
      status: "unmatched"
    };
  });
}
async function runMailSync(options) {
  const startTime = Date.now();
  const folderName = options?.folderName || process.env.EWS_FOLDER || "InApprovals";
  const batchLimit = options?.batchLimit || 50;
  const stats = {
    success: false,
    messagesFetched: 0,
    messagesProcessed: 0,
    messagesSkipped: 0,
    attachmentsSaved: 0,
    durationMs: 0
  };
  try {
    const ewsSource = new EwsSource({ folderName });
    const conn = await ewsSource.testConnection();
    if (!conn.ok) {
      stats.error = conn.message;
      console.error(`[Sync Engine] \u274C EWS Connection failed: ${conn.message}`);
      stats.durationMs = Date.now() - startTime;
      return stats;
    }
    const currentCursor = await loadCursorFromPostgres(folderName);
    console.log(`[Sync Engine] \u{1F4E5} Fetching incremental approvals for "${folderName}" (Token: ${currentCursor.token ? "Active" : "Initial"})...`);
    const { messages, nextCursor } = await ewsSource.fetchSince(currentCursor, batchLimit);
    stats.messagesFetched = messages.length;
    stats.nextCursorToken = nextCursor.token;
    console.log(`[Sync Engine] \u{1F4E8} Retrieved ${messages.length} messages from Exchange.`);
    for (const msg of messages) {
      const convId = msg.conversationId || msg.messageId;
      const existing = await getExistingApprovalByConversation(convId);
      const parsed = parseHisApprovalEmail(msg);
      if (existing) {
        const earliestReceivedAt = new Date(msg.receivedAt) < new Date(existing.received_at) ? msg.receivedAt : existing.received_at;
        let updatedStatus = existing.status;
        let hasApproval = existing.has_existing_approval || parsed.hasExistingApproval;
        let isRefused = existing.is_refused || parsed.isRefused;
        if (parsed.isRefused) {
          updatedStatus = "refused";
          isRefused = true;
          hasApproval = false;
        } else if (parsed.hasExistingApproval) {
          updatedStatus = "answered";
          hasApproval = true;
          isRefused = false;
        }
        const updatedApprovedLimit = parsed.financialTerms?.approvedAmountLimit && parsed.financialTerms.approvedAmountLimit > 0 ? parsed.financialTerms.approvedAmountLimit : existing.financial_terms?.approvedAmountLimit && existing.financial_terms.approvedAmountLimit > 0 ? existing.financial_terms.approvedAmountLimit : -1;
        const updatedCreditLimitText = updatedApprovedLimit > 0 ? `${updatedApprovedLimit.toLocaleString()} EGP` : existing.financial_terms?.creditLimitText || null;
        let updatedReplyText = parsed.cleanReplyBody || parsed.statusReasonArabic || (existing.status_reason_arabic && !existing.status_reason_arabic.includes("<div") && !existing.status_reason_arabic.includes("<html>") ? existing.status_reason_arabic : "") || existing.financial_terms?.coverageConditions || "";
        if (updatedReplyText.includes("<") && updatedReplyText.includes(">")) {
          updatedReplyText = extractCleanReplyBody(updatedReplyText) || cleanTextFromHtml(updatedReplyText);
        }
        const updatedFinancialTerms = {
          patientSharePercentage: parsed.financialTerms?.patientSharePercentage ?? existing.financial_terms?.patientSharePercentage ?? -1,
          approvedAmountLimit: updatedApprovedLimit,
          creditLimitText: updatedCreditLimitText,
          coverageConditions: updatedReplyText
        };
        const patientName = existing.patient_name && existing.patient_name !== "\u063A\u064A\u0631 \u0645\u0633\u062C\u0644" ? existing.patient_name : parsed.patientName;
        const mrn = existing.mrn && existing.mrn !== "000000" ? existing.mrn : parsed.mrn;
        const bed = existing.bed || parsed.bed;
        const admissionType = existing.admission_type || parsed.admissionType;
        const physician = existing.physician || parsed.physician;
        const contractorRaw = existing.contractor_raw || parsed.contractorRaw;
        const contractorNormalized2 = existing.contractor_normalized || parsed.contractorNormalized;
        const contractorOfficer2 = existing.contractor_officer || resolveOfficerByContractor(contractorRaw).officerName;
        const priceListYear2 = existing.price_list_year || "2025";
        const diagnosis = existing.diagnosis && existing.diagnosis !== "Clinical Inpatient Evaluation" ? existing.diagnosis : parsed.diagnosis;
        const requestedServices = existing.requested_services?.length > 0 ? existing.requested_services : parsed.requestedServices;
        const matchedProcedures2 = existing.matched_procedures?.length > 0 ? existing.matched_procedures : matchServicesAgainstPricelist(requestedServices, priceListYear2);
        const cmWhatsappMessage2 = generateCmWhatsappMessage({
          patientName,
          bed: bed || "",
          contractorNormalized: contractorNormalized2,
          contractorRaw,
          requestedServices,
          matchedProcedures: matchedProcedures2,
          diagnosis,
          status: updatedStatus,
          hasExistingApproval: hasApproval,
          isRefused,
          approvedAmountLimit: updatedApprovedLimit > 0 ? updatedApprovedLimit : void 0,
          patientSharePercentage: updatedFinancialTerms.patientSharePercentage > 0 ? updatedFinancialTerms.patientSharePercentage : void 0,
          coverageConditions: updatedReplyText
        });
        const draftBody2 = buildDraftReplyText(
          priceListYear2,
          contractorNormalized2,
          contractorOfficer2,
          matchedProcedures2
        );
        const latestReplyAt = new Date(msg.receivedAt) > new Date(existing.state_timestamps?.latest_reply_at || existing.received_at) ? msg.receivedAt : existing.state_timestamps?.latest_reply_at;
        const { error: updateError } = await client3.from("inpatient_approvals").update({
          received_at: earliestReceivedAt,
          patient_name: patientName,
          mrn,
          bed,
          admission_type: admissionType,
          physician,
          contractor_raw: contractorRaw,
          contractor_normalized: contractorNormalized2,
          contractor_officer: contractorOfficer2,
          diagnosis,
          requested_services: requestedServices,
          matched_procedures: matchedProcedures2,
          status: updatedStatus,
          has_replies: true,
          has_existing_approval: hasApproval,
          is_refused: isRefused,
          financial_terms: updatedFinancialTerms,
          status_reason_arabic: updatedReplyText,
          cm_whatsapp_message: cmWhatsappMessage2,
          suggested_draft_reply: draftBody2,
          state_timestamps: {
            ...existing.state_timestamps,
            received_at: earliestReceivedAt,
            latest_reply_at: latestReplyAt,
            updated_at: (/* @__PURE__ */ new Date()).toISOString()
          },
          updated_at: (/* @__PURE__ */ new Date()).toISOString()
        }).eq("id", existing.id);
        if (updateError) {
          console.error(`[Sync Engine] Failed to update approval ${existing.id}:`, updateError.message);
        } else {
          stats.messagesProcessed++;
          await mirrorApprovalToFirestore({
            id: existing.id,
            conversationId: existing.conversation_id,
            messageId: msg.messageId,
            receivedAt: earliestReceivedAt,
            patientName,
            mrn,
            bed,
            admissionType,
            physician,
            contractorRaw,
            contractorNormalized: contractorNormalized2,
            contractorOfficer: contractorOfficer2,
            priceListYear: priceListYear2,
            diagnosis,
            requestedServices,
            matchedProcedures: matchedProcedures2,
            status: updatedStatus,
            hasReplies: true,
            hasExistingApproval: hasApproval,
            isRefused,
            financialTerms: updatedFinancialTerms,
            statusReasonArabic: updatedReplyText,
            cmWhatsappMessage: cmWhatsappMessage2,
            draftBody: draftBody2,
            suggestedDraftReply: draftBody2,
            draftedAt: existing.state_timestamps?.drafted_at || (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        continue;
      }
      const alreadyIngested = await isMessageAlreadyIngested(msg.messageId);
      if (alreadyIngested) {
        stats.messagesSkipped++;
        continue;
      }
      const officerMatch = resolveOfficerByContractor(parsed.contractorRaw);
      const contractorNormalized = officerMatch.contractorNormalized || cleanContractorName(parsed.contractorRaw);
      const contractorOfficer = officerMatch.officerName || "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F (\u064A\u062A\u0637\u0644\u0628 \u062A\u062D\u062F\u064A\u062F \u0645\u0646\u0633\u0642 \u0627\u0644\u0633\u064A\u0644\u0632)";
      const priceListYear = "2025";
      const matchedProcedures = matchServicesAgainstPricelist(parsed.requestedServices, priceListYear);
      let initialStatus = "received";
      if (parsed.isRefused) {
        initialStatus = "refused";
      } else if (parsed.hasExistingApproval) {
        initialStatus = "answered";
      } else if (matchedProcedures.some((p) => p.status === "matched")) {
        initialStatus = "matched";
      } else {
        initialStatus = "needs_review";
      }
      const processedAttachments = [];
      if (parsed.attachments && parsed.attachments.length > 0) {
        for (const att of parsed.attachments) {
          if (att.contentBase64) {
            const buffer = Buffer.from(att.contentBase64, "base64");
            const uploaded = await uploadAttachmentToStorage(msg.id, att, buffer);
            processedAttachments.push(uploaded);
            stats.attachmentsSaved++;
          } else {
            processedAttachments.push(att);
          }
        }
      }
      const draftBody = buildDraftReplyText(
        priceListYear,
        contractorNormalized,
        contractorOfficer,
        matchedProcedures
      );
      const cmWhatsappMessage = generateCmWhatsappMessage({
        patientName: parsed.patientName,
        bed: parsed.bed || "",
        contractorNormalized,
        contractorRaw: parsed.contractorRaw,
        requestedServices: parsed.requestedServices,
        matchedProcedures,
        diagnosis: parsed.diagnosis,
        status: initialStatus,
        hasExistingApproval: parsed.hasExistingApproval,
        isRefused: parsed.isRefused,
        approvedAmountLimit: parsed.financialTerms?.approvedAmountLimit,
        patientSharePercentage: parsed.financialTerms?.patientSharePercentage,
        coverageConditions: parsed.financialTerms?.coverageConditions || parsed.cleanReplyBody
      });
      const deterministicId = toDeterministicUuid(convId);
      const record = {
        id: deterministicId,
        conversationId: convId,
        messageId: msg.messageId,
        receivedAt: msg.receivedAt,
        // Timing of the approval mail itself!
        patientName: parsed.patientName,
        mrn: parsed.mrn,
        bed: parsed.bed,
        admissionType: parsed.admissionType,
        physician: parsed.physician,
        contractorRaw: parsed.contractorRaw,
        contractorNormalized,
        contractorOfficer,
        priceListYear,
        diagnosis: parsed.diagnosis,
        requestedServices: parsed.requestedServices,
        matchedProcedures,
        status: initialStatus,
        statusReasonArabic: parsed.isReplyMessage ? parsed.statusReasonArabic || parsed.cleanReplyBody : void 0,
        draftBody,
        suggestedDraftReply: draftBody,
        cmWhatsappMessage,
        draftedAt: (/* @__PURE__ */ new Date()).toISOString(),
        hasReplies: parsed.hasReplies,
        hasExistingApproval: parsed.hasExistingApproval,
        isRefused: parsed.isRefused,
        approvedAmountLimit: parsed.financialTerms?.approvedAmountLimit,
        patientSharePercentage: parsed.financialTerms?.patientSharePercentage,
        coverageConditions: parsed.financialTerms?.coverageConditions || parsed.cleanReplyBody
      };
      const persistRes = await persistApprovalToPostgres(record);
      if (persistRes.success) {
        stats.messagesProcessed++;
        await mirrorApprovalToFirestore(record);
      } else {
        console.warn(`[Sync Engine] Failed to persist approval ${msg.messageId}:`, persistRes.error);
      }
    }
    await saveCursorToPostgres(nextCursor, stats.messagesProcessed);
    if (!options?.skipPurge) {
      await triggerPhiRetentionPurge(30);
    }
    stats.success = true;
  } catch (err) {
    stats.error = err.message || String(err);
    console.error("[Sync Engine] \u274C Sync run encountered fatal error:", err);
  } finally {
    stats.durationMs = Date.now() - startTime;
  }
  return stats;
}

// src/mail/syncEndpoint.ts
function isAuthorizedRequest(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== "string") return false;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (process.env.INTERNAL_API_SECRET && token === process.env.INTERNAL_API_SECRET) return true;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
  const parts = token.split(".");
  if (parts.length === 3 && parts[0].length > 10) return true;
  return false;
}
async function handler(req, res) {
  const origin = req.headers?.origin;
  if (origin && (origin.includes("elitehospital.org") || origin.includes("localhost") || origin.includes("vercel.app"))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: "Unauthorized: Valid Bearer token or CRON_SECRET required." });
  }
  console.log(`[EWS Sync] Starting mail synchronization trigger...`);
  try {
    const stats = await runMailSync({
      folderName: process.env.EWS_FOLDER || "InApprovals",
      batchLimit: 50
    });
    console.log(`[EWS Sync] Complete: success=${stats.success} fetched=${stats.messagesFetched} processed=${stats.messagesProcessed} skipped=${stats.messagesSkipped} duration=${stats.durationMs}ms`);
    return res.status(200).json({
      success: stats.success,
      messagesFetched: stats.messagesFetched,
      messagesProcessed: stats.messagesProcessed,
      messagesSkipped: stats.messagesSkipped,
      attachmentsSaved: stats.attachmentsSaved,
      durationMs: stats.durationMs,
      error: stats.error,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
  } catch (err) {
    console.error(`[EWS Sync] Error during sync:`, err);
    return res.status(500).json({
      success: false,
      error: err.message || String(err)
    });
  }
}
export {
  handler as default
};
