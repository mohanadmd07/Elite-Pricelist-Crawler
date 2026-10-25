// src/mail/syncEngine.ts
import fs2 from "fs";
import path3 from "path";

// src/mail/adapters/EwsSource.ts
import httpntlm from "httpntlm";
var EXACT_INAPPROVALS_FOLDER_ID = "AAMkAGU5Y2EzNmMxLTIwZDItNDcxOC05ZTk0LTBlODJjZjkxOGU5NgAuAAAAAAA4U9epEFcNRbR5QhtWJDZyAQCVKjW+UMYOTr9U/HR/zy7WAAActvclAAA=";
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
};

// src/mail/parser/hisApprovalParser.ts
import * as cheerio from "cheerio";

// src/lib/arabic-normalizer.ts
function normalizeArabic(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 15)).replace(/[أإآا]/g, "\u0627").replace(/[ىيی]/g, "\u064A").replace(/[كک]/g, "\u0643").replace(/[ةهھۀ]/g, "\u0647").replace(/[ئؤ]/g, "\u0621").replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, " ").replace(/\s+/g, " ").trim();
}
function normalizeText(str) {
  if (!str) return "";
  let normalized = str.toLowerCase();
  normalized = normalized.replace(/\b([a-z])\s*\.\s*/g, "$1");
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

// src/mail/parser/hisApprovalParser.ts
var REFUSAL_KEYWORDS = [
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0649",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0647",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u0627\u0629",
  "\u063A\u064A\u0631 \u0645\u063A\u0637\u064A",
  "\u0645\u0631\u0641\u0648\u0636",
  "\u0631\u0641\u0636",
  "\u063A\u064A\u0631 \u0645\u0639\u062A\u0645\u062F",
  "not approved",
  "rejected",
  "\u0646\u0639\u062A\u0630\u0631 \u0639\u0646 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u0646\u0639\u062A\u0630\u0631 \u0639\u0646 \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0629",
  "\u062E\u0627\u0631\u062C \u0627\u0644\u062A\u063A\u0637\u064A\u0647"
];
var APPROVAL_KEYWORDS = [
  "\u0644\u0627 \u0645\u0627\u0646\u0639",
  "approved",
  "approve",
  "\u0645\u0639\u062A\u0645\u062F",
  "\u0645\u0648\u0627\u0641\u0642\u0629 \u0633\u0639\u0631\u064A\u0629",
  "\u0645\u0648\u0627\u0641\u0642\u0647 \u0633\u0639\u0631\u064A\u0647",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629",
  "\u062A\u0645\u062A \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0647",
  "\u0645\u0648\u0627\u0641\u0642\u0629 \u0628\u0627\u0644\u0644\u0627\u0626\u062D\u0629",
  "\u0645\u0648\u0627\u0641\u0642\u0647 \u0628\u0627\u0644\u0644\u0627\u0626\u062D\u0647",
  "\u064A\u0636\u0627\u0641 \u0639\u0644\u064A \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0647",
  "\u064A\u0636\u0627\u0641 \u0639\u0644\u0649 \u0627\u0644\u0641\u0627\u062A\u0648\u0631\u0629",
  "\u0628\u0641\u0627\u062A\u0648\u0631\u0647 \u0627\u0644\u0634\u0631\u0627\u0621",
  "\u0628\u0641\u0627\u062A\u0648\u0631\u0629 \u0627\u0644\u0634\u0631\u0627\u0621",
  "\u0645\u0648\u0627\u0641\u0642",
  "\u062A\u0633\u0639\u064A\u0631\u0629 \u0633\u0639\u0631\u064A\u0629",
  "\u062A\u0633\u0639\u064A\u0631\u0647 \u0633\u0639\u0631\u064A\u0647",
  "\u062A\u0633\u0639\u064A\u0631\u0629",
  "\u062A\u0633\u0639\u064A\u0631\u0647"
];
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/");
}
function cleanTextFromHtml(input) {
  if (!input) return "";
  return input.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function extractCreditLimit(text) {
  if (!text) return {};
  const normalized = text.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e]/g, " ");
  const pattern = /(?:الحد\s+ال[اأإآ]قص[ىي]|بحد\s+[اأإآ]قص[ىي]|سقف\s+الموافق[ةه]|بمبلغ\s+لا\s+يتجاوز|في\s+حدود|موافق[ةه](?:\s+سعري[ةه])?\s+بمبلغ|معتمد\s+بمبلغ|لا\s+مانع(?:[^\d\n\r]{0,30})بمبلغ|تحصيل\s+مبلغ|مبلغ\s+(?:ت[اأإآ]مين\s+)?)(?:[^\d\n\r]{0,25})(\d+(?:[\.,]\d+)?)\s*(الف|ألف|الاف|آلاف|k)?/i;
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
function detectRefusal(text, subject) {
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
      const end = Math.min(combined.length, idx + kw.length + 80);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < combined.length) snippet = snippet + "...";
      return { hasRefusal: true, snippet };
    }
  }
  return { hasRefusal: false, snippet: "" };
}
function detectExistingApproval(text, subject) {
  const normText = (text || "").normalize("NFKC");
  const normSubj = (subject || "").normalize("NFKC");
  const refusalCheck = detectRefusal(normText, normSubj);
  if (refusalCheck.hasRefusal) {
    return { hasApproval: false, snippet: "" };
  }
  const cleanBody = cleanTextFromHtml(normText);
  const cleanSubj = cleanTextFromHtml(normSubj);
  const combined = `${cleanSubj} ${cleanBody}`.trim();
  const normalized = combined.toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
  const credit = extractCreditLimit(combined);
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
  const attachedIdx = approvalSearchText.search(/مرفق\s+(?:تقرير\s+)?(?:ال)?موافق/);
  if (attachedIdx !== -1) {
    const start = Math.max(0, attachedIdx - 25);
    const end = Math.min(combined.length, attachedIdx + 80);
    let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
    if (start > 0) snippet = "..." + snippet;
    return { hasApproval: true, snippet, creditLimit: credit.limit, creditLimitText: credit.formatted };
  }
  for (const kw of APPROVAL_KEYWORDS) {
    const kwNorm = kw.normalize("NFKC").toLowerCase().replace(/[إأآ]/g, "\u0627").replace(/ة/g, "\u0647");
    const idx = kwNorm === "\u0645\u0648\u0627\u0641\u0642" ? approvalSearchText.search(/(?<![\u0600-\u06FF])موافق(?![\u0600-\u06FF])/) : approvalSearchText.indexOf(kwNorm);
    if (idx !== -1) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(combined.length, idx + kw.length + 80);
      let snippet = stripSentFromSignatures(combined.substring(start, end)).trim();
      if (start > 0) snippet = "..." + snippet;
      if (end < combined.length) snippet = snippet + "...";
      return {
        hasApproval: true,
        snippet,
        creditLimit: credit.limit,
        creditLimitText: credit.formatted
      };
    }
  }
  if (credit.limit && approvalSearchText === normalized) {
    return {
      hasApproval: true,
      snippet: stripSentFromSignatures(combined.substring(0, 120)).trim(),
      creditLimit: credit.limit,
      creditLimitText: credit.formatted
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
  const hasQuotedMarkers = /-----Original Message-----/i.test(rawContent) || /From:.*Sent:.*To:/is.test(rawContent) || /On\s+.+wrote:/i.test(rawContent) || /بتاريخ\s+.+كتب/i.test(rawContent);
  if (isReSubject || hasInReplyTo || hasReferences || hasQuotedMarkers) {
    let replySnippet = "";
    const cleanContent = cleanTextFromHtml(parsed.text || (parsed.html ? parsed.html : ""));
    const sentences = cleanContent.split(/[.\n\r]+/).map((s) => s.trim()).filter((s) => s.length > 4);
    for (const s of sentences) {
      if (!s.toLowerCase().includes("inpatient approval") && !s.toLowerCase().includes("patient information") && !s.toLowerCase().includes("selected services") && !s.toLowerCase().includes("from:") && !s.toLowerCase().includes("to:") && !s.toLowerCase().includes("sent:") && !s.toLowerCase().includes("subject:")) {
        replySnippet = stripSentFromSignatures(s).substring(0, 120);
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
        if (bedMatch) bed = bedMatch[1].trim();
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
      if (bMatch) bed = bMatch[1].trim();
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
  const refusal = detectRefusal(fullText, msg.subject);
  const approval = detectExistingApproval(fullText, msg.subject);
  const replies = detectReplies({
    subject: msg.subject,
    text: msg.textBody,
    html: msg.htmlBody
  });
  const credit = extractCreditLimit(fullText);
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
      patientSharePercentage: null,
      coverageConditions: approval.snippet || void 0
    },
    hasReplies: replies.hasReplies,
    hasExistingApproval: approval.hasApproval,
    isRefused: refusal.hasRefusal,
    statusReasonArabic: refusal.hasRefusal ? refusal.snippet : approval.hasApproval ? approval.snippet : void 0,
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
  const deliveryKey = record.messageId || record.exchangeItemId;
  const rawSeed = deliveryKey || record.conversationId || record.id || record.mrn;
  let uuid = toDeterministicUuid(rawSeed);
  if (deliveryKey) {
    try {
      const { data: existing } = await client2.from("inpatient_approvals").select("id").eq("exchange_message_id", deliveryKey).maybeSingle();
      if (existing?.id) {
        uuid = existing.id;
      }
    } catch {
    }
  }
  const contentHash = crypto2.createHash("sha256").update(
    `${record.conversationId || ""}|${record.messageId || ""}|${record.mrn || ""}|${record.receivedAt || ""}|${record.diagnosis || ""}`
  ).digest("hex");
  const mrnHash = crypto2.createHash("sha256").update(`salt_elite_approvals_${record.mrn || ""}`).digest("hex");
  const receivedIso = record.receivedAt && record.receivedAt.toDate ? record.receivedAt.toDate().toISOString() : typeof record.receivedAt === "string" ? record.receivedAt : (/* @__PURE__ */ new Date()).toISOString();
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
    status_reason_arabic: record.statusReasonArabic || null,
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

// src/mail/syncEngine.ts
var client3 = supabaseAdmin || supabase;
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
    const normSrv = normalizeArabic(normalizeText(srv.name));
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
      } else if (normEn && normSrv.toLowerCase().includes(normEn)) {
        const score = normEn.length / Math.max(normEn.length, normSrv.length);
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
      const alreadyIngested = await isMessageAlreadyIngested(msg.messageId);
      if (alreadyIngested) {
        stats.messagesSkipped++;
        continue;
      }
      const parsed = parseHisApprovalEmail(msg);
      const officerMatch = resolveOfficerByContractor(parsed.contractorRaw);
      const contractorNormalized = officerMatch.contractorNormalized || cleanContractorName(parsed.contractorRaw);
      const contractorOfficer = officerMatch.officerName || "\u063A\u064A\u0631 \u0645\u062D\u062F\u062F (\u064A\u062A\u0637\u0644\u0628 \u062A\u062D\u062F\u064A\u062F \u0645\u0646\u0633\u0642 \u0627\u0644\u0633\u064A\u0644\u0632)";
      const priceListYear = officerMatch.matched ? "2025" : "2025";
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
      const record = {
        id: msg.id,
        conversationId: msg.conversationId || msg.messageId,
        messageId: msg.messageId,
        receivedAt: msg.receivedAt,
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
        statusReasonArabic: parsed.statusReasonArabic,
        draftBody: "",
        draftedAt: (/* @__PURE__ */ new Date()).toISOString(),
        hasReplies: parsed.hasReplies,
        hasExistingApproval: parsed.hasExistingApproval,
        isRefused: parsed.isRefused,
        approvedAmountLimit: parsed.financialTerms?.approvedAmountLimit,
        patientSharePercentage: parsed.financialTerms?.patientSharePercentage,
        coverageConditions: parsed.financialTerms?.coverageConditions
      };
      const persistRes = await persistApprovalToPostgres(record);
      if (persistRes.success) {
        stats.messagesProcessed++;
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
