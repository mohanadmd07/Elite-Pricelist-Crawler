import { db } from '../firebase';
import { doc, setDoc } from 'firebase/firestore';
import { InpatientApprovalRecord } from '../types';

function sanitizeForFirestore(val: any): any {
  if (val === undefined) return null;
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sanitizeForFirestore);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) {
      out[k] = sanitizeForFirestore(v);
    }
  }
  return out;
}

/**
 * Directly synchronizes an InpatientApprovalRecord from sync engine to Firestore.
 * Conforms strictly to Firestore security rules: mrn != null & valid status.
 */
export async function mirrorApprovalToFirestore(record: InpatientApprovalRecord): Promise<{ success: boolean; error?: string }> {
  if (!db || !record.id) return { success: false, error: 'Firestore db not initialized or missing id' };
  try {
    const docRef = doc(db, 'inpatient_approvals', record.id);
    const firestorePayload: Record<string, any> = {
      id: record.id,
      messageId: record.messageId || null,
      conversationId: record.conversationId || null,
      receivedAt: record.receivedAt || new Date().toISOString(),
      patientName: record.patientName || 'غير مسجل',
      mrn: record.mrn || '000000',
      bed: record.bed || null,
      admissionType: record.admissionType || 'Inpatient',
      physician: record.physician || null,
      contractorRaw: record.contractorRaw || null,
      contractorNormalized: record.contractorNormalized || null,
      contractorOfficer: record.contractorOfficer || null,
      priceListYear: record.priceListYear || '2025',
      diagnosis: record.diagnosis || null,
      requestedServices: record.requestedServices || [],
      matchedProcedures: record.matchedProcedures || [],
      financialTerms: {
        patientSharePercentage: record.patientSharePercentage ?? -1,
        approvedAmountLimit: record.approvedAmountLimit ?? -1,
        creditLimitText: record.creditLimitText ?? null,
        coverageConditions: record.coverageConditions ?? '',
      },
      status: record.status || 'received',
      statusReasonArabic: record.statusReasonArabic || null,
      suggestedDraftReply: record.suggestedDraftReply || record.draftBody || null,
      draftBody: record.draftBody || record.suggestedDraftReply || null,
      cmWhatsappMessage: record.cmWhatsappMessage || null,
      hasReplies: Boolean(record.hasReplies),
      hasExistingApproval: Boolean(record.hasExistingApproval),
      isRefused: Boolean(record.isRefused),
      updatedAt: new Date().toISOString(),
      ...(record.classifierStatus !== undefined ? { classifierStatus: record.classifierStatus } : {}),
      ...(record.statusLockedByHuman !== undefined ? { statusLockedByHuman: record.statusLockedByHuman } : {}),
      ...(record.itemsJson !== undefined ? { itemsJson: record.itemsJson } : {}),
      ...(record.pricedItemsJson !== undefined ? { pricedItemsJson: record.pricedItemsJson } : {}),
      ...(record.historyHintsJson !== undefined ? { historyHintsJson: record.historyHintsJson } : {}),
      ...(record.contractTotal !== undefined ? { contractTotal: record.contractTotal } : {}),
      ...(record.priceApprovalTotal !== undefined ? { priceApprovalTotal: record.priceApprovalTotal } : {}),
      ...(record.priceApprovalRequired !== undefined ? { priceApprovalRequired: record.priceApprovalRequired } : {}),
      ...(record.priceApprovalDraftEn !== undefined ? { priceApprovalDraftEn: record.priceApprovalDraftEn } : {}),
      ...(record.priceApprovalStatus !== undefined ? { priceApprovalStatus: record.priceApprovalStatus } : {}),
      ...(record.needsHumanReview !== undefined ? { needsHumanReview: record.needsHumanReview } : {}),
      ...(record.reviewReasons !== undefined ? { reviewReasons: record.reviewReasons } : {}),
      ...(record.approvalReference !== undefined ? { approvalReference: record.approvalReference } : {}),
    };
    await setDoc(docRef, sanitizeForFirestore(firestorePayload), { merge: true });
    return { success: true };
  } catch (err: any) {
    console.warn(`[Firestore Mirror] Failed to mirror approval ${record.id}:`, err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}
