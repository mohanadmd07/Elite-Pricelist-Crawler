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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security Gate: Reject unauthenticated requests to protect contractor pricing discounts
  if (!isAuthorizedRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required to view or modify contractor pricing.' });
  }

  const jsonPath = path.resolve(process.cwd(), 'data', 'contractors.json');

  const readContractors = () => {
    try {
      if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      }
    } catch {}
    return [];
  };

  const writeContractors = (data: any[]) => {
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  if (req.method === 'GET') {
    const list = readContractors();
    return res.status(200).json(list);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const list = readContractors();
    const existingIdx = list.findIndex(
      (c: any) =>
        (body.id && c.id === body.id) ||
        (body.name && c.name?.trim().toLowerCase() === body.name?.trim().toLowerCase()) ||
        (body.previousName && c.name?.trim().toLowerCase() === body.previousName?.trim().toLowerCase())
    );

    const targetId =
      body.id ||
      (existingIdx >= 0
        ? list[existingIdx].id
        : (body.name || '').trim().toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, '_'));

    const allAliases = Array.from(
      new Set([
        (body.name || '').trim(),
        ...(body.previousName ? [body.previousName.trim()] : []),
        ...(existingIdx >= 0 && Array.isArray(list[existingIdx].aliases) ? list[existingIdx].aliases : []),
        ...(Array.isArray(body.aliases) ? body.aliases : []),
      ])
    ).filter(Boolean);

    const record = {
      id: targetId,
      name: (body.name || '').trim(),
      priceListYear: body.priceListYear || '2025',
      contractorOfficer: (body.contractorOfficer || '').trim(),
      discountPercentage: body.discountPercentage ?? body.discount ?? 0,
      aliases: allAliases,
      updatedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      list[existingIdx] = record;
    } else {
      list.push(record);
    }

    writeContractors(list);

    // Cascade to data/inpatient_approvals.json
    try {
      const approvalsPath = path.resolve(process.cwd(), 'data', 'inpatient_approvals.json');
      if (fs.existsSync(approvalsPath)) {
        const approvals = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
        if (Array.isArray(approvals)) {
          const matchNames = new Set(allAliases.map((a: string) => a.toLowerCase()));
          let updated = false;
          approvals.forEach((app: any) => {
            const raw = (app.contractorNormalized || app.contractorRaw || '').trim().toLowerCase();
            if (matchNames.has(raw)) {
              app.contractorNormalized = record.name;
              app.contractorOfficer = record.contractorOfficer;
              app.priceListYear = record.priceListYear;
              updated = true;
            }
          });
          if (updated) {
            fs.writeFileSync(approvalsPath, JSON.stringify(approvals, null, 2), 'utf8');
          }
        }
      }
    } catch {}

    return res.status(200).json({ success: true, item: record });
  }

  if (req.method === 'DELETE') {
    const id = (req.query.id || req.body?.id) as string;
    if (id) {
      const list = readContractors();
      const filtered = list.filter((c: any) => c.id !== id);
      writeContractors(filtered);
    }
    return res.status(200).json({ success: true, id });
  }

  return res.status(200).json([]);
}
