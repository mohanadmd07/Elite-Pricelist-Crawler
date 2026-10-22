import { SyncCircuitBreaker, SyncOperationDeduplicator } from '../src/utils';

/**
 * Reproduces the exact pattern used in App.tsx:
 *   breaker.call(() => Promise.resolve(onSnapshot(q, onNext, onError)))
 * where onError throws asynchronously.
 */

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
}

async function main() {
  console.log('\n=== TEST 1: async error callback does NOT propagate to breaker (the bug) ===');
  {
    const breaker = new SyncCircuitBreaker(3, 60000);
    let caught = 0;

    // Simulate onSnapshot: error callback fires LATER (async), like Firestore does.
    const fakeOnSnapshot = (_q: any, _next: any, onError: any) => {
      setTimeout(() => { try { onError(new Error('firestore down')); } catch { /* swallowed */ } }, 5);
      return () => {};
    };

    try {
      await breaker.call(() => Promise.resolve(fakeOnSnapshot(null, () => {}, (e: Error) => { throw e; })));
    } catch { caught++; }

    check('breaker.call did NOT reject (error escaped the promise chain)', caught === 0);
    check('breaker recorded FAILURE (failures > 0)', breaker.failures > 0, `failures=${breaker.failures}`);
    check('breaker.state is NOT open (circuit never trips)', breaker.state !== 'open', `state=${breaker.state}`);
    console.log('  (expected: the OLD pattern is broken -> this is the bug that was fixed)');
  }

  console.log('\n=== TEST 1b: FIXED PATTERN - direct onFailure() records the failure ===');
  {
    const breaker = new SyncCircuitBreaker(3, 60000);
    const fakeOnSnapshot = (_q: any, _next: any, onError: any) => {
      setTimeout(() => { try { onError(new Error('firestore down')); } catch {} }, 5);
      return () => {};
    };
    // The fix: error handler calls breaker.onFailure() directly instead of throwing.
    fakeOnSnapshot(null, () => {}, () => { breaker.onFailure(); });
    await new Promise(r => setTimeout(r, 30));
    check('breaker recorded FAILURE', breaker.failures === 1, `failures=${breaker.failures}`);
    check('circuit opens after threshold reached', (() => {
      const b2 = new SyncCircuitBreaker(3, 60000);
      b2.onFailure(); b2.onFailure(); b2.onFailure();
      return b2.state === 'open';
    })());
  }

  console.log('\n=== TEST 2: synchronous throw inside breaker.call IS caught ===');
  {
    const breaker = new SyncCircuitBreaker(3, 60000);
    let caught = 0;
    for (let i = 0; i < 3; i++) {
      try { await breaker.call(async () => { throw new Error('boom'); }); } catch { caught++; }
    }
    check('all 3 attempts rejected', caught === 3, `caught=${caught}`);
    check('breaker.state === open after threshold', breaker.state === 'open', `state=${breaker.state}`);
    check('breaker.failures === 3', breaker.failures === 3, `failures=${breaker.failures}`);
  }

  console.log('\n=== TEST 3: half-open recovery after cooldown ===');
  {
    const breaker = new SyncCircuitBreaker(1, 50);
    try { await breaker.call(async () => { throw new Error('x'); }); } catch {}
    check('state open after 1 failure', breaker.state === 'open', `state=${breaker.state}`);
    await new Promise(r => setTimeout(r, 80));
    const ok = await breaker.call(async () => 'recovered');
    check('half-open allows one probe', ok === 'recovered');
    check('state closed after successful probe', breaker.state === 'closed', `state=${breaker.state}`);
    check('failures reset to 0', breaker.failures === 0, `failures=${breaker.failures}`);
  }

  console.log('\n=== TEST 4: circuit blocks calls while open ===');
  {
    const breaker = new SyncCircuitBreaker(1, 60000);
    try { await breaker.call(async () => { throw new Error('x'); }); } catch {}
    let blocked = false;
    try { await breaker.call(async () => 'should not run'); } catch { blocked = true; }
    check('call rejected while circuit open', blocked);
  }

  console.log('\n=== TEST 5: deduplicator collapses concurrent calls ===');
  {
    const dedup = new SyncOperationDeduplicator();
    let execCount = 0;
    const op = async () => { execCount++; await new Promise(r => setTimeout(r, 20)); return 'value'; };
    const [a, b, c] = await Promise.all([
      dedup.dedup('key1', op),
      dedup.dedup('key1', op),
      dedup.dedup('key1', op),
    ]);
    check('operation executed only ONCE', execCount === 1, `execCount=${execCount}`);
    check('all callers get same result', a === b && b === c && a === 'value');
  }

  console.log('\n=== TEST 6: deduplicator serves from cache within TTL ===');
  {
    const dedup = new SyncOperationDeduplicator();
    let execCount = 0;
    const op = async () => { execCount++; return 'v'; };
    await dedup.dedup('key2', op, 10000);
    await dedup.dedup('key2', op, 10000);
    check('cached result avoids re-execution', execCount === 1, `execCount=${execCount}`);
  }

  console.log('\n=== TEST 7: deduplicator releases pending slot on error ===');
  {
    const dedup = new SyncOperationDeduplicator();
    let execCount = 0;
    const failing = async () => { execCount++; throw new Error('fail'); };
    try { await dedup.dedup('key3', failing); } catch {}
    try { await dedup.dedup('key3', failing); } catch {}
    check('failed op does not block retry', execCount === 2, `execCount=${execCount}`);
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
