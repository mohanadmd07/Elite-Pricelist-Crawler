/**
 * Runs the golden-set evaluation (50+ anonymized threads) and the time-split
 * self-learning evaluation, asserting zero false approvals and zero status mutations by history.
 */
import { runGoldenSetEvaluation, runTimeSplitLearningEvaluation } from '../src/classifier/eval';

async function main() {
  const golden = await runGoldenSetEvaluation();
  const timeSplit = await runTimeSplitLearningEvaluation();

  console.log('=== Golden Set Evaluation ===');
  console.log(JSON.stringify(golden, null, 2));

  console.log('\n=== Time-Split Learning Evaluation (70% train / 30% test) ===');
  console.log(JSON.stringify(timeSplit, null, 2));

  if (golden.totalThreads < 50) {
    throw new Error(`Golden set must have >= 50 threads (got ${golden.totalThreads})`);
  }
  if (golden.falseApprovalCount !== 0 || golden.falseApprovalRate !== 0) {
    throw new Error(`False approvals detected: ${golden.falseApprovalCount}`);
  }
  if (golden.overallAccuracy < 0.95) {
    throw new Error(`Golden set overall accuracy ${golden.overallAccuracy} < 0.95`);
  }
  if (timeSplit.statusChangedByHistory !== 0) {
    throw new Error(`History mutated ${timeSplit.statusChangedByHistory} thread status(es)!`);
  }
  if (timeSplit.anomalyCatchRate < 1) {
    throw new Error(`Time-split anomaly catch rate ${timeSplit.anomalyCatchRate} < 1`);
  }
}

main().catch((err) => {
  console.error('[eval-golden-classifier] FAILED:', err);
  process.exit(1);
});
