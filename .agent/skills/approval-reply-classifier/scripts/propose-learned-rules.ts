/**
 * Section F4/F6: Proposes learned rules (PRICELIST_SUGGESTION, DOCUMENT_REQUIREMENT, ALIAS)
 * with status = PROPOSED. Rules never take effect until promoted by a human and verified
 * against the golden set.
 *
 *   npx tsx .agent/skills/approval-reply-classifier/scripts/propose-learned-rules.ts
 */
import { isSupabaseAdminConfigured } from '../../../../src/lib/supabase';
import {
  InMemoryLearningStore,
  proposeRulesFromOutcomes,
  type LearningStore,
  type LearnedRuleRow,
} from '../../../../src/classifier/learning/store';
import { SupabaseLearningStore } from '../../../../src/classifier/learning/supabaseStore';

export async function runProposeLearnedRules(
  store?: LearningStore,
  minEvidence = 3
): Promise<LearnedRuleRow[]> {
  const activeStore =
    store ?? (isSupabaseAdminConfigured() ? new SupabaseLearningStore() : new InMemoryLearningStore());
  return proposeRulesFromOutcomes(activeStore, minEvidence);
}

const isCli = process.argv[1]?.endsWith('propose-learned-rules.ts');
if (isCli) {
  runProposeLearnedRules()
    .then((rules) => console.log(`[propose-learned-rules] Proposed ${rules.length} rule(s).`))
    .catch((err) => {
      console.error('[propose-learned-rules] Failed:', err);
      process.exit(1);
    });
}
