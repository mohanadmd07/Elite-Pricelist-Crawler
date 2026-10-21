import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/firebase';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { loadLocalApprovals, saveLocalApprovals, detectExistingApproval, extractCreditLimit, cleanTextFromHtml } from './approvals-watcher';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';

// One-off: replies from Mohamed Fekry are instructions (price approval to bring), not approvals.
const isFekry = (s: string) => /fekr[iy]|فكري/i.test(s || '');

async function main() {
  const staged: any[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/raw_email_staging.json'), 'utf-8'));
  const records = loadLocalApprovals();
  const changed: any[] = [];
  for (const r of records) {
    const convId = r.conversationId || r.threadKey;
    const msgs = staged.filter((m) => (convId && m.conversationId === convId) || (r.mrn && `${m.subject} ${m.bodyText || ''}`.includes(r.mrn)));
    const fekry = msgs.filter((m) => isFekry(m.from));
    if (fekry.length === 0) continue;
    if ((r.statusReasonArabic || '').includes('يدوياً')) continue;
    const others = msgs.filter((m) => !isFekry(m.from));
    const othersApprove = others.some((m) => detectExistingApproval(cleanTextFromHtml(m.bodyText || m.bodyHtml || ''), m.subject || '').hasApproval);
    let amount: number | null = null;
    let priceReq = false;
    for (const m of fekry) {
      const txt = `${m.subject} ${cleanTextFromHtml(m.bodyText || m.bodyHtml || '')}`.normalize('NFKC');
      if (/سعري[ةه]/i.test(txt)) {
        priceReq = true;
        amount = extractCreditLimit(txt).limit || Number((txt.match(/(\d[\d,]*)\s*(?:ج\b|ج\.م|جنيه|egp|le\b)/i)?.[1] || '').replace(/,/g, '')) || amount;
      }
    }
    if (othersApprove) continue;
    if (r.status === 'approved' || r.status === 'conditionally_approved') {
      r.status = 'pending_manual_draft';
      r.hasExistingApproval = false;
      r.existingApprovalSnippet = '';
      r.statusReasonArabic = priceReq ? 'مطلوب موافقة سعرية (تعليمات من حسابات المرضى وليست موافقة)' : 'بانتظار الموافقة (تعليمات داخلية وليست موافقة)';
    }
    r.priceApprovalRequested = priceReq;
    r.priceApprovalAmount = priceReq ? amount : null;
    r.cmWhatsappMessage = generateCmWhatsappMessage(r);
    changed.push(r);
  }
  saveLocalApprovals(records);
  for (const r of changed) {
    const fsData = { ...r, receivedAt: r.receivedAt && typeof (r.receivedAt as any).toDate === 'function' ? r.receivedAt : r.receivedAt ? Timestamp.fromDate(new Date(r.receivedAt)) : Timestamp.now() };
    await setDoc(doc(db, 'inpatient_approvals', r.id), fsData, { merge: true });
  }
  console.log(`Updated ${changed.length} records:`);
  changed.forEach((r) => console.log(`${r.patientName} | ${r.status} | ${r.priceApprovalAmount ?? '-'} | ${r.cmWhatsappMessage.split('\n')[2]}`));
  process.exit(0);
}
main();
