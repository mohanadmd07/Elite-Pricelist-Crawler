export class SyncOperationDeduplicator {
  private pending = new Map<string, Promise<any>>();
  private cache = new Map<string, { data: any; ts: number; ttl: number }>();
  async dedup<T>(key: string, op: () => Promise<T>, ttl = 10000): Promise<T> {
    const c = this.cache.get(key);
    if (c && Date.now() - c.ts < c.ttl) return c.data;
    if (this.pending.has(key)) return this.pending.get(key)!;
    const p = op().then(r => { this.pending.delete(key); this.cache.set(key, { data: r, ts: Date.now(), ttl }); return r; })
      .catch(e => { this.pending.delete(key); throw e; });
    this.pending.set(key, p); return p;
  }
}
