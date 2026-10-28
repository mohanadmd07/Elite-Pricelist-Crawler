/**
 * Supabase PostgreSQL implementation of LearningStore (server-side service role).
 * Falls back gracefully when Supabase is not configured in local/test environments.
 */
import { supabaseAdmin } from '../../lib/supabase';
import {
  assertNoPhi,
  insurerKey,
  type ApprovalOutcomeRow,
  type AuditEntry,
  type CorrectionRow,
  type FewShotPoolRow,
  type InsurerProcedureStatsRow,
  type LearningStore,
  type LearnedRuleRow,
  type RuleStatus,
  type RuleType,
} from './store';
import type { ItemCategory } from '../types';

export class SupabaseLearningStore implements LearningStore {
  private get db() {
    if (!supabaseAdmin) throw new Error('Supabase admin client is not configured');
    return supabaseAdmin;
  }

  async upsertOutcome(row: ApprovalOutcomeRow): Promise<void> {
    assertNoPhi(JSON.stringify(row));
    const { data: existing } = await this.db
      .from('approval_outcomes')
      .select('id, label_source')
      .eq('id', row.id)
      .maybeSingle();
    if (existing && existing.label_source === 'HUMAN_CONFIRMED' && row.label_source === 'AUTO_VERIFIED') return;
    const { error } = await this.db.from('approval_outcomes').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`upsertOutcome failed: ${error.message}`);
  }

  async getOutcomesByInsurer(insurerId: string, canonicalProcedure?: string): Promise<ApprovalOutcomeRow[]> {
    let q = this.db.from('approval_outcomes').select('*').eq('insurer_id', insurerKey(insurerId));
    if (canonicalProcedure) q = q.eq('canonical_procedure', canonicalProcedure);
    const { data, error } = await q.order('decided_at', { ascending: false });
    if (error) throw new Error(`getOutcomesByInsurer failed: ${error.message}`);
    return (data || []) as ApprovalOutcomeRow[];
  }

  async getAllOutcomes(): Promise<ApprovalOutcomeRow[]> {
    const { data, error } = await this.db.from('approval_outcomes').select('*').order('decided_at', { ascending: false });
    if (error) throw new Error(`getAllOutcomes failed: ${error.message}`);
    return (data || []) as ApprovalOutcomeRow[];
  }

  async deleteOutcome(idOrSourceHash: string): Promise<ApprovalOutcomeRow[]> {
    const { data: byId } = await this.db.from('approval_outcomes').select('*').eq('id', idOrSourceHash);
    const { data: byHash } = await this.db.from('approval_outcomes').select('*').eq('source_approval_hash', idOrSourceHash);
    const rows = [...(byId || []), ...(byHash || [])] as ApprovalOutcomeRow[];
    if (rows.length) {
      await this.db.from('approval_outcomes').delete().in('id', rows.map((r) => r.id));
    }
    return rows;
  }

  async upsertStats(row: InsurerProcedureStatsRow): Promise<void> {
    const { error } = await this.db
      .from('insurer_procedure_stats')
      .upsert(row, { onConflict: 'insurer_id,canonical_procedure' });
    if (error) throw new Error(`upsertStats failed: ${error.message}`);
  }

  async getStats(insurerId: string, canonicalProcedure: string): Promise<InsurerProcedureStatsRow | null> {
    const { data, error } = await this.db
      .from('insurer_procedure_stats')
      .select('*')
      .eq('insurer_id', insurerKey(insurerId))
      .eq('canonical_procedure', canonicalProcedure)
      .maybeSingle();
    if (error) return null;
    return (data as InsurerProcedureStatsRow) ?? null;
  }

  async deleteStats(insurerId: string, canonicalProcedure: string): Promise<void> {
    await this.db
      .from('insurer_procedure_stats')
      .delete()
      .eq('insurer_id', insurerKey(insurerId))
      .eq('canonical_procedure', canonicalProcedure);
  }

  async upsertRule(row: LearnedRuleRow): Promise<LearnedRuleRow> {
    const { data: existing } = await this.db
      .from('learned_rules')
      .select('*')
      .eq('rule_key', row.rule_key)
      .is('insurer_id', row.insurer_id as any)
      .maybeSingle();
    if (existing) {
      const { data } = await this.db
        .from('learned_rules')
        .update({
          evidence_count: row.evidence_count,
          example_hashes: row.example_hashes,
          payload: row.payload,
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      return (data || existing) as LearnedRuleRow;
    }
    const { id: _ignore, ...insertable } = row;
    const { data, error } = await this.db.from('learned_rules').insert(insertable).select('*').single();
    if (error) throw new Error(`upsertRule failed: ${error.message}`);
    return data as LearnedRuleRow;
  }

  async getRules(filter?: { insurerId?: string; status?: RuleStatus; type?: RuleType }): Promise<LearnedRuleRow[]> {
    let q = this.db.from('learned_rules').select('*');
    if (filter?.status) q = q.eq('status', filter.status);
    if (filter?.type) q = q.eq('rule_type', filter.type);
    const { data } = await q;
    const rows = (data || []) as LearnedRuleRow[];
    if (!filter?.insurerId) return rows;
    const ins = insurerKey(filter.insurerId);
    return rows.filter((r) => r.insurer_id === ins || r.insurer_id === null);
  }

  async updateRuleStatus(id: string, status: RuleStatus, decidedBy: string): Promise<LearnedRuleRow | null> {
    const { data } = await this.db
      .from('learned_rules')
      .update({ status, decided_by: decidedBy, decided_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    return (data as LearnedRuleRow) ?? null;
  }

  async addFewShot(row: FewShotPoolRow): Promise<void> {
    assertNoPhi(row.masked_snippet);
    assertNoPhi(JSON.stringify(row.expected_output));
    await this.db.from('few_shot_pool').upsert(row, { onConflict: 'id' });
  }

  async getFewShots(insurerId: string, category?: ItemCategory, limit = 3): Promise<FewShotPoolRow[]> {
    let q = this.db.from('few_shot_pool').select('*').eq('insurer_id', insurerKey(insurerId));
    if (category) q = q.eq('category', category);
    const { data } = await q.limit(limit);
    return (data || []) as FewShotPoolRow[];
  }

  async addCorrection(row: Omit<CorrectionRow, 'id' | 'created_at'>): Promise<CorrectionRow> {
    const { data, error } = await this.db.from('classification_corrections').insert(row).select('*').single();
    if (error) throw new Error(`addCorrection failed: ${error.message}`);
    return data as CorrectionRow;
  }

  async addAudit(entry: Omit<AuditEntry, 'id' | 'created_at'>): Promise<AuditEntry> {
    const { data, error } = await this.db.from('classifier_audit_log').insert(entry).select('*').single();
    if (error) throw new Error(`addAudit failed: ${error.message}`);
    return data as AuditEntry;
  }

  async getAudits(): Promise<AuditEntry[]> {
    const { data } = await this.db.from('classifier_audit_log').select('*').order('created_at', { ascending: false });
    return (data || []) as AuditEntry[];
  }
}
