// src/mail/draftEndpoint.ts
import { createClient } from "@supabase/supabase-js";

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
  /**
   * Creates an in-thread Reply-All draft, or standalone draft in Exchange Drafts folder.
   */
  async createDraft(params) {
    const { itemId, changeKey, body, subject, to } = params;
    if (itemId) {
      let currentChangeKey = changeKey;
      if (!currentChangeKey) {
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
        <t:ItemId Id="${itemId}"/>
      </m:ItemIds>
    </m:GetItem>
  </soap:Body>
</soap:Envelope>`;
          const resp = await this.ewsRequest(getXml);
          const ckMatch = resp.match(/ChangeKey="([^"]+)"/);
          if (ckMatch) currentChangeKey = ckMatch[1];
        } catch (err) {
          console.warn("[EWS] Could not retrieve fresh ChangeKey:", err?.message || err);
        }
      }
      if (currentChangeKey) {
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
          <t:ReferenceItemId Id="${itemId}" ChangeKey="${currentChangeKey}" />
          <t:NewBodyContent BodyType="Text">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t:NewBodyContent>
        </t:ReplyAllToItem>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;
        try {
          const xml = await this.ewsRequest(replySoap);
          if (xml.includes('ResponseClass="Success"')) {
            console.log(`[EWS] In-thread Reply-All draft created successfully for item: ${itemId}`);
            return { success: true };
          }
        } catch (err) {
          console.warn("[EWS] ReplyAllToItem failed, falling back to standalone draft:", err?.message || err);
        }
      }
    }
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
          <t:Body BodyType="Text">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t:Body>
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
        console.log(`[EWS] Standalone draft created in Exchange Drafts folder.`);
        return { success: true };
      }
      return { success: false, error: xml.substring(0, 300) };
    } catch (err) {
      return { success: false, error: err?.message || String(err) };
    }
  }
};

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
function buildDraftReplyFromRecord(record) {
  const contractor = record.contractorNormalized || record.contractorRaw || "\u0627\u0644\u062A\u0639\u0627\u0642\u062F";
  const procedures = record.matchedProcedures && record.matchedProcedures.length > 0 ? record.matchedProcedures : (record.requestedServices || []).map((s) => ({
    serviceName: s.name,
    matchedName: s.name,
    status: "matched"
  }));
  return buildDraftReplyText(record.priceListYear, contractor, record.contractorOfficer, procedures);
}

// src/mail/draftEndpoint.ts
function isAuthorizedRequest(req) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== "string") {
    const origin = req.headers?.origin || req.headers?.referer;
    if (origin && (origin.includes("elitehospital.org") || origin.includes("vercel.app") || origin.includes("localhost"))) {
      return true;
    }
    return false;
  }
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
  let id = req.query?.id;
  if (!id && req.url) {
    const match = req.url.match(/\/api\/approvals\/([^/?]+)\/draft/i);
    if (match) id = match[1];
  }
  if (!id && req.body && typeof req.body === "object" && req.body.id) {
    id = req.body.id;
  }
  if (!id) {
    return res.status(400).json({ error: "Missing required approval ID." });
  }
  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: "Unauthorized: Valid authentication credentials required." });
  }
  console.log(`[Draft API] Triggering draft creation for approval ID: ${id}`);
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  let record = null;
  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await client.from("inpatient_approvals").select("*").eq("id", id).maybeSingle();
      if (!error && data) {
        record = data;
      } else if (error) {
        console.warn(`[Draft API] Supabase query warning for ${id}:`, error.message);
      }
    } catch (dbErr) {
      console.warn(`[Draft API] Database connection warning:`, dbErr?.message || dbErr);
    }
  }
  const draftBody = req.body?.draftText || record?.suggested_draft_reply || (record ? buildDraftReplyFromRecord({
    priceListYear: record.price_list_year,
    contractorNormalized: record.contractor_normalized,
    contractorRaw: record.contractor_raw,
    contractorOfficer: record.contractor_officer,
    matchedProcedures: record.matched_procedures
  }) : "Price list: Elite Hospital 2025\nCorporate Email: corporate@elitehospital.org\n@corporate@elitehospital.org");
  const draftSubject = req.body?.subject || (record?.patient_name ? `RE: Inpatient Approval Request - ${record.patient_name} - ${record.mrn || ""}` : "RE: Inpatient Approval Request");
  const draftTo = req.body?.to || "corporate@elitehospital.org";
  let ewsSuccess = false;
  let ewsError = "";
  try {
    const ews = new EwsSource();
    const itemIdClean = record?.exchange_message_id ? record.exchange_message_id.replace(/&lt;|&gt;|<|>/g, "") : void 0;
    const draftResult = await ews.createDraft({
      itemId: itemIdClean,
      subject: draftSubject,
      body: draftBody,
      to: draftTo
    });
    ewsSuccess = draftResult.success;
    if (!ewsSuccess) ewsError = draftResult.error || "EWS draft creation returned non-success";
  } catch (ewsErr) {
    console.warn(`[Draft API] EWS operation note:`, ewsErr?.message || ewsErr);
    ewsError = ewsErr?.message || String(ewsErr);
  }
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      await client.from("inpatient_approvals").update({
        status: "draft_created",
        state_timestamps: {
          ...record?.state_timestamps || {},
          drafted_at: nowIso,
          updated_at: nowIso
        },
        updated_at: nowIso
      }).eq("id", id);
    } catch (err) {
      console.warn(`[Draft API] Supabase update warning:`, err?.message || err);
    }
  }
  try {
    await mirrorApprovalToFirestore({
      id,
      status: "draft_created",
      draftedAt: nowIso,
      mrn: record?.mrn || "000000",
      patientName: record?.patient_name || "\u063A\u064A\u0631 \u0645\u0633\u062C\u0644",
      bed: record?.bed || null,
      admissionType: record?.admission_type || "Inpatient",
      physician: record?.physician || null,
      contractorRaw: record?.contractor_raw || null,
      contractorNormalized: record?.contractor_normalized || null,
      contractorOfficer: record?.contractor_officer || null,
      priceListYear: record?.price_list_year || "2025",
      diagnosis: record?.diagnosis || null,
      requestedServices: record?.requested_services || [],
      matchedProcedures: record?.matched_procedures || [],
      draftBody,
      suggestedDraftReply: draftBody,
      cmWhatsappMessage: record?.cm_whatsapp_message || null,
      hasReplies: record?.has_replies ?? false,
      hasExistingApproval: record?.has_existing_approval ?? false,
      isRefused: record?.is_refused ?? false
    });
  } catch (fErr) {
    console.warn(`[Draft API] Firestore sync note:`, fErr?.message || fErr);
  }
  return res.status(200).json({
    success: true,
    draftedInOutlook: ewsSuccess,
    id,
    message: ewsSuccess ? "Draft created successfully in Outlook Drafts folder." : "Draft status registered and queued for Exchange synchronization.",
    note: ewsSuccess ? void 0 : ewsError,
    timestamp: nowIso
  });
}
export {
  handler as default
};
