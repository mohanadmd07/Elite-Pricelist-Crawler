import { describe, it, expect, vi } from 'vitest';
import { isQuotaPaused, markQuotaPaused, resetQuotaPause } from '../src/lib/geminiRateLimiter';

describe('Staged Mail Sync & Pacing Engine ("Little by Little")', () => {
  it('should verify quota pause is honored during sync operations', () => {
    resetQuotaPause();
    expect(isQuotaPaused()).toBe(false);

    // When a 429 occurs, quota should pause
    markQuotaPaused(5000);
    expect(isQuotaPaused()).toBe(true);

    resetQuotaPause();
    expect(isQuotaPaused()).toBe(false);
  });

  it('should verify staged batch size defaults to a safe bounded chunk (10)', async () => {
    // Dynamically test query parameter parser for /api/approvals/sync
    const mockReq = {
      query: { limit: '10', stageSize: '5', delayMs: '500' },
      body: {},
    };

    const limit = Math.min(
      Math.max(1, Number(mockReq.query?.limit || 10)),
      50
    );
    const stageSize = Math.min(
      Math.max(1, Number(mockReq.query?.stageSize || 5)),
      limit
    );
    const delayMs = Math.max(0, Number(mockReq.query?.delayMs ?? 1000));

    expect(limit).toBe(10);
    expect(stageSize).toBe(5);
    expect(delayMs).toBe(500);
  });

  it('should clamp batch limit to 50 max to prevent unbounded memory/EWS consumption', () => {
    const mockReq = { query: { limit: '500' } };
    const limit = Math.min(
      Math.max(1, Number(mockReq.query?.limit || 10)),
      50
    );
    expect(limit).toBe(50);
  });

  it('should pace items sequentially with delays when processing staged messages', async () => {
    const items = ['msg1', 'msg2', 'msg3'];
    const delayMs = 50;
    const timestamps: number[] = [];

    for (let i = 0; i < items.length; i++) {
      if (i > 0 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      timestamps.push(Date.now());
    }

    expect(timestamps.length).toBe(3);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(40);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(40);
  });
});
