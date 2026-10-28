/**
 * Section F4: Daily recomputation of `insurer_procedure_stats` from `approval_outcomes`
 * with configurable recency window (default 24 months) and exponential decay (half-life 6 months).
 *
 * Compatible with Vercel Hobby daily cron or CLI:
 *   npx tsx .agent/skills/approval-reply-classifier/scripts/recompute-stats.ts
 */
import { isSupabaseAdminConfigured } from '../../../../src/lib/supabase';
import {
  InMemoryLearningStore,
  recomputeAllStats,
  type LearningStore,
  type StatsOptions,
} from '../../../../src/classifier/learning/store';
import { SupabaseLearningStore } from '../../../../src/classifier/learning/supabaseStore';

export async function runRecomputeStats(
  store?: LearningStore,
  opts?: StatsOptions
): Promise<{ pairsUpdated: number }> {
  const activeStore =
    store ?? (isSupabaseAdminConfigured() ? new SupabaseLearningStore() : new InMemoryLearningStore());
  const pairsUpdated = await recomputeAllStats(activeStore, opts);
  return { pairsUpdated };
}

const isCli = process.argv[1]?.endsWith('recompute-stats.ts');
if (isCli) {
  runRecomputeStats()
    .then((r) => console.log(`[recompute-stats] Recomputed stats for ${r.pairsUpdated} (insurer, procedure) pairs.`))
    .catch((err) => {
      console.error('[recompute-stats] Failed:', err);
      process.exit(1);
    });
}
