export type BreakerState = 'closed' | 'open' | 'half-open';

export class SyncCircuitBreaker {
  failures = 0;
  lastFailure = 0;
  state: BreakerState = 'closed';

  constructor(private readonly threshold = 5, private readonly timeoutMs = 30000) {}

  get isOpen(): boolean { return this.state === 'open'; }
  get cooldownRemaining(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.timeoutMs - (Date.now() - this.lastFailure));
  }

  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure >= this.timeoutMs) {
        this.state = 'half-open';
        this.failures = 0;
      } else {
        throw new Error(`Sync circuit open; retry in ${Math.ceil(this.cooldownRemaining / 1000)}s`);
      }
    }
    try { const r = await operation(); this.onSuccess(); return r; }
    catch (e) { this.onFailure(); throw e; }
  }

  onSuccess(): void { this.failures = 0; this.state = 'closed'; }

  onFailure(): void {
    if (this.state === 'open' && Date.now() - this.lastFailure >= this.timeoutMs) {
      this.state = 'half-open'; this.failures = 0;
    }
    this.failures += 1; this.lastFailure = Date.now();
    if (this.failures >= this.threshold) this.state = 'open';
  }

  reset(): void { this.failures = 0; this.lastFailure = 0; this.state = 'closed'; }
}
