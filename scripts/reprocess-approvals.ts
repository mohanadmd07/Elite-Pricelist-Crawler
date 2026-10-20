import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/firebase';
import { collection, doc, setDoc } from 'firebase/firestore';
import { loadLocalApprovals, saveLocalApprovals, buildDraftReplyText } from './approvals-watcher';
import { stripSentFromSignatures, normalizeText, normalizeArabic, cleanHisProcedureQuery } from '../src/lib/arabic-normalizer';
import { extractCleanProcedurePhrase, generateCmWhatsappMessage } from '../src/lib/whatsapp-generator';
import { InpatientApprovalRecord } from '../src/types';

function scoreCandidate(
  rowEng: string,
  rowAra: string,
  qEng: string,
  qAra: string,
  tokens: string[],
  mainNounTokens: string[]
): number {
  // Equipment usage fee mismatch protection: "رسم استخدام" vs diagnostic "رسم مخ / رسم قلب"
  if (
    (rowAra.includes('رسم استخدام') || rowAra.includes('استخدام جهاز') || /usage fee/i.test(rowEng)) &&
    (!qAra.includes('استخدام') && !/usage/i.test(qEng))
  ) {
    return 0;
  }

  // TEE (Transesophageal Echocardiography) vs Surface Echo (TTE) mismatch protection:
  const isTeeQuery = /transesophageal|tee\b|t\.e\.e|مريء|المريء|بالمنظار/i.test(qEng + ' ' + qAra);
  const isTeeRow = /transesophageal|tee\b|t\.e\.e|مريء|المريء|بالمنظار/i.test(rowEng + ' ' + rowAra);
  if (isTeeQuery !== isTeeRow) {
    return 0;
  }

  let score = 0;
  if (qEng && rowEng) {
    if (rowEng === qEng) score += 100;
    else if (qEng.startsWith(rowEng) || rowEng.startsWith(qEng)) score += 60;
    else if (qEng.includes(rowEng) || rowEng.includes(qEng)) score += 45;
  }
  if (qAra && rowAra) {
    if (rowAra === qAra) score += 100;
    else if (qAra.startsWith(rowAra) || rowAra.startsWith(qAra)) score += 60;
    else if (qAra.includes(rowAra) || rowAra.includes(qAra)) score += 45;
  }

  let matchedMainCount = 0;
  for (const token of tokens) {
    const isMain = mainNounTokens.includes(token);
    const isExact = rowEng === token || rowAra === token;
    const hasWord =
      new RegExp(`\\b${token}\\b`, 'i').test(rowEng) ||
      rowAra.split(/\s+/).includes(token);
    if (isExact) {
      score += isMain ? 35 : 10;
      if (isMain) matchedMainCount++;
    } else if (hasWord) {
      score += isMain ? 25 : 5;
      if (isMain) matchedMainCount++;
    }
  }

  if (
    mainNounTokens.length > 1 &&
    matchedMainCount < mainNounTokens.length &&
    (!qEng || !rowEng || (!qEng.includes(rowEng) && !rowEng.includes(qEng))) &&
    (!qAra || !rowAra || (!qAra.includes(rowAra) && !rowAra.includes(qAra)))
  ) {
    score = Math.min(score, 20);
  } else if (mainNounTokens.length === 1 && matchedMainCount === 0) {
    score = Math.min(score, 15);
  }

  return score;
}

function matchServices(services: Array<{ name: string; rawPrice: number }>, year: string) {
  const targetYear =
    year === '2026' || year === 'Cash' || /cash|كاش/i.test(year)
      ? '2026'
      : (year === '2024' || year === '2023' ? year : '2025');
  let pricelist: any[] = [];
  try {
    const pPath = path.resolve(process.cwd(), 'public', `${targetYear}_cash.json`);
    if (fs.existsSync(pPath)) {
      pricelist = JSON.parse(fs.readFileSync(pPath, 'utf-8'));
    }
  } catch {}

  const anatomicalStopwords = ['قدم', 'كاحل', 'يد', 'عين', 'اذن', 'راس', 'مفصل', 'foot', 'ankle', 'wrist', 'hand', 'joint'];
  const clinicalNoise = [
    'عمل', 'سحب', 'تحليل', 'طلب', 'برجاء', 'المطلوب', 'باسم', 'باستخدام', 'تحت', 'الحاله', 'الحالة',
    'المريض', 'مريض', 'المريضة', 'مريضة', 'الطفل', 'طفل', 'الطفلة', 'طفلة', 'استشاري', 'دكتور', 'طبيب', 'كشف'
  ];

  const results: Array<{ serviceName: string; matchedName: string; code?: string; status: 'matched' | 'unmatched' }> = [];

  for (const srv of services) {
    const s = srv.name.trim();
    const cleanS = cleanHisProcedureQuery(s);
    const engTokens = cleanS
      .replace(/[\u0600-\u06FF]/g, ' ')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => (t.length >= 2 || /^[0-9]$/.test(t)) && !clinicalNoise.includes(t));
    const araTokens = cleanS
      .replace(/[a-zA-Z0-9]/g, ' ')
      .replace(/[^ \u0621-\u064A]/g, ' ')
      .split(/\s+/)
      .filter((t) => (t.length >= 2 || /^[0-9]$/.test(t)) && !clinicalNoise.includes(t));
    const allTokens = [...engTokens, ...araTokens];
    const mainNounTokens = allTokens.filter((t) => !anatomicalStopwords.includes(t));

    const scoredCandidates: Array<{ item: any; score: number }> = [];
    for (const item of pricelist) {
      const rowEng = normalizeText(item.nameEnglish);
      const rowAra = normalizeArabic(item.nameArabic);
      const score = scoreCandidate(rowEng, rowAra, engTokens.join(' '), araTokens.join(' '), allTokens, mainNounTokens);
      if (score >= 20) {
        scoredCandidates.push({ item, score });
      }
    }
    scoredCandidates.sort((a, b) => b.score - a.score);

    if (scoredCandidates.length > 0 && scoredCandidates[0].score >= 35) {
      const best = scoredCandidates[0].item;
      const displayName = best.nameArabic ? `${best.nameArabic} (${best.nameEnglish})` : best.nameEnglish;
      results.push({
        serviceName: srv.name,
        matchedName: displayName,
        status: 'matched',
      });
      continue;
    }

    results.push({
      serviceName: srv.name,
      matchedName: srv.name,
      status: 'unmatched',
    });
  }

  return results;
}

async function run() {
  const approvals = loadLocalApprovals();
  console.log(`Processing ${approvals.length} approval records...`);

  for (const record of approvals) {
    // 0. Contractor correction & sanitization
    if (record.mrn === '0000267870' || (record.patientName && record.patientName.includes('ماجد محمد عبده'))) {
      record.contractorRaw = 'شركة جاسكو';
      record.contractorNormalized = 'جاسكو';
      record.priceListYear = '2025';
      record.contractorOfficer = 'زياد';
    } else if (
      (record.contractorNormalized && record.contractorNormalized.includes('مستشفى إيليت')) ||
      (record.contractorRaw && record.contractorRaw.includes('مستشفى إيليت'))
    ) {
      record.contractorRaw = 'غير محدد';
      record.contractorNormalized = 'غير محدد';
      record.contractorOfficer = 'غير محدد (يتطلب تحديد منسق السيلز)';
    }

    const isCash =
      /كاش|cash|خصم نادي|خصم نادى/i.test(record.contractorNormalized || '') ||
      /كاش|cash|خصم نادي|خصم نادى/i.test(record.contractorRaw || '') ||
      record.priceListYear === 'Cash';
    if (isCash) {
      record.priceListYear = '2026';
    }

    // 1. Clean snippets
    record.replySnippet = stripSentFromSignatures(record.replySnippet || '');
    record.existingApprovalSnippet = stripSentFromSignatures(record.existingApprovalSnippet || '');
    record.refusalSnippet = stripSentFromSignatures(record.refusalSnippet || '');

    // 2. Clean requestedServices
    if (record.requestedServices && record.requestedServices.length > 0) {
      for (const srv of record.requestedServices) {
        if (
          srv.name &&
          (srv.name.length > 30 ||
            srv.name.includes('\n') ||
            srv.name.includes('يعاني') ||
            srv.name.includes('يعانى') ||
            srv.name.includes('ورم') ||
            srv.name.includes('برجاء'))
        ) {
          const clean = extractCleanProcedurePhrase(srv.name);
          if (clean && clean.length >= 3) {
            console.log(`[MRN ${record.mrn}] Cleaned service: "${srv.name}" -> "${clean}"`);
            srv.name = clean;
          }
        }
      }
    }

    // 3. Re-match procedures against pricelist
    const matched = matchServices(record.requestedServices || [], record.priceListYear || '2025');
    record.matchedProcedures = matched;

    // 4. Re-build draft reply
    record.draftBody = buildDraftReplyText(
      record.priceListYear || '2025',
      record.contractorNormalized || record.contractorRaw || '',
      record.contractorOfficer || 'غير محدد',
      matched
    );

    // 5. Generate CM WhatsApp message
    record.cmWhatsappMessage = generateCmWhatsappMessage(record);

    console.log(`[MRN ${record.mrn}] Draft:\n${record.draftBody}`);
    console.log(`[MRN ${record.mrn}] CM WhatsApp:\n${record.cmWhatsappMessage}\n---`);

    // 6. Sync to Firestore
    try {
      const docRef = doc(db, 'inpatient_approvals', record.id);
      await setDoc(docRef, record, { merge: true });
    } catch (e) {
      console.warn(`Firestore sync note for ${record.id}:`, e);
    }
  }

  saveLocalApprovals(approvals);
  console.log(`Successfully reprocessed and saved ${approvals.length} approvals!`);
}

run().catch(console.error);
