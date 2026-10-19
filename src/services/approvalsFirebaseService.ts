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

  // 1. Fetch immediately and poll local watcher API
  const fetchFromApi = async () => {
    try {
      const res = await fetch('/api/approvals');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && isSubscribed) {
          onUpdate(data);
        }
      }
    } catch {}
  };

  let pollInterval: any = null;
  if (isLocalEnvironment()) {
    fetchFromApi();
    pollInterval = setInterval(fetchFromApi, 3000);
  }

  // 2. Also listen to Firestore real-time snapshot
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

      if (records.length > 0 && isSubscribed) {
        onUpdate(records);
      }
    },
    (error) => {
      onError?.(error);
    }
  );

  return () => {
    isSubscribed = false;
    if (pollInterval) clearInterval(pollInterval);
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
  if (isLocalEnvironment()) {
    try {
      await fetch(`/api/approvals/${id}/draft`, { method: 'POST' });
    } catch {}
  }

  try {
    const docRef = doc(db, APPROVALS_COLLECTION, id);
    await updateDoc(docRef, {
      status: 'draft_created',
      manualDraftRequested: true,
      draftedAt: serverTimestamp(),
    });
  } catch {}
}

/**
 * Subscribes to real-time company/contractor configurations.
 */
export function subscribeToCompanyConfigs(
  onUpdate: (companies: CompanyConfigRecord[]) => void,
  onError?: (err: Error) => void
): () => void {
  let isSubscribed = true;

  const fetchFromApi = async () => {
    try {
      const res = await fetch('/api/contractors');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0 && isSubscribed) {
          onUpdate(data);
        }
      }
    } catch {}
  };

  let pollInterval: any = null;
  if (isLocalEnvironment()) {
    fetchFromApi();
    pollInterval = setInterval(fetchFromApi, 4000);
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
      if (companies.length > 0 && isSubscribed) {
        onUpdate(companies);
      }
    },
    (error) => {
      onError?.(error);
    }
  );

  return () => {
    isSubscribed = false;
    if (pollInterval) clearInterval(pollInterval);
    unsubFirestore();
  };
}

/**
 * Saves or updates a company configuration in Firestore.
 */
export async function saveCompanyConfig(
  company: Partial<CompanyConfigRecord> & { name: string; priceListYear: string; contractorOfficer: string },
  userEmail?: string
): Promise<string> {
  const docId = company.id || company.name.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_');

  if (isLocalEnvironment()) {
    try {
      await fetch('/api/contractors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...company, id: docId }),
      });
    } catch {}
  }

  try {
    const docRef = doc(db, COMPANIES_COLLECTION, docId);
    const data: Partial<CompanyConfigRecord> = {
      id: docId,
      name: company.name.trim(),
      aliases: company.aliases || [company.name.trim()],
      priceListYear: company.priceListYear || '2025',
      contractorOfficer: company.contractorOfficer.trim(),
      discountPercentage: company.discountPercentage || 0,
      updatedAt: serverTimestamp(),
      updatedBy: userEmail || 'system',
    };
    await setDoc(docRef, data, { merge: true });
  } catch {}

  return docId;
}

/**
 * Deletes a company configuration from Firestore.
 */
export async function deleteCompanyConfig(id: string): Promise<void> {
  const docRef = doc(db, COMPANIES_COLLECTION, id);
  await deleteDoc(docRef);
}

/**
 * Subscribes to global automation settings (pause/resume).
 */
export function subscribeToAutomationSettings(
  onUpdate: (settings: AutomationSettings) => void,
  onError?: (err: Error) => void
): () => void {
  let isSubscribed = true;

  const fetchFromApi = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.isPaused === 'boolean' && isSubscribed) {
          onUpdate(data);
        }
      }
    } catch {}
  };

  let pollInterval: any = null;
  if (isLocalEnvironment()) {
    fetchFromApi();
    pollInterval = setInterval(fetchFromApi, 3000);
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
    if (pollInterval) clearInterval(pollInterval);
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

    const batch = writeBatch(db);
    for (const c of seedCompanies.slice(0, 50)) {
      const docId = c.name.trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_');
      const docRef = doc(db, COMPANIES_COLLECTION, docId);
      batch.set(docRef, {
        id: docId,
        name: c.name,
        aliases: [c.name],
        priceListYear: c.priceListYear || '2025',
        contractorOfficer: c.responsiblePerson || 'محمد ابو الوفا',
        discountPercentage: c.discount || 0,
        updatedAt: serverTimestamp(),
        updatedBy: 'seed_init',
      });
    }
    await batch.commit();
    console.log('Seeded initial company configs to Firestore.');
  } catch (err) {
    console.warn('Skipping initial company seeding (rules or offline):', err);
  }
}
