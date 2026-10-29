/**
 * Manual / Local CLI Trigger for Inpatient Approvals Mail Sync
 * Usage: npx tsx scripts/sync-now.ts [--folder InApprovals] [--limit 50]
 */

import 'dotenv/config';
import { runMailSync } from '../src/mail/syncEngine';

async function main() {
  console.log('=====================================================');
  console.log('🚀 Triggering Manual EWS Approvals Sync');
  console.log('=====================================================\n');

  const args = process.argv.slice(2);
  let folder = process.env.EWS_FOLDER || 'InApprovals';
  let limit = 10;
  let delay = 1000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--folder' && args[i + 1]) {
      folder = args[i + 1];
    }
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
    }
    if (args[i] === '--delay' && args[i + 1]) {
      delay = parseInt(args[i + 1], 10);
    }
  }

  console.log(`Config: Folder="${folder}", BatchLimit=${limit}, DelayBetweenItems=${delay}ms`);
  const result = await runMailSync({ folderName: folder, batchLimit: limit, delayBetweenItemsMs: delay });

  console.log('\n-----------------------------------------------------');
  console.log('📊 Sync Results:');
  console.log(`  Success:            ${result.success ? '✅ Yes' : '❌ No'}`);
  console.log(`  Messages Fetched:   ${result.messagesFetched}`);
  console.log(`  Messages Processed: ${result.messagesProcessed}`);
  console.log(`  Messages Skipped:   ${result.messagesSkipped} (already in DB)`);
  console.log(`  Attachments Saved:  ${result.attachmentsSaved}`);
  console.log(`  Duration:           ${result.durationMs}ms`);
  if (result.error) {
    console.log(`  Error:              ${result.error}`);
  }
  console.log('=====================================================\n');

  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal CLI error:', err);
  process.exit(1);
});
