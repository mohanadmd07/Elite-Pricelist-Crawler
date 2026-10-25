/**
 * Approvals Backfill CLI Tool
 * Allows resetting the EWS watermark token to re-ingest past approvals safely and idempotently.
 * Usage:
 *   npx tsx scripts/backfill-approvals.ts --reset-cursor
 *   npx tsx scripts/backfill-approvals.ts --limit 100
 */

import 'dotenv/config';
import { runMailSync } from '../src/mail/syncEngine';
import { saveCursorToPostgres } from '../src/mail/storage/cursorManager';

async function main() {
  console.log('=====================================================');
  console.log('🔄 Elite Hospital Approvals Backfill & Cursor Reset');
  console.log('=====================================================\n');

  const args = process.argv.slice(2);
  const shouldReset = args.includes('--reset-cursor');
  const folder = process.env.EWS_FOLDER || 'InApprovals';

  if (shouldReset) {
    console.log(`[Backfill] ⚠️ Resetting sync watermark in Postgres for folder "${folder}"...`);
    await saveCursorToPostgres({
      folderName: folder,
      token: undefined,
      lastSyncedAt: new Date(0).toISOString(),
      totalSyncedCount: 0,
    });
    console.log('[Backfill] ✓ Watermark successfully reset. Subsequent sync will ingest historical items.');
  }

  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1], 10) : 100;

  console.log(`[Backfill] Starting backfill run with limit=${limit}...`);
  const result = await runMailSync({ folderName: folder, batchLimit: limit });

  console.log('\n-----------------------------------------------------');
  console.log('📊 Backfill Ingestion Summary:');
  console.log(`  Success:            ${result.success ? '✅ Yes' : '❌ No'}`);
  console.log(`  Messages Fetched:   ${result.messagesFetched}`);
  console.log(`  New Records Added:  ${result.messagesProcessed}`);
  console.log(`  Duplicates Skipped: ${result.messagesSkipped}`);
  console.log(`  Duration:           ${result.durationMs}ms`);
  console.log('=====================================================\n');

  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal Backfill CLI error:', err);
  process.exit(1);
});
