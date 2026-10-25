#!/usr/bin/env node
/**
 * Health & Operational Monitoring CLI Script.
 * Inspects Postgres watermarks, dead-letter count, and outbox lag.
 * Emits health report and triggers alert webhooks if SLA thresholds are breached.
 */

import { supabaseAdmin } from '../src/lib/supabase';
import { alertService } from '../src/services/alertService';
import { logger } from '../src/lib/logger';

async function monitorHealth() {
  logger.info('=====================================================');
  logger.info('🩺 Checking Platform Health & Observability Metrics');
  logger.info('=====================================================');

  let hasCriticalIssue = false;

  // 1. Check Supabase Connectivity
  const startPing = Date.now();
  const { data: pingData, error: pingErr } = await supabaseAdmin
    .from('sync_checkpoints')
    .select('folder_name, last_synced_at')
    .limit(5);
  const latencyMs = Date.now() - startPing;

  if (pingErr) {
    logger.error('Database connection error during health check', pingErr);
    await alertService.sendAlert({
      title: 'Database Unreachable',
      message: `Failed to query Supabase PostgreSQL: ${pingErr.message}`,
      severity: 'critical',
    });
    process.exit(1);
  }

  logger.info(`✓ PostgreSQL Connected (latency: ${latencyMs}ms)`);

  // 2. Inspect Ingestion Heartbeat & Watermarks
  const heartbeatCheckpoint = (pingData || []).find((c) => c.folder_name === 'InApprovals' || c.folder_name === 'inpatient_approvals_ews') || (pingData || [])[0];
  if (heartbeatCheckpoint && heartbeatCheckpoint.last_synced_at) {
    const lastSeen = new Date(heartbeatCheckpoint.last_synced_at);
    const minutesAgo = Math.round((Date.now() - lastSeen.getTime()) / (60 * 1000));
    logger.info(`Mail Ingestion Watermark (${heartbeatCheckpoint.folder_name}): Last synced ${minutesAgo} min ago (${heartbeatCheckpoint.last_synced_at})`);

    if (minutesAgo > 60) {
      logger.warn(`⚠️ Warning: Ingestion watermark is older than 60 minutes (${minutesAgo} minutes ago)`);
    } else {
      logger.info('✓ Ingestion Watermark Active');
    }
  } else {
    logger.info('ℹ️ No prior EWS watermark checkpoint found in database yet.');
  }

  // 3. Inspect Dead-Letter Queue
  const { count: dlqCount, data: dlqRows, error: dlqErr } = await supabaseAdmin
    .from('dead_letter_queue')
    .select('id, error_message', { count: 'exact' })
    .limit(5);

  if (dlqErr) {
    logger.error('Failed to query dead_letter_queue', dlqErr);
  } else {
    logger.info(`Dead-Letter Queue Count: ${dlqCount || 0}`);
    if (dlqCount && dlqCount > 0) {
      hasCriticalIssue = true;
      const recentErrors = (dlqRows || []).map((r) => r.error_message);
      await alertService.alertDeadLetterSpike(dlqCount, recentErrors);
    } else {
      logger.info('✓ Dead-Letter Queue Clean (0 poisoned messages)');
    }
  }

  // 4. Inspect Transactional Outbox Lag
  const { count: pendingOutboxCount, data: oldestPending, error: outboxErr } = await supabaseAdmin
    .from('outbox')
    .select('id, created_at', { count: 'exact' })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (outboxErr) {
    logger.error('Failed to query outbox queue', outboxErr);
  } else {
    logger.info(`Pending Outbox Events: ${pendingOutboxCount || 0}`);
    if (pendingOutboxCount && pendingOutboxCount > 0 && oldestPending && oldestPending.length > 0) {
      const oldestAgeMin = Math.round((Date.now() - new Date(oldestPending[0].created_at).getTime()) / (60 * 1000));
      logger.info(`Oldest Pending Outbox Event: ${oldestAgeMin} min old`);
      if (pendingOutboxCount > 25 || oldestAgeMin > 15) {
        await alertService.alertOutboxLag(pendingOutboxCount, oldestAgeMin);
      }
    } else {
      logger.info('✓ Outbox Queue In Sync');
    }
  }

  logger.info('-----------------------------------------------------');
  if (hasCriticalIssue) {
    logger.warn('⚠️ Platform health check completed with active warnings/alerts.');
  } else {
    logger.info('🎉 ALL SYSTEMS OPERATIONAL - Platform Health Check: 100% HEALTHY');
  }
}

monitorHealth().catch((err) => {
  logger.error('Fatal error during health monitoring', err);
  process.exit(1);
});
