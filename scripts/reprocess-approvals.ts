import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db } from '../src/firebase';
import { collection, doc, setDoc, Timestamp } from 'firebase/firestore';
import { loadLocalApprovals, saveLocalApprovals, buildDraftReplyText } from './approvals-watcher';
import { stripSentFromSignatures, normalizeText, normalizeArabic, cleanHisProcedureQuery, hasAntibodyConflict } from '../src/lib/arabic-normalizer';
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

import { retrieveDynamicPricelistCandidates } from '../src/services/procedureService';

async function matchServices(services: Array<{ name: string; rawPrice: number }>, year: string, diagnosis?: string) {
  const results: Array<{ serviceName: string; matchedName: string; code?: string; status: 'matched' | 'unmatched' }> = [];

  for (const srv of services) {
    const cands = await retrieveDynamicPricelistCandidates(year, [srv], diagnosis, 10);
    const topCand = cands.find((c) => c.score >= 35 && !hasAntibodyConflict(srv.name, c.nameEnglish || ''));
    if (topCand) {
      const displayName = topCand.nameArabic ? `${topCand.nameArabic} (${topCand.nameEnglish})` : topCand.nameEnglish;
      results.push({
        serviceName: srv.name,
        matchedName: displayName,
        status: 'matched',
      });
    } else {
      results.push({
        serviceName: srv.name,
        matchedName: srv.name,
        status: 'unmatched',
      });
    }
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
    const matched = await matchServices(record.requestedServices || [], record.priceListYear || '2025', record.diagnosis);
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

    // 6. Sync to Firestore with guaranteed Timestamp
    try {
      const docRef = doc(db, 'inpatient_approvals', record.id);
      const fsData = {
        ...record,
        receivedAt:
          record.receivedAt && typeof (record.receivedAt as any).toDate === 'function'
            ? record.receivedAt
            : record.receivedAt
            ? Timestamp.fromDate(new Date(record.receivedAt))
            : Timestamp.now(),
      };
      await setDoc(docRef, fsData, { merge: true });
    } catch (e) {
      console.warn(`Firestore sync note for ${record.id}:`, e);
    }
  }

  saveLocalApprovals(approvals);
  console.log(`Successfully reprocessed and saved ${approvals.length} approvals!`);
}

run().catch(console.error);
