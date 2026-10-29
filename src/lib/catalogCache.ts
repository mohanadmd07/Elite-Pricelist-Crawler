/**
 * High-Performance IndexedDB Offline Catalog Cache.
 * Persists yearly pricelist catalogs locally in the browser to eliminate network latency,
 * enable offline search, and reduce network egress.
 *
 * Freshness: catalogs are keyed by year AND content checksum. The pipeline export
 * writes a sidecar `<year>_cash.version.json` (crawler/pipelines/exporters.py);
 * on every load we HEAD-compare it against the stored checksum and serve stale data
 * only while that check is pending/inconclusive.
 */

import { ProcedureResult } from '../types';

const DB_NAME = 'ElitePricelistCache';
const DB_VERSION = 2;
const STORE_NAME = 'catalogs';

interface CachedCatalogRecord {
  year: string;
  timestamp: number;
  checksum: string | null;
  items: ProcedureResult[];
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'year' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('[IndexedDB] Failed to open database:', request.error);
        resolve(null);
      };
    } catch (e) {
      console.warn('[IndexedDB] Initialization exception:', e);
      resolve(null);
    }
  });
}

/**
 * Retrieves a cached catalog from IndexedDB.
 * Pass `remoteChecksum` (from the version sidecar) to enforce content-based
 * invalidation: a mismatch means the catalog was rebuilt and the cache is stale.
 */
export async function getCachedCatalog(
  year: string,
  remoteChecksum?: string | null,
): Promise<ProcedureResult[] | null> {
  const db = await openDatabase();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(year);

      req.onsuccess = () => {
        const record = req.result as CachedCatalogRecord | undefined;
        if (!record || !Array.isArray(record.items)) {
          resolve(null);
          return;
        }
        // Content-version invalidation: if we know the live checksum and it
        // differs from what we stored, the catalog was rebuilt — discard cache.
        if (remoteChecksum && record.checksum && record.checksum !== remoteChecksum) {
          resolve(null);
          return;
        }
        // Without a remote checksum, fall back to the 24-hour freshness window.
        if (!remoteChecksum) {
          const isFresh = Date.now() - record.timestamp < 24 * 60 * 60 * 1000;
          resolve(isFresh ? record.items : null);
          return;
        }
        resolve(record.items.length > 0 ? record.items : null);
      };

      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Persists a catalog to IndexedDB alongside its content checksum.
 */
export async function setCachedCatalog(
  year: string,
  items: ProcedureResult[],
  checksum?: string | null,
): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: CachedCatalogRecord = {
        year,
        timestamp: Date.now(),
        checksum: checksum ?? null,
        items,
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
