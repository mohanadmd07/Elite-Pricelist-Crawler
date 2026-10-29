/**
 * Gemini Rate Limiter & Resilience Manager
 * 
 * Provides exponential backoff with jitter for transient 429 (Too Many Requests / RESOURCE_EXHAUSTED)
 * rate-limit responses, multi-model cascading, and circuit-breaking quota pause tracking.
 */

let quotaPausedUntil = 0;

/**
 * Checks if Gemini quota is currently paused due to recent 429 errors.
 */
export function isQuotaPaused(): boolean {
  return Date.now() < quotaPausedUntil;
}

/**
 * Marks Gemini quota as temporarily paused.
 */
export function markQuotaPaused(durationMs = 30000): void {
  quotaPausedUntil = Math.max(quotaPausedUntil, Date.now() + durationMs);
}

/**
 * Resets the quota pause tracker (e.g. after manual user key update).
 */
export function resetQuotaPause(): void {
  quotaPausedUntil = 0;
}

/**
 * Ordered list of Gemini models prioritized for stability and high quota throughput.
 * gemini-2.0-flash is prioritized for fast response times and generous RPM limits,
 * followed by gemini-2.5-flash and established gemini-1.5-flash fallbacks.
 */
export const RECOMMENDED_GEMINI_MODELS = [
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-2.5-flash-lite',
] as const;

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

/**
 * Executes an asynchronous Gemini API operation with automatic exponential backoff on 429.
 */
export async function executeWithRateLimitRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2;
  const initialDelay = options.initialDelayMs ?? 800;
  const factor = options.backoffFactor ?? 2;

  let lastError: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(attempt);
    } catch (err: any) {
      lastError = err;
      const msg = (err?.message || String(err)).toLowerCase();

      const isRateLimit =
        msg.includes('429') ||
        msg.includes('resource_exhausted') ||
        msg.includes('rate limit') ||
        msg.includes('quota');

      if (!isRateLimit || attempt === maxRetries) {
        if (isRateLimit) {
          markQuotaPaused(45000); // Pause quota for 45 seconds on exhausted retries
        }
        throw err;
      }

      // Calculate jittered exponential backoff
      const baseDelay = initialDelay * Math.pow(factor, attempt);
      const jitter = Math.random() * 200;
      const delayMs = baseDelay + jitter;

      console.warn(`[Gemini Rate Limiter] 429 detected, retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
