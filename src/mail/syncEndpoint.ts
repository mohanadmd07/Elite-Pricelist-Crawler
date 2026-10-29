import { runMailSync } from './syncEngine';

function isAuthorizedRequest(req: any): boolean {
  const host = req.headers?.host || '';
  if (host.includes('localhost') || host.includes('127.0.0.1')) return true;
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  if (process.env.INTERNAL_API_SECRET && token === process.env.INTERNAL_API_SECRET) return true;
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
  const parts = token.split('.');
  if (parts.length === 3 && parts[0].length > 10) return true;
  return false;
}

export default async function handler(req: any, res: any) {
  const origin = req.headers?.origin;
  if (origin && (origin.includes('elitehospital.org') || origin.includes('localhost') || origin.includes('vercel.app'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized: Valid Bearer token or CRON_SECRET required.' });
  }

  const limit = Math.min(
    Math.max(1, Number(req.query?.limit || req.query?.batchLimit || req.body?.limit) || 10),
    50
  );
  const stageSize = Math.min(
    Math.max(1, Number(req.query?.stageSize || req.body?.stageSize) || 5),
    limit
  );
  const delayMs = Math.max(
    0,
    Number(req.query?.delayMs ?? req.body?.delayMs ?? 1000)
  );

  console.log(`[EWS Sync] Starting staged mail synchronization (batchLimit: ${limit}, stageSize: ${stageSize}, delay: ${delayMs}ms)...`);
  try {
    const stats = await runMailSync({
      folderName: process.env.EWS_FOLDER || 'InApprovals',
      batchLimit: limit,
      stageSize,
      delayBetweenItemsMs: delayMs,
    });

    console.log(`[EWS Sync] Complete: success=${stats.success} fetched=${stats.messagesFetched} processed=${stats.messagesProcessed} skipped=${stats.messagesSkipped} duration=${stats.durationMs}ms`);

    return res.status(200).json({
      success: stats.success,
      messagesFetched: stats.messagesFetched,
      messagesProcessed: stats.messagesProcessed,
      messagesSkipped: stats.messagesSkipped,
      attachmentsSaved: stats.attachmentsSaved,
      durationMs: stats.durationMs,
      error: stats.error,
      timestamp: new Date().toISOString(),
      staged: true,
      batchLimit: limit,
      stageSize,
    });
  } catch (err: any) {
    console.error(`[EWS Sync] Error during sync:`, err);
    return res.status(500).json({
      success: false,
      error: err.message || String(err),
    });
  }
}
