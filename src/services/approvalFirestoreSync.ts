import { db } from '../firebase';
import { doc, setDoc } from 'firebase/firestore';
import { InpatientApprovalRecord } from '../types';

/**
 * Directly synchronizes an InpatientApprovalRecord from sync engine to Firestore.
 * Conforms strictly to Firestore security rules: mrn != null & valid status.
 */
export async function mirrorApprovalToFirestore(record: InpatientApprovalRecord): Promise<void> {
  if (!db || !record.id) return;
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
    };
    await setDoc(docRef, firestorePayload, { merge: true });
  } catch (err: any) {
    console.warn(`[Firestore Mirror] Failed to mirror approval ${record.id}:`, err?.message || err);
  }
}
