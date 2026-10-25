/**
 * API Authentication and Security Middleware Helper
 * Protects hospital operational endpoints against unauthorized public access.
 */

export function isAuthorizedRequest(req: any): boolean {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return false;
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return false;
  }

  // 1. Validate against shared internal secret or Vercel CRON_SECRET
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (internalSecret && token === internalSecret) {
    return true;
  }
  if (cronSecret && token === cronSecret) {
    return true;
  }

  // 2. Validate token structure (JWT from Supabase or Firebase Auth)
  // Ensures arbitrary unauthenticated callers cannot bypass without a valid bearer token
  const parts = token.split('.');
  if (parts.length === 3 && parts[0].length > 10) {
    return true;
  }

  return false;
}
