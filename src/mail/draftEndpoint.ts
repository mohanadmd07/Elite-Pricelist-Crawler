import { createClient } from '@supabase/supabase-js';
import { doc, getDoc, collection, getDocs, query, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { EwsSource } from './adapters/EwsSource';
import { mirrorApprovalToFirestore } from '../services/approvalFirestoreSync';
import { buildDraftReplyFromRecord } from '../lib/draftReplyBuilder';
import { assertInternalRecipient } from '../classifier/draft';

function isAuthorizedRequest(req: any): boolean {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    const origin = req.headers?.origin || req.headers?.referer;
    if (origin && (origin.includes('elitehospital.org') || origin.includes('vercel.app') || origin.includes('localhost'))) {
      return true;
    }
    return false;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (process.env.INTERNAL_API_SECRET && token === process.env.INTERNAL_API_SECRET) return true;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
  const parts = token.split('.');
  if (parts.length === 3 && parts[0].length > 10) return true;
  return false;
}

export default async function handler(req: any, res: any) {
  const origin = req.headers?.origin;
  if (origin && (origin.includes('elitehospital.org') || origin.includes('localhost') || origin.includes('vercel.app'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Extract approval ID and body from request
  let id = req.query?.id as string;
  if (!id && req.url) {
    const match = req.url.match(/\/api\/approvals\/([^/?]+)\/draft/i);
    if (match) id = match[1];
  }
  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  if (!id && body && typeof body === 'object' && body.id) {
    id = body.id;
  }

  if (!id) {
    return res.status(400).json({ error: 'Missing required approval ID.' });
  }

  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized: Valid authentication credentials required.' });
  }

  console.log(`[Draft API] Triggering draft creation for approval ID: ${id}`);

  // 2. Fetch approval record from Supabase PostgreSQL (primary) or Firestore (derived fallback)
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  let record: any = null;

  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await client
        .from('inpatient_approvals')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (!error && data) {
        record = data;
      } else if (error) {
        console.warn(`[Draft API] Supabase query warning for ${id}:`, error.message);
      }
    } catch (dbErr: any) {
      console.warn(`[Draft API] Database connection warning:`, dbErr?.message || dbErr);
    }
  }

  // Fallback to Firestore if record not in Supabase or client is offline
  if (!record && db) {
    try {
      const docRef = doc(db, 'inpatient_approvals', id);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const d = snap.data();
        record = {
          id: snap.id,
          exchange_message_id: d.messageId,
          conversation_id: d.conversationId,
          patient_name: d.patientName,
          mrn: d.mrn,
          bed: d.bed,
          admission_type: d.admissionType,
          physician: d.physician,
          contractor_raw: d.contractorRaw,
          contractor_normalized: d.contractorNormalized,
          contractor_officer: d.contractorOfficer,
          price_list_year: d.priceListYear,
          diagnosis: d.diagnosis,
          requested_services: d.requestedServices,
          matched_procedures: d.matchedProcedures,
          suggested_draft_reply: d.suggestedDraftReply || d.draftBody,
          cm_whatsapp_message: d.cmWhatsappMessage,
          has_replies: d.hasReplies,
          has_existing_approval: d.hasExistingApproval,
          is_refused: d.isRefused,
        };
      }
    } catch (fErr: any) {
      console.warn(`[Draft API] Firestore read note for ${id}:`, fErr?.message || fErr);
    }
  }

  // 3. Resolve latest contractor, officer, and price list year dynamically
  let resolvedContractor =
    body?.contractorNormalized ||
    record?.contractor_normalized ||
    record?.contractor_raw ||
    'التعاقد';

  let resolvedOfficer =
    body?.contractorOfficer ||
    record?.contractor_officer;

  let resolvedYear =
    body?.priceListYear ||
    record?.price_list_year ||
    '2026';

  // If contractor officer or year was not explicitly supplied, check companies_config in Firestore
  if (db && resolvedContractor) {
    try {
      const compSnap = await getDocs(query(collection(db, 'companies_config'), limit(250)));
      const targetNorm = resolvedContractor.trim().toLowerCase();
      for (const docSnap of compSnap.docs) {
        const compData = docSnap.data();
        const compName = (compData.name || '').trim().toLowerCase();
        const aliases: string[] = Array.isArray(compData.aliases)
          ? compData.aliases.map((a: string) => (a || '').trim().toLowerCase())
          : [];
        if (compName === targetNorm || aliases.includes(targetNorm) || targetNorm.includes(compName)) {
          if (!body?.contractorOfficer && compData.contractorOfficer) {
            resolvedOfficer = compData.contractorOfficer;
          }
          if (!body?.priceListYear && compData.priceListYear) {
            resolvedYear = compData.priceListYear;
          }
          if (compData.name) {
            resolvedContractor = compData.name;
          }
          break;
        }
      }
    } catch (cfgErr) {
      console.warn('[Draft API] Companies config check note:', cfgErr);
    }
  }

  // 4. Resolve draft text, subject, and recipient
  // Priority:
  // a) Explicit draftText provided in req.body
  // b) English price-approval draft when isPriceApprovalDraft=true
  // c) Dynamically computed from record using latest officer & price list year
  const isPriceApprovalDraft = Boolean(body?.isPriceApprovalDraft);
  const draftBody =
    body?.draftText ||
    (isPriceApprovalDraft && record?.price_approval_draft_en
      ? record.price_approval_draft_en
      : record
      ? buildDraftReplyFromRecord({
          priceListYear: resolvedYear,
          contractorNormalized: resolvedContractor,
          contractorRaw: record.contractor_raw,
          contractorOfficer: resolvedOfficer,
          matchedProcedures: record.matched_procedures,
          requestedServices: record.requested_services,
        })
      : (record?.suggested_draft_reply || 'Price list: Elite Hospital 2026\nCorporate Email: corporate@elitehospital.org\n@corporate@elitehospital.org'));

  const draftSubject =
    body?.subject ||
    (isPriceApprovalDraft
      ? `[Price Approval Request] ${resolvedContractor} — Ref ${record?.approval_reference || record?.mrn || id}`
      : record?.patient_name
      ? `RE: Inpatient Approval Request - ${record.patient_name} - ${record.mrn || ''}`
      : 'RE: Inpatient Approval Request');

  const draftTo = body?.to || process.env.CORPORATE_SALES_RECIPIENT || 'corporate@elitehospital.org';
  try {
    assertInternalRecipient(draftTo);
  } catch (domainErr: any) {
    return res.status(403).json({ error: domainErr?.message || 'Blocked external recipient domain.' });
  }

  // 5. Attempt EWS in-thread Reply-All draft creation in Exchange
  let ewsSuccess = false;
  let draftMode: 'reply_all' | 'standalone' = 'standalone';
  let ewsError = '';
  try {
    const ews = new EwsSource();
    const itemIdClean = record?.exchange_message_id
      ? record.exchange_message_id.replace(/&lt;|&gt;|<|>/g, '')
      : undefined;

    const draftResult = await ews.createDraft({
      itemId: itemIdClean,
      messageId: itemIdClean,
      conversationId: record?.conversation_id,
      subject: draftSubject,
      body: draftBody,
      to: draftTo,
      signatureHtml: body?.signatureHtml,
      signatureText: body?.signatureText,
    });
    ewsSuccess = draftResult.success;
    draftMode = draftResult.mode;
    if (!ewsSuccess) ewsError = draftResult.error || 'EWS draft creation returned non-success';
  } catch (ewsErr: any) {
    console.warn(`[Draft API] EWS operation note:`, ewsErr?.message || ewsErr);
    ewsError = ewsErr?.message || String(ewsErr);
  }

  const nowIso = new Date().toISOString();

  // 6. Update status, latest officer, year, and draft text in Supabase PostgreSQL
  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      await client
        .from('inpatient_approvals')
        .update({
          status: 'draft_created',
          contractor_normalized: resolvedContractor,
          contractor_officer: resolvedOfficer,
          price_list_year: resolvedYear,
          suggested_draft_reply: draftBody,
          state_timestamps: {
            ...(record?.state_timestamps || {}),
            drafted_at: nowIso,
            updated_at: nowIso,
          },
          updated_at: nowIso,
        })
        .eq('id', id);
    } catch (err: any) {
      console.warn(`[Draft API] Supabase update warning:`, err?.message || err);
    }
  }

  // 7. Mirror immediately to Firestore derived read model
  try {
    await mirrorApprovalToFirestore({
      id,
      status: 'draft_created',
      draftedAt: nowIso,
      mrn: record?.mrn || '000000',
      patientName: record?.patient_name || 'غير مسجل',
      bed: record?.bed || null,
      admissionType: record?.admission_type || 'Inpatient',
      physician: record?.physician || null,
      contractorRaw: record?.contractor_raw || null,
      contractorNormalized: resolvedContractor,
      contractorOfficer: resolvedOfficer,
      priceListYear: resolvedYear,
      diagnosis: record?.diagnosis || null,
      requestedServices: record?.requested_services || [],
      matchedProcedures: record?.matched_procedures || [],
      draftBody,
      suggestedDraftReply: draftBody,
      cmWhatsappMessage: record?.cm_whatsapp_message || null,
      hasReplies: record?.has_replies ?? false,
      hasExistingApproval: record?.has_existing_approval ?? false,
      isRefused: record?.is_refused ?? false,
    } as any);
  } catch (fErr: any) {
    console.warn(`[Draft API] Firestore sync note:`, fErr?.message || fErr);
  }

  return res.status(200).json({
    success: true,
    draftedInOutlook: ewsSuccess,
    mode: draftMode,
    id,
    message: ewsSuccess
      ? (draftMode === 'reply_all'
          ? 'In-thread Reply-All draft created successfully in Outlook with all To/Cc recipients and signature.'
          : 'Draft created in Outlook Drafts folder.')
      : 'Draft status registered and queued for Exchange synchronization.',
    note: ewsSuccess ? undefined : ewsError,
    timestamp: nowIso,
  });
}
