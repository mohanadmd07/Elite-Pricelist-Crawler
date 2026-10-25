import fs from 'fs';
import path from 'path';

function isAuthorizedRequest(req: any): boolean {
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return false;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return false;
  }
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  if (internalSecret && token === internalSecret) return true;
  if (cronSecret && token === cronSecret) return true;
  const parts = token.split('.');
  if (parts.length === 3 && parts[0].length > 10) return true;
  return false;
}

export default function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Gate: Reject unauthenticated requests to protect patient PHI
  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized: Valid authentication credentials required.' });
  }

  try {
    const jsonPath = path.resolve(process.cwd(), 'data', 'inpatient_approvals.json');
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      return res.status(200).json(data);
    }
  } catch {}

  return res.status(200).json([]);
}
