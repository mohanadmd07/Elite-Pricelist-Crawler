import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/firebase';
import { doc, setDoc, Timestamp } from 'firebase/firestore';
import { loadLocalApprovals, saveLocalApprovals, detectExistingApproval, extractCreditLimit, cleanTextFromHtml } from './approvals-watcher';
import { generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';

// One-off: "خارج التعاقد" => "مطلوب موافقة سعرية بمبلغ X" (never an approval).
const isFekry = (s: string) => /fekr[iy]|فكري/i.test(s || '');
const OOC = /خارج\s*(?:ال)?[تط]عاقد/i;

async function main() {
  const staged: any[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/raw_email_staging.json'), 'utf-8'));
  const records = loadLocalApprovals();
  const changed: any[] = [];
  for (const r of records) {
    if ((r.statusReasonArabic || '').includes('يدوياً')) continue;
    const convId = r.conversationId || r.threadKey;
    const msgs = staged.filter((m) => (convId && m.conversationId === convId) || (r.mrn && `${m.subject} ${m.bodyText || ''}`.includes(r.mrn)));
    const texts = msgs.map((m) => ({ m, txt: `${m.subject} ${cleanTextFromHtml(m.bodyText || m.bodyHtml || '')}`.normalize('NFKC') }));
    const ooc = texts.filter((t) => OOC.test(t.txt));
    if (ooc.length === 0) continue;
    const realApproval = texts.some((t) => !isFekry(t.m.from) && !OOC.test(t.txt) && detectExistingApproval(t.txt, '').hasApproval);
    if (realApproval) continue;
    let amount: number | null = null;
    for (const t of ooc) {
      amount = extractCreditLimit(t.txt).limit || Number((t.txt.match(/(\d[\d,]*)\s*(?:ج\b|ج\.م|جنيه|egp|le\b)/i)?.[1] || '').replace(/,/g, '')) || amount;
    }
    r.status = 'pending_manual_draft';
    r.hasExistingApproval = false;
    r.existingApprovalSnippet = '';
    r.statusReasonArabic = 'خارج التعاقد - مطلوب موافقة سعرية';
    r.priceApprovalRequested = true;
    r.priceApprovalAmount = amount;
    r.cmWhatsappMessage = generateCmWhatsappMessage(r);
    changed.push(r);
  }
  saveLocalApprovals(records);
  for (const r of changed) {
    const fsData = { ...r, receivedAt: r.receivedAt && typeof (r.receivedAt as any).toDate === 'function' ? r.receivedAt : r.receivedAt ? Timestamp.fromDate(new Date(r.receivedAt)) : Timestamp.now() };
    await setDoc(doc(db, 'inpatient_approvals', r.id), fsData, { merge: true });
  }
  console.log(`Updated ${changed.length} records:`);
  changed.forEach((r) => console.log(`${r.patientName} | ${r.priceApprovalAmount ?? '-'} | ${r.cmWhatsappMessage.split('\n')[2]}`));
  process.exit(0);
}
main();
