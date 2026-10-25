/**
 * Web Worker Client Manager for Background Search Execution.
 */

import { ProcedureResult } from '../types';
import { searchLocalPricelist } from './procedureService';

let searchWorker: Worker | null = null;
const pendingRequests = new Map<string, (results: ProcedureResult[]) => void>();

function getWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  if (!searchWorker) {
    try {
      searchWorker = new Worker(new URL('../workers/search.worker.ts', import.meta.url), {
        type: 'module',
      });
      searchWorker.onmessage = (event: MessageEvent<{ id: string; results: ProcedureResult[] }>) => {
        const { id, results } = event.data;
        const resolver = pendingRequests.get(id);
        if (resolver) {
          resolver(results);
          pendingRequests.delete(id);
        }
      };
      searchWorker.onerror = (err) => {
        console.warn('[SearchWorker] Worker error; falling back to main thread:', err);
      };
    } catch (e) {
      console.warn('[SearchWorker] Failed to initialize worker:', e);
      searchWorker = null;
    }
  }
  return searchWorker;
}

export async function searchPricelistAsync(
  cashList: ProcedureResult[],
  requestedProcedures: { name: string; arabic?: string }[]
): Promise<ProcedureResult[]> {
  const worker = getWorker();
  if (!worker) {
    return searchLocalPricelist(cashList, requestedProcedures);
  }

  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    // Timeout fallback after 3 seconds
    const timeout = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        resolve(searchLocalPricelist(cashList, requestedProcedures));
      }
    }, 3000);

    pendingRequests.set(id, (results) => {
      clearTimeout(timeout);
      resolve(results);
    });

    worker.postMessage({ id, cashList, requestedProcedures });
  });
}
