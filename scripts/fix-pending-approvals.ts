import 'dotenv/config';
import { db } from '../src/firebase';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { loadLocalApprovals, saveLocalApprovals, detectExistingApproval } from './approvals-watcher';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';

// One-off: records marked approved only because a *request* ("الرجاء الموافقة") matched an approval keyword.
async function main() {
  const records = loadLocalApprovals();
  const fixed: any[] = [];
  for (const r of records) {
    if (r.status !== 'approved' && r.status !== 'conditionally_approved') continue;
    if ((r.statusReasonArabic || '').includes('يدوياً')) continue; // keep manual decisions
    const snip = r.existingApprovalSnippet || '';
    if (!snip || snip.startsWith('تمت الموافقة واعتماد')) continue;
    if (detectExistingApproval(snip, '').hasApproval) continue;
    r.status = 'pending_manual_draft';
    r.hasExistingApproval = false;
    r.existingApprovalSnippet = '';
    r.statusReasonArabic = 'بانتظار الموافقة (طلب موافقة وليس رد معتمد)';
    r.cmWhatsappMessage = generateCmWhatsappMessage(r);
    fixed.push(r);
  }
  saveLocalApprovals(records);
  for (const r of fixed) {
    const fsData = {
      ...r,
      receivedAt: r.receivedAt && typeof (r.receivedAt as any).toDate === 'function'
        ? r.receivedAt
        : r.receivedAt ? Timestamp.fromDate(new Date(r.receivedAt)) : Timestamp.now(),
    };
    await setDoc(doc(db, 'inpatient_approvals', r.id), fsData, { merge: true });
  }
  console.log(`Reverted ${fixed.length} records to pending (local + Firestore).`);
  process.exit(0);
}
main();
