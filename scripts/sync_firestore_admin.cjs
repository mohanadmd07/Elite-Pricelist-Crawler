const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: '.env.local' });
dotenv.config();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

// Read Firebase token from configstore
const cfgPath = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Missing firebase-tools.json credentials');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const token = cfg.tokens?.access_token;
if (!token) {
  console.error('No access_token found in firebase-tools.json');
  process.exit(1);
}

const projectId = 'ai-studio-applet-webapp-f4da3';
const dbId = 'ai-studio-30af8d7a-885b-455a-bd3a-4af97e61494e';
const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${dbId}/documents/inpatient_approvals`;

async function fetchFromSupabase() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/inpatient_approvals?select=*&order=received_at.desc`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch from Supabase: ${res.statusText}`);
  }
  return await res.json();
}

async function listAllFirestoreDocs() {
  let allDocs = [];
  let pageToken = null;
  do {
    const url = `${baseUrl}?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to list Firestore docs: ${res.status} ${err}`);
    }
    const data = await res.json();
    if (data.documents && data.documents.length > 0) {
      allDocs = allDocs.concat(data.documents);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return allDocs;
}

async function deleteFirestoreDoc(docName) {
  const url = `https://firestore.googleapis.com/v1/${docName}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.ok;
}

// Convert JS value to Firestore REST API Value format
function toFirestoreValue(val) {
  if (val === null || val === undefined) {
    return { nullValue: null };
  }
  if (typeof val === 'boolean') {
    return { booleanValue: val };
  }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') {
    // Check if ISO timestamp
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
      try {
        const d = new Date(val);
        if (!isNaN(d.getTime())) {
          return { timestampValue: d.toISOString() };
        }
      } catch {}
    }
    return { stringValue: val };
  }
  if (Array.isArray(val)) {
    return {
      arrayValue: {
        values: val.map(toFirestoreValue),
      },
    };
  }
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return {
      mapValue: { fields },
    };
  }
  return { stringValue: String(val) };
}

async function upsertFirestoreDoc(id, record) {
  const docUrl = `${baseUrl}/${id}`;
  const fields = {
    id: toFirestoreValue(record.id),
    exchangeMessageId: toFirestoreValue(record.exchange_message_id),
    contentHash: toFirestoreValue(record.content_hash),
    conversationId: toFirestoreValue(record.conversation_id),
    receivedAt: toFirestoreValue(record.received_at),
    patientName: toFirestoreValue(record.patient_name),
    mrn: toFirestoreValue(record.mrn),
    bed: toFirestoreValue(record.bed),
    admissionType: toFirestoreValue(record.admission_type),
    physician: toFirestoreValue(record.physician),
    contractorRaw: toFirestoreValue(record.contractor_raw),
    contractorNormalized: toFirestoreValue(record.contractor_normalized),
    contractorOfficer: toFirestoreValue(record.contractor_officer),
    priceListYear: toFirestoreValue(record.price_list_year),
    diagnosis: toFirestoreValue(record.diagnosis),
    requestedServices: toFirestoreValue(record.requested_services),
    matchedProcedures: toFirestoreValue(record.matched_procedures),
    financialTerms: toFirestoreValue(record.financial_terms),
    status: toFirestoreValue(record.status),
    statusReasonArabic: toFirestoreValue(record.status_reason_arabic),
    stateTimestamps: toFirestoreValue(record.state_timestamps),
    suggestedDraftReply: toFirestoreValue(record.suggested_draft_reply),
    draftBody: toFirestoreValue(record.suggested_draft_reply),
    cmWhatsappMessage: toFirestoreValue(record.cm_whatsapp_message),
    hasReplies: toFirestoreValue(record.has_replies),
    hasExistingApproval: toFirestoreValue(record.has_existing_approval),
    isRefused: toFirestoreValue(record.is_refused),
    updatedAt: toFirestoreValue(record.updated_at),
  };

  const res = await fetch(docUrl, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to upsert doc ${id}: ${res.status} ${err}`);
  }
}

async function main() {
  console.log('Fetching authoritative records from Supabase...');
  const supabaseRecords = await fetchFromSupabase();
  console.log(`Found ${supabaseRecords.length} canonical records in Supabase.`);

  const canonicalIds = new Set(supabaseRecords.map(r => r.id));

  console.log('Listing current Firestore documents...');
  const firestoreDocs = await listAllFirestoreDocs();
  console.log(`Found ${firestoreDocs.length} documents in Firestore.`);

  let deletedCount = 0;
  for (const doc of firestoreDocs) {
    const docId = doc.name.split('/').pop();
    if (!canonicalIds.has(docId)) {
      process.stdout.write(`Pruning stale doc: ${docId}... `);
      const ok = await deleteFirestoreDoc(doc.name);
      console.log(ok ? 'Deleted' : 'Failed');
      if (ok) deletedCount++;
    }
  }

  console.log(`Pruned ${deletedCount} stale/duplicate documents from Firestore.`);

  console.log('Upserting all canonical records into Firestore...');
  let upsertedCount = 0;
  for (const record of supabaseRecords) {
    await upsertFirestoreDoc(record.id, record);
    upsertedCount++;
  }
  console.log(`Successfully upserted ${upsertedCount} canonical records into Firestore.`);

  // Verify final count
  const finalDocs = await listAllFirestoreDocs();
  console.log(`🎉 Final Firestore inpatient_approvals document count: ${finalDocs.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
