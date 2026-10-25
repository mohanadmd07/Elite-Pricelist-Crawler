/**
 * Procedure Override Service
 * Manages manual clinician and billing clerk matching overrides.
 * Reuses overrides as priority aliases and regression eval benchmarks.
 */

import { supabaseAdmin, supabase } from '../lib/supabase';
import { normalizeArabic, normalizeText } from '../lib/arabic-normalizer';

const client = supabaseAdmin || supabase;

export interface ProcedureOverrideRecord {
  id?: string;
  queryText: string;
  queryTextNormalized: string;
  chosenProcedureId?: string;
  chosenCode: string;
  chosenName: string;
  contractorName?: string;
  overriddenBy?: string;
  overriddenByEmail?: string;
  reason?: string;
  createdAt?: string;
}

// In-memory cache for fast lookup during hot loops
const overrideMemoryCache = new Map<string, ProcedureOverrideRecord>();

/**
 * Normalizes query string for override lookup.
 */
export function getNormalizedOverrideKey(query: string): string {
  return normalizeArabic(normalizeText(query));
}

/**
 * Retrieves a priority override for the given query if one exists in DB or memory cache.
 */
export async function getOverrideForQuery(query: string): Promise<ProcedureOverrideRecord | null> {
  const normKey = getNormalizedOverrideKey(query);
  if (!normKey) return null;

  if (overrideMemoryCache.has(normKey)) {
    return overrideMemoryCache.get(normKey)!;
  }

  if (!client) return null;

  try {
    const { data, error } = await client
      .from('procedure_overrides')
      .select('id, query_text, query_text_normalized, chosen_procedure_id, chosen_code, chosen_name, contractor_name, overridden_by, overridden_by_email, reason, created_at')
      .eq('query_text_normalized', normKey)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const record: ProcedureOverrideRecord = {
      id: data.id,
      queryText: data.query_text,
      queryTextNormalized: data.query_text_normalized,
      chosenProcedureId: data.chosen_procedure_id || undefined,
      chosenCode: data.chosen_code || '',
      chosenName: data.chosen_name,
      contractorName: data.contractor_name || undefined,
      overriddenBy: data.overridden_by || undefined,
      overriddenByEmail: data.overridden_by_email || undefined,
      reason: data.reason || undefined,
      createdAt: data.created_at,
    };

    overrideMemoryCache.set(normKey, record);
    return record;
  } catch (err) {
    console.warn(`[Override Service] Error fetching override for "${query}":`, err);
    return null;
  }
}

/**
 * Logs a manual override into PostgreSQL and writes an entry into audit_log.
 */
export async function logProcedureOverride(params: {
  query: string;
  chosenCode: string;
  chosenName: string;
  chosenProcedureId?: string;
  contractorName?: string;
  userId?: string;
  userEmail?: string;
  reason?: string;
}): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!client) {
    return { success: false, error: 'Database client not configured' };
  }

  const normKey = getNormalizedOverrideKey(params.query);

  try {
    // 1. Insert or update procedure override
    const { data, error } = await client
      .from('procedure_overrides')
      .insert({
        query_text: params.query,
        query_text_normalized: normKey,
        chosen_procedure_id: params.chosenProcedureId || null,
        chosen_code: params.chosenCode,
        chosen_name: params.chosenName,
        contractor_name: params.contractorName || null,
        overridden_by: params.userId || null,
        overridden_by_email: params.userEmail || null,
        reason: params.reason || 'Manual staff override',
      })
      .select('id')
      .single();

    if (error) {
      console.error('[Override Service] Insert error:', error.message);
      return { success: false, error: error.message };
    }

    // 2. Insert into append-only audit_log
    const { error: auditError } = await client.from('audit_log').insert({
      user_id: params.userId || null,
      user_email: params.userEmail || 'staff@elitehospital.org',
      action: 'PROCEDURE_OVERRIDE_SAVED',
      entity_type: 'procedure_override',
      entity_id: data.id,
      details: {
        query: params.query,
        queryNormalized: normKey,
        chosenCode: params.chosenCode,
        chosenName: params.chosenName,
        reason: params.reason,
      },
    });

    if (auditError) {
      console.warn('[Override Service] Audit log warning:', auditError.message);
    }

    // Update local cache
    overrideMemoryCache.set(normKey, {
      id: data.id,
      queryText: params.query,
      queryTextNormalized: normKey,
      chosenProcedureId: params.chosenProcedureId,
      chosenCode: params.chosenCode,
      chosenName: params.chosenName,
      contractorName: params.contractorName,
      reason: params.reason,
    });

    return { success: true, id: data.id };
  } catch (err: any) {
    console.error('[Override Service] Unexpected error logging override:', err);
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Loads all overrides for golden evaluation testing and CI verification.
 */
export async function loadAllOverridesForEval(): Promise<ProcedureOverrideRecord[]> {
  if (!client) return [];
  try {
    const { data, error } = await client
      .from('procedure_overrides')
      .select('query_text, query_text_normalized, chosen_code, chosen_name, reason')
      .order('created_at', { ascending: false });

    if (error || !data) return [];
    return data.map((d) => ({
      queryText: d.query_text,
      queryTextNormalized: d.query_text_normalized,
      chosenCode: d.chosen_code || '',
      chosenName: d.chosen_name,
      reason: d.reason || undefined,
    }));
  } catch {
    return [];
  }
}
