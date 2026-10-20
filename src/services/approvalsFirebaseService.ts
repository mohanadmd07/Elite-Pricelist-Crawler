import {
  collection,
  doc,
  onSnapshot,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch,
  Timestamp,
  where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { InpatientApprovalRecord, CompanyConfigRecord, AutomationSettings, CompanyInfo } from '../types';

const APPROVALS_COLLECTION = 'inpatient_approvals';
const COMPANIES_COLLECTION = 'companies_config';
const SETTINGS_COLLECTION = 'settings';
const AUTOMATION_SETTINGS_DOC = 'approvals_automation';

export const MAX_HISTORY_DAYS = 30;

let lastPurgeTimestamp = 0;

/**
 * Checks if the frontend is running locally (where the local watcher API exists).
 */
export const isLocalEnvironment = (): boolean => {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.');
};

/**
 * Purges inpatient approval records older than maxDays (default 30)
 * to enforce a strictly 30-day rolling history with automatic daily rollover.
 */
export async function purgeRecordsOlderThanDays(maxDays = MAX_HISTORY_DAYS): Promise<number> {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxDays);
    cutoff.setHours(0, 0, 0, 0);
    const cutoffTimestamp = Timestamp.fromDate(cutoff);

    const colRef = collection(db, APPROVALS_COLLECTION);
    const q = query(colRef, where('receivedAt', '<', cutoffTimestamp));
    const snap = await getDocs(q);

    if (snap.empty) return 0;

    const batch = writeBatch(db);
    snap.docs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });
    await batch.commit();
    return snap.size;
  } catch (err) {
    // Skip silently if client does not have delete privileges
    return 0;
  }
}

/**
 * Subscribes to the real-time stream of inpatient approval records within the last 30 days.
 * Automatically discards expired items and triggers rollover purge.
 */
export function subscribeToApprovals(
  onUpdate: (records: InpatientApprovalRecord[]) => void,
  onError?: (err: Error) => void
): () => void {
  let isSubscribed = true;

  // 1. Initial fast-hydration from local watcher API if available
  if (isLocalEnvironment()) {
    fetch('/api/approvals')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data) && isSubscribed) {
          onUpdate(data);
        }
      })
      .catch(() => {});
  }

  // 2. Pure real-time stream via Firestore snapshot listener (no redundant 3s REST polling)
  const colRef = collection(db, APPROVALS_COLLECTION);
  const q = query(colRef, orderBy('receivedAt', 'desc'), limit(1000));

  // Trigger background purge once every 6 hours
  const now = Date.now();
  if (now - lastPurgeTimestamp > 6 * 60 * 60 * 1000) {
    lastPurgeTimestamp = now;
    purgeRecordsOlderThanDays(MAX_HISTORY_DAYS).catch(() => {});
  }

  const unsubFirestore = onSnapshot(
    q,
    (snapshot) => {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - MAX_HISTORY_DAYS);
      cutoffDate.setHours(0, 0, 0, 0);

      const records: InpatientApprovalRecord[] = [];
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data() as Omit<InpatientApprovalRecord, 'id'>;
        const recordDate =
          data.receivedAt && typeof (data.receivedAt as any).toDate === 'function'
            ? (data.receivedAt as any).toDate()
            : data.receivedAt ? new Date(data.receivedAt) : new Date();

        // Enforce 30-day rolling window
        if (recordDate >= cutoffDate) {
          records.push({
            id: docSnap.id,
            ...data,
          });
        }
      });

      if (isSubscribed) {
        onUpdate(records);
      }
    },
    (error) => {
      console.warn('[Approvals Service] Ordered approvals query failed, falling back to base query:', error);
      // Fallback query without orderBy in case of missing compound index
      onSnapshot(
        colRef,
        (snap) => {
          const records: InpatientApprovalRecord[] = [];
          snap.docs.forEach((docSnap) => {
            records.push({
              id: docSnap.id,
              ...(docSnap.data() as Omit<InpatientApprovalRecord, 'id'>),
            });
          });
          if (isSubscribed) {
            onUpdate(records);
          }
        },
        (fallbackErr) => {
          onError?.(fallbackErr);
        }
      );
    }
  );

  return () => {
    isSubscribed = false;
    unsubFirestore();
  };
}

/**
 * Toggles an approval record between 'answered' and 'draft_created' (or 'unanswered').
 */
export async function toggleApprovalStatus(
  id: string,
  currentStatus: InpatientApprovalRecord['status']
): Promise<void> {
  const newStatus = currentStatus === 'answered' ? 'draft_created' : 'answered';

  if (isLocalEnvironment()) {
    try {
      await fetch(`/api/approvals/${id}/toggle`, { method: 'POST' });
    } catch {}
  }

  try {
    const docRef = doc(db, APPROVALS_COLLECTION, id);
    await updateDoc(docRef, {
      status: newStatus,
      answeredAt: newStatus === 'answered' ? serverTimestamp() : null,
    });
  } catch {}
}

/**
 * Triggers manual drafting for an approval that was held back due to detected replies or approval notes.
 */
export async function triggerManualDraft(id: string): Promise<void> {
  // 1. Attempt local/proxied REST draft trigger
  try {
    const res = await fetch(`/api/approvals/${id}/draft`, { method: 'POST' });
    if (res.ok) {
      return;
    }
  } catch {}

  // 2. Fallback to updating Firestore doc so background watcher picks it up
  try {
    const docRef = doc(db, APPROVALS_COLLECTION, id);
    await updateDoc(docRef, {
      status: 'draft_created',
      manualDraftRequested: true,
      draftedAt: serverTimestamp(),
    });
  } catch (err: any) {
    console.warn('[Approvals] Firestore manual draft request note:', err?.message || err);
  }
}

/**
 * Subscribes to real-time company/contractor configurations.
 */
export function subscribeToCompanyConfigs(
  onUpdate: (companies: CompanyConfigRecord[]) => void,
  onError?: (err: Error) => void
): () => void {
  let isSubscribed = true;

  // Fast hydration on mount if local
  if (isLocalEnvironment()) {
    fetch('/api/contractors')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data) && data.length > 0 && isSubscribed) {
          onUpdate(data);
        }
      })
      .catch(() => {});
  }

  const colRef = collection(db, COMPANIES_COLLECTION);
  const q = query(colRef, orderBy('name', 'asc'));

  const unsubFirestore = onSnapshot(
    q,
    (snapshot) => {
      const companies: CompanyConfigRecord[] = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<CompanyConfigRecord, 'id'>),
      }));
      if (isSubscribed) {
        onUpdate(companies);
      }
    },
    (error) => {
      onError?.(error);
    }
  );

  return () => {
    isSubscribed = false;
    unsubFirestore();
  };
}

/**
 * Cascades updates to all matching inpatient approvals in Firestore
 * when a contractor or officer is updated or renamed.
 */
export async function cascadeApprovalsForCompany(params: {
  targetName: string;
  previousName?: string;
  aliases?: string[];
  contractorOfficer: string;
  priceListYear?: string;
}): Promise<number> {
  const { targetName, previousName, aliases = [], contractorOfficer, priceListYear } = params;
  const matchNames = new Set<string>();
  if (targetName) matchNames.add(targetName.trim().toLowerCase());
  if (previousName) matchNames.add(previousName.trim().toLowerCase());
  aliases.forEach((a) => {
    if (a && a.trim()) matchNames.add(a.trim().toLowerCase());
  });

  try {
    const approvalsCol = collection(db, APPROVALS_COLLECTION);
    const snap = await getDocs(query(approvalsCol, limit(1000)));
    const batch = writeBatch(db);
    let count = 0;

    snap.docs.forEach((d) => {
      const data = d.data();
      const norm = (data.contractorNormalized || '').trim().toLowerCase();
      const raw = (data.contractorRaw || '').trim().toLowerCase();
      if (matchNames.has(norm) || matchNames.has(raw)) {
        batch.update(d.ref, {
          contractorNormalized: targetName.trim(),
          contractorOfficer: contractorOfficer.trim(),
          ...(priceListYear ? { priceListYear } : {}),
        });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
      console.log(`[Approvals] Cascaded contractor update to ${count} approval records in Firestore.`);
    }
    return count;
  } catch (err) {
    console.warn('[Approvals] Cascade to Firestore approvals failed (may be offline):', err);
    return 0;
  }
}

/**
 * Saves or updates a company configuration in Firestore.
 */
export async function saveCompanyConfig(
  company: Partial<CompanyConfigRecord> & {
    name: string;
    previousName?: string;
    priceListYear: string;
    contractorOfficer: string;
  },
  userEmail?: string
): Promise<string> {
  const docId = company.id || company.name.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_');
  const targetName = company.name.trim();
  const targetOfficer = company.contractorOfficer.trim();
  const targetYear = company.priceListYear || '2025';
  const targetAliases = Array.from(
    new Set([
      targetName,
      ...(company.previousName ? [company.previousName.trim()] : []),
      ...(Array.isArray(company.aliases) ? company.aliases : []),
    ])
  ).filter(Boolean);

  if (isLocalEnvironment()) {
    try {
      await fetch('/api/contractors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...company,
          id: docId,
          name: targetName,
          aliases: targetAliases,
          contractorOfficer: targetOfficer,
          priceListYear: targetYear,
        }),
      });
    } catch {}
  }

  try {
    const docRef = doc(db, COMPANIES_COLLECTION, docId);
    const data: Partial<CompanyConfigRecord> = {
      id: docId,
      name: targetName,
      aliases: targetAliases,
      priceListYear: targetYear,
      contractorOfficer: targetOfficer,
      discountPercentage: company.discountPercentage || 0,
      updatedAt: serverTimestamp(),
      updatedBy: userEmail || 'system',
    };
    await setDoc(docRef, data, { merge: true });

    // If company was renamed and previously had a different docId, clean up old doc
    if (company.previousName && company.previousName.trim() !== targetName) {
      const oldDocId = company.previousName.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_');
      if (oldDocId !== docId && !company.id) {
        try {
          await deleteDoc(doc(db, COMPANIES_COLLECTION, oldDocId));
        } catch {}
      }
    }

    // Cascade update to all matching inpatient approval records in Firestore
    await cascadeApprovalsForCompany({
      targetName,
      previousName: company.previousName,
      aliases: targetAliases,
      contractorOfficer: targetOfficer,
      priceListYear: targetYear,
    });
  } catch (err) {
    console.warn('Failed to save company config to Firestore:', err);
  }

  return docId;
}

/**
 * Deletes a company configuration from Firestore and local API.
 */
export async function deleteCompanyConfig(id: string): Promise<void> {
  try {
    const docRef = doc(db, COMPANIES_COLLECTION, id);
    await deleteDoc(docRef);
  } catch (err) {
    console.warn('Failed to delete company doc in Firestore:', err);
  }

  if (isLocalEnvironment()) {
    try {
      await fetch(`/api/contractors?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    } catch {}
  }
}

/**
 * Merges multiple selected companies into a single target company.
 * Aggregates all aliases, updates the target company, removes source companies,
 * and cascades changes to existing inpatient approval records.
 */
export async function mergeCompanies(params: {
  targetId: string;
  targetName: string;
  priceListYear: string;
  contractorOfficer: string;
  discountPercentage?: number;
  sourceCompanies: CompanyConfigRecord[];
  userEmail?: string;
}): Promise<void> {
  const { targetId, targetName, priceListYear, contractorOfficer, discountPercentage = 0, sourceCompanies, userEmail } = params;

  // Gather all unique aliases and names
  const allAliasesSet = new Set<string>();
  allAliasesSet.add(targetName.trim());
  for (const comp of sourceCompanies) {
    if (comp.name) allAliasesSet.add(comp.name.trim());
    if (comp.aliases && Array.isArray(comp.aliases)) {
      comp.aliases.forEach((a) => {
        if (a && a.trim()) allAliasesSet.add(a.trim());
      });
    }
  }
  const mergedAliases = Array.from(allAliasesSet);

  // If local API available, notify watcher
  if (isLocalEnvironment()) {
    try {
      await fetch('/api/contractors/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId,
          targetName,
          priceListYear,
          contractorOfficer,
          discountPercentage,
          aliases: mergedAliases,
          sourceIds: sourceCompanies.filter((c) => c.id !== targetId).map((c) => c.id),
        }),
      });
    } catch {}
  }

  try {
    // 1. Update target company doc in Firestore
    const targetRef = doc(db, COMPANIES_COLLECTION, targetId);
    await setDoc(
      targetRef,
      {
        id: targetId,
        name: targetName.trim(),
        aliases: mergedAliases,
        priceListYear,
        contractorOfficer: contractorOfficer.trim(),
        discountPercentage,
        updatedAt: serverTimestamp(),
        updatedBy: userEmail || 'user_merge',
      },
      { merge: true }
    );

    // 2. Delete source companies from Firestore (except target)
    for (const comp of sourceCompanies) {
      if (comp.id !== targetId) {
        const srcRef = doc(db, COMPANIES_COLLECTION, comp.id);
        await deleteDoc(srcRef);
      }
    }

    // 3. Cascade update to inpatient_approvals in Firestore
    const namesToReplace = new Set(sourceCompanies.map((c) => c.name.trim().toLowerCase()));
    const approvalsCol = collection(db, APPROVALS_COLLECTION);
    const snap = await getDocs(query(approvalsCol, limit(500)));
    const batch = writeBatch(db);
    let count = 0;

    snap.docs.forEach((d) => {
      const data = d.data();
      const rawNorm = (data.contractorNormalized || data.contractorRaw || '').trim().toLowerCase();
      if (namesToReplace.has(rawNorm)) {
        batch.update(d.ref, {
          contractorNormalized: targetName.trim(),
          contractorOfficer: contractorOfficer.trim(),
          priceListYear,
        });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
    }
  } catch (err) {
    console.error('Failed to merge companies in Firestore:', err);
    throw err;
  }
}

/**
 * Manually triggers an immediate synchronization of the Outlook / Exchange InApprovals folder.
 */
export async function triggerManualApprovalsSync(): Promise<{ success: boolean; message: string }> {
  // 1. If local environment, trigger the watcher HTTP endpoint
  if (isLocalEnvironment()) {
    try {
      const res = await fetch('/api/approvals/sync', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        return { success: true, message: data.message || 'Sync triggered successfully' };
      }
    } catch {}
  }

  // 2. Also signal via Firestore automation settings doc
  try {
    const docRef = doc(db, SETTINGS_COLLECTION, AUTOMATION_SETTINGS_DOC);
    await setDoc(
      docRef,
      {
        triggerSync: serverTimestamp(),
        lastManualSyncTrigger: serverTimestamp(),
      },
      { merge: true }
    );
    return { success: true, message: 'Sync command broadcast to background watcher' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Sync failed' };
  }
}


/**
 * Subscribes to global automation settings (pause/resume).
 */
export function subscribeToAutomationSettings(
  onUpdate: (settings: AutomationSettings) => void,
  onError?: (err: Error) => void
): () => void {
  let isSubscribed = true;

  // Fast hydration on mount if local
  if (isLocalEnvironment()) {
    fetch('/api/settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.isPaused === 'boolean' && isSubscribed) {
          onUpdate(data);
        }
      })
      .catch(() => {});
  }

  const docRef = doc(db, SETTINGS_COLLECTION, AUTOMATION_SETTINGS_DOC);

  const unsubFirestore = onSnapshot(
    docRef,
    (docSnap) => {
      if (docSnap.exists() && isSubscribed) {
        onUpdate(docSnap.data() as AutomationSettings);
      }
    },
    (error) => {
      onError?.(error);
    }
  );

  return () => {
    isSubscribed = false;
    unsubFirestore();
  };
}

/**
 * Toggles the pause status of the background automation.
 */
export async function setAutomationPaused(isPaused: boolean, userEmail?: string): Promise<void> {
  if (isLocalEnvironment()) {
    try {
      await fetch('/api/settings/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPaused }),
      });
    } catch {}
  }

  try {
    const docRef = doc(db, SETTINGS_COLLECTION, AUTOMATION_SETTINGS_DOC);
    await setDoc(
      docRef,
      {
        isPaused,
        pausedAt: isPaused ? serverTimestamp() : null,
        pausedBy: userEmail || 'user',
      },
      { merge: true }
    );
  } catch {}
}

/**
 * Seed initial company configurations if the collection is currently empty.
 */
export async function seedInitialCompaniesIfEmpty(seedCompanies: CompanyInfo[]): Promise<void> {
  if (!seedCompanies || seedCompanies.length === 0) return;

  try {
    const colRef = collection(db, COMPANIES_COLLECTION);
    const existing = await getDocs(query(colRef, limit(1)));
    if (!existing.empty) {
      return; // Already populated
    }

    const chunkSize = 400;
    for (let i = 0; i < seedCompanies.length; i += chunkSize) {
      const chunk = seedCompanies.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      for (const c of chunk) {
        const docId = c.id || c.name.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_');
        const docRef = doc(db, COMPANIES_COLLECTION, docId);
        batch.set(docRef, {
          id: docId,
          name: c.name,
          aliases: c.aliases || [c.name],
          priceListYear: c.priceListYear || '2025',
          contractorOfficer: c.responsiblePerson || c.contractorOfficer || 'محمد ابو الوفا',
          discountPercentage: c.discount || 0,
          updatedAt: serverTimestamp(),
          updatedBy: 'seed_init',
        });
      }
      await batch.commit();
    }
    console.log(`Seeded all ${seedCompanies.length} initial company configs to Firestore.`);
  } catch (err) {
    console.warn('Skipping initial company seeding (rules or offline):', err);
  }
}
