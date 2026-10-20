import dotenv from 'dotenv';
dotenv.config();

import { ewsFindItemsInFolder, ewsGetItemsBatch, parseHisApprovalHtml, cleanTextFromHtml, EXACT_INAPPROVALS_FOLDER_ID } from '../scripts/approvals-watcher';
import { extractOriginalRequestDate } from '../src/lib/arabic-normalizer';

async function test() {
  const items = await ewsFindItemsInFolder(EXACT_INAPPROVALS_FOLDER_ID, 250);
  console.log('Total items in folder:', items.length);

  const fullItems: any[] = [];
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25).map(it => it.id);
    const batch = await ewsGetItemsBatch(chunk);
    fullItems.push(...batch);
  }

  console.log('Fetched details for:', fullItems.length, 'items');

  let hisCount = 0;
  let replyCount = 0;
  let notificationsEliteCount = 0;
  let blankMrnCount = 0;
  const approvalsByMrn = new Map<string, any[]>();

  for (const item of fullItems) {
    const from = (item.from || '').toLowerCase().trim();
    if (from === 'notifications@elitehospital.org' || from.startsWith('notifications@')) {
      notificationsEliteCount++;
      continue;
    }

    const subject = item.subject || '';
    const fullHtml = item.bodyHtml || '';
    const fullText = item.bodyText || '';
    const cleanBody = cleanTextFromHtml(fullText + '\n' + fullHtml);

    const isFromHis = from.includes('his.notifications') || from.includes('his.') || subject.toLowerCase().includes('his notifications');
    const isReply = /^(re|رد|fw|fwd)\s*:/i.test(subject.trim());
    const hasHisApprovalFormat = fullHtml.includes('SELECTED SERVICES') || fullHtml.includes('Patient Information') || subject.toLowerCase().includes('inpatient approval');

    if (isFromHis || (!isReply && hasHisApprovalFormat)) {
      const parsed = parseHisApprovalHtml(fullHtml, subject, item.messageId);
      if (!parsed.mrn || parsed.mrn === '0000000000' || !parsed.patientName || parsed.patientName === 'Unknown Patient') {
        blankMrnCount++;
        continue;
      }
      hisCount++;
      const list = approvalsByMrn.get(parsed.mrn) || [];
      list.push({ item, parsed });
      approvalsByMrn.set(parsed.mrn, list);
    } else {
      replyCount++;
    }
  }

  console.log('--- Summary ---');
  console.log('Notifications@Elite skipped:', notificationsEliteCount);
  console.log('Blank MRN skipped:', blankMrnCount);
  console.log('Distinct HIS Approval requests found:', hisCount);
  console.log('Unique Patients (MRNs):', approvalsByMrn.size);
  console.log('Reply/other messages:', replyCount);

  // Show patients with multiple approvals
  const multiple = [...approvalsByMrn.entries()].filter(([mrn, list]) => list.length > 1);
  console.log(`\nPatients with multiple approval emails (${multiple.length}):`);
  for (const [mrn, list] of multiple) {
    console.log(`MRN ${mrn}: ${list[0].parsed.patientName} (${list.length} requests)`);
    for (const req of list) {
      console.log(`   - Date: ${req.item.receivedAt.toISOString()} | Subj: ${req.item.subject} | Services: ${req.parsed.requestedServices.map((s: any) => s.name).join(', ')}`);
    }
  }
}

test().catch(console.error);
