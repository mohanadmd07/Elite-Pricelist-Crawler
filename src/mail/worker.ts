/**
 * Standalone Containerized Mail Ingestion Worker
 * Exposes /health endpoint for container orchestrators (Render, Railway, Fly.io, Docker).
 * Runs periodic sync loop on a configurable interval.
 */

import http from 'http';
import { runMailSync } from './syncEngine';
import { loadCursorFromPostgres } from './storage/cursorManager';

const PORT = parseInt(process.env.PORT || '8080', 10);
const INTERVAL_MINUTES = parseInt(process.env.SYNC_INTERVAL_MINUTES || '20', 10);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

let isSyncRunning = false;
let lastSyncTimestamp: string | null = null;
let lastSyncStats: any = null;
let isHealthy = true;

/**
 * Executes a sync run and updates health metrics.
 */
async function performScheduledSync() {
  if (isSyncRunning) {
    console.log('[Worker] Sync is already in progress; skipping tick.');
    return;
  }

  isSyncRunning = true;
  console.log(`[Worker] ⏰ Starting scheduled sync cycle (every ${INTERVAL_MINUTES}m)...`);

  try {
    const stats = await runMailSync();
    lastSyncTimestamp = new Date().toISOString();
    lastSyncStats = stats;
    isHealthy = stats.success;
    console.log(`[Worker] Cycle complete: processed=${stats.messagesProcessed}, fetched=${stats.messagesFetched}, duration=${stats.durationMs}ms`);
  } catch (err: any) {
    console.error('[Worker] Fatal error during sync cycle:', err);
    isHealthy = false;
  } finally {
    isSyncRunning = false;
  }
}

/**
 * Lightweight HTTP server for container health checks.
 */
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const watermark = await loadCursorFromPostgres().catch(() => null);
    const status = {
      status: isHealthy ? 'healthy' : 'degraded',
      uptimeSeconds: Math.floor(process.uptime()),
      lastSyncTimestamp,
      intervalMinutes: INTERVAL_MINUTES,
      isSyncRunning,
      lastSyncStats,
      watermarkToken: watermark?.token ? 'present' : 'none',
      lastWatermarkSync: watermark?.lastSyncedAt,
      timestamp: new Date().toISOString(),
    };

    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (req.url === '/sync-now' && req.method === 'POST') {
    performScheduledSync();
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Sync cycle triggered' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[Worker] 🚀 Cloud Mail Worker running on port ${PORT}`);
  console.log(`[Worker] 🩺 Health endpoint listening on http://0.0.0.0:${PORT}/health`);

  // Initial sync on startup
  performScheduledSync();

  // Recurring loop
  setInterval(performScheduledSync, INTERVAL_MS);
});

// Graceful termination
process.on('SIGTERM', () => {
  console.log('[Worker] SIGTERM received. Closing HTTP server...');
  server.close(() => {
    process.exit(0);
  });
});
