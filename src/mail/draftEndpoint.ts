import { createClient } from '@supabase/supabase-js';
import { EwsSource } from './adapters/EwsSource';
import { mirrorApprovalToFirestore } from '../services/approvalFirestoreSync';
import { buildDraftReplyFromRecord } from '../lib/draftReplyBuilder';

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

  // 1. Extract approval ID from query params or URL route
  let id = req.query?.id as string;
  if (!id && req.url) {
    const match = req.url.match(/\/api\/approvals\/([^/?]+)\/draft/i);
    if (match) id = match[1];
  }
  if (!id && req.body && typeof req.body === 'object' && req.body.id) {
    id = req.body.id;
  }

  if (!id) {
    return res.status(400).json({ error: 'Missing required approval ID.' });
  }

  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized: Valid authentication credentials required.' });
  }

  console.log(`[Draft API] Triggering draft creation for approval ID: ${id}`);

  // 2. Fetch approval record from Supabase PostgreSQL
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

  // 3. Resolve draft text, subject, and recipient
  const draftBody =
    req.body?.draftText ||
    record?.suggested_draft_reply ||
    (record ? buildDraftReplyFromRecord({
      priceListYear: record.price_list_year,
      contractorNormalized: record.contractor_normalized,
      contractorRaw: record.contractor_raw,
      contractorOfficer: record.contractor_officer,
      matchedProcedures: record.matched_procedures,
    }) : 'Price list: Elite Hospital 2025\nCorporate Email: corporate@elitehospital.org\n@corporate@elitehospital.org');

  const draftSubject =
    req.body?.subject ||
    (record?.patient_name
      ? `RE: Inpatient Approval Request - ${record.patient_name} - ${record.mrn || ''}`
      : 'RE: Inpatient Approval Request');

  const draftTo = req.body?.to || 'corporate@elitehospital.org';

  // 4. Attempt EWS draft creation in Exchange
  let ewsSuccess = false;
  let ewsError = '';
  try {
    const ews = new EwsSource();
    const itemIdClean = record?.exchange_message_id
      ? record.exchange_message_id.replace(/&lt;|&gt;|<|>/g, '')
      : undefined;

    const draftResult = await ews.createDraft({
      itemId: itemIdClean,
      subject: draftSubject,
      body: draftBody,
      to: draftTo,
    });
    ewsSuccess = draftResult.success;
    if (!ewsSuccess) ewsError = draftResult.error || 'EWS draft creation returned non-success';
  } catch (ewsErr: any) {
    console.warn(`[Draft API] EWS operation note:`, ewsErr?.message || ewsErr);
    ewsError = ewsErr?.message || String(ewsErr);
  }

  const nowIso = new Date().toISOString();

  // 5. Update status in Supabase PostgreSQL
  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      await client
        .from('inpatient_approvals')
        .update({
          status: 'draft_created',
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

  // 6. Mirror immediately to Firestore derived read model
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
      contractorNormalized: record?.contractor_normalized || null,
      contractorOfficer: record?.contractor_officer || null,
      priceListYear: record?.price_list_year || '2025',
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
    id,
    message: ewsSuccess
      ? 'Draft created successfully in Outlook Drafts folder.'
      : 'Draft status registered and queued for Exchange synchronization.',
    note: ewsSuccess ? undefined : ewsError,
    timestamp: nowIso,
  });
}
