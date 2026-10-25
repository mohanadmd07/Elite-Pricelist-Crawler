/**
 * Backfill Script: Generates missing suggested_draft_reply and cm_whatsapp_message
 * for all approvals in Supabase PostgreSQL and syncs directly to Cloud Firestore.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { db } from '../src/firebase';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { buildDraftReplyText, ProcedureEntry } from '../src/lib/draftReplyBuilder';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { cleanContractorName } from '../src/lib/arabic-normalizer';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase environment variables!');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runBackfill() {
  console.log('=====================================================');
  console.log(' Elite Approvals: Backfill Drafts & WhatsApp Messages');
  console.log('=====================================================');

  const { data: rows, error } = await supabase
    .from('inpatient_approvals')
    .select('*')
    .order('received_at', { ascending: false });

  if (error) {
    console.error('Failed to query approvals from Supabase:', error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log('No approvals found.');
    process.exit(0);
  }

  console.log(`Found ${rows.length} approvals. Starting processing...`);

  let updatedPostgres = 0;
  let updatedFirestore = 0;

  for (const row of rows) {
    const contractor = row.contractor_normalized || row.contractor_raw || 'التعاقد';
    const officer = row.contractor_officer || 'مسئول السيلز المختص';
    const year = row.price_list_year || '2026';

    const matchedProcedures: ProcedureEntry[] =
      Array.isArray(row.matched_procedures) && row.matched_procedures.length > 0
        ? row.matched_procedures
        : Array.isArray(row.requested_services)
        ? row.requested_services.map((s: any) => ({
            serviceName: s.name,
            matchedName: s.name,
            status: 'matched' as const,
          }))
        : [];

    // 1. Compute draft reply
    let draftBody = row.suggested_draft_reply;
    if (!draftBody || draftBody === 'undefined' || draftBody.trim().length === 0) {
      draftBody = buildDraftReplyText(year, contractor, officer, matchedProcedures);
    }

    // 2. Compute CM WhatsApp message
    let cmWhatsapp = row.cm_whatsapp_message;
    if (
      !cmWhatsapp ||
      cmWhatsapp === 'undefined' ||
      cmWhatsapp.includes('قيد التوليد') ||
      cmWhatsapp.trim().length === 0
    ) {
      cmWhatsapp = generateCmWhatsappMessage({
        patientName: row.patient_name,
        bed: row.bed || '',
        contractorNormalized: contractor,
        contractorRaw: row.contractor_raw,
        requestedServices: row.requested_services,
        matchedProcedures: row.matched_procedures,
        diagnosis: row.diagnosis,
        status: row.status,
        hasExistingApproval: Boolean(row.has_existing_approval),
        isRefused: Boolean(row.is_refused),
        approvedAmountLimit: row.financial_terms?.approvedAmountLimit,
        patientSharePercentage: row.financial_terms?.patientSharePercentage,
        coverageConditions: row.financial_terms?.coverageConditions,
        statusReasonArabic: row.status_reason_arabic,
      } as any);
    }

    // 3. Update Supabase PostgreSQL
    const { error: updateErr } = await supabase
      .from('inpatient_approvals')
      .update({
        suggested_draft_reply: draftBody,
        cm_whatsapp_message: cmWhatsapp,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    if (updateErr) {
      console.warn(`[Supabase Update Error] ID ${row.id}:`, updateErr.message);
    } else {
      updatedPostgres++;
    }

    // 4. Update Cloud Firestore Read Model
    try {
      const docRef = doc(db, 'inpatient_approvals', row.id);
      await setDoc(
        docRef,
        {
          draftBody,
          suggestedDraftReply: draftBody,
          cmWhatsappMessage: cmWhatsapp,
          _backfilledAt: serverTimestamp(),
        },
        { merge: true }
      );
      updatedFirestore++;
    } catch (fsErr: any) {
      console.warn(`[Firestore Update Error] ID ${row.id}:`, fsErr?.message || fsErr);
    }

    if ((updatedPostgres) % 10 === 0) {
      console.log(`  ✓ Processed ${updatedPostgres}/${rows.length} approvals...`);
    }
  }

  console.log('=====================================================');
  console.log(`✅ Backfill Complete!`);
  console.log(`  Supabase PostgreSQL updated: ${updatedPostgres}/${rows.length}`);
  console.log(`  Cloud Firestore updated:     ${updatedFirestore}/${rows.length}`);
  console.log('=====================================================');
}

runBackfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error during backfill:', err);
    process.exit(1);
  });
