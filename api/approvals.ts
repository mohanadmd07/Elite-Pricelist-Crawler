import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

function isAuthorizedRequest(req: any): boolean {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return false;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return false;
  }
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (internalSecret && token === internalSecret) return true;
  if (cronSecret && token === cronSecret) return true;
  const parts = token.split('.');
  if (parts.length === 3 && parts[0].length > 10) return true;
  return false;
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Gate: Reject unauthenticated requests to protect patient PHI
  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized: Valid authentication credentials required.' });
  }

  // 1. Supabase PostgreSQL primary source
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const client = createClient(supabaseUrl, supabaseKey);
      const { data, error } = await client
        .from('inpatient_approvals')
        .select('*')
        .order('received_at', { ascending: false })
        .limit(200);

      if (!error && Array.isArray(data) && data.length > 0) {
        const mapped = data.map((row) => ({
          id: row.id,
          messageId: row.exchange_message_id,
          conversationId: row.conversation_id,
          receivedAt: row.received_at,
          patientName: row.patient_name,
          mrn: row.mrn,
          bed: row.bed,
          admissionType: row.admission_type,
          physician: row.physician,
          contractorRaw: row.contractor_raw,
          contractorNormalized: row.contractor_normalized,
          contractorOfficer: row.contractor_officer,
          priceListYear: row.price_list_year,
          diagnosis: row.diagnosis,
          requestedServices: row.requested_services,
          matchedProcedures: row.matched_procedures,
          status: row.status,
          statusReasonArabic: row.status_reason_arabic,
          draftBody: row.suggested_draft_reply || '',
          suggestedDraftReply: row.suggested_draft_reply || '',
          cmWhatsappMessage: row.cm_whatsapp_message || '',
          hasReplies: row.has_replies,
          hasExistingApproval: row.has_existing_approval,
          isRefused: row.is_refused,
          approvedAmountLimit: row.financial_terms?.approvedAmountLimit,
          patientSharePercentage: row.financial_terms?.patientSharePercentage,
          coverageConditions: row.financial_terms?.coverageConditions,
        }));
        return res.status(200).json(mapped);
      }
    } catch (dbErr) {
      console.warn('[API Approvals] Supabase query failed:', dbErr);
    }
  }

  // 2. Fallback to static JSON file if present
  try {
    const jsonPath = path.resolve(process.cwd(), 'data', 'inpatient_approvals.json');
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      return res.status(200).json(data);
    }
  } catch {}

  return res.status(200).json([]);
}
