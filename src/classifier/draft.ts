/**
 * Section E: English price-approval draft to the INTERNAL Corporate Sales Department.
 * Contains ONLY LIST_2026_PRICE_APPROVAL lines. Recipient is hard-guarded.
 */
import type { PricedLine } from './types';

export class RecipientBlockedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'RecipientBlockedError';
  }
}

export interface RecipientConfig {
  recipient: string;
  allowedDomains: string[];
}

export function loadRecipientConfig(env: Record<string, string | undefined> = process.env): RecipientConfig {
  return {
    recipient: (env.CORPORATE_SALES_RECIPIENT || 'corporate@elitehospital.org').trim().toLowerCase(),
    allowedDomains: (env.ALLOWED_RECIPIENT_DOMAINS || 'elitehospital.org')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
}

const EMAIL_RE = /^[a-z0-9._%+\-]+@([a-z0-9\-]+(?:\.[a-z0-9\-]+)+)$/i;

/**
 * Returns the single permitted address or throws. Blocks: lists/groups (multiple addresses,
 * separators), any domain outside ALLOWED_RECIPIENT_DOMAINS, and anything other than the
 * configured Corporate Sales recipient.
 */
export function assertInternalRecipient(to: string | string[] | null | undefined, cfg: RecipientConfig = loadRecipientConfig()): string {
  const list = Array.isArray(to) ? to : [to ?? ''];
  if (list.length !== 1) throw new RecipientBlockedError('Exactly one recipient is allowed');
  let addr = (list[0] || '').trim();
  const angle = addr.match(/<([^<>]+)>\s*$/);
  if (angle) addr = angle[1].trim();
  if (/[;,\s]/.test(addr)) throw new RecipientBlockedError('Multiple recipients / distribution lists are not allowed');
  const m = addr.match(EMAIL_RE);
  if (!m) throw new RecipientBlockedError(`Invalid recipient address "${addr}"`);
  const domain = m[1].toLowerCase();
  if (!cfg.allowedDomains.includes(domain)) throw new RecipientBlockedError(`Domain "${domain}" is not an allowed internal domain`);
  const cfgDomain = cfg.recipient.split('@')[1];
  if (!cfgDomain || !cfg.allowedDomains.includes(cfgDomain)) throw new RecipientBlockedError('CORPORATE_SALES_RECIPIENT is not on an allowed internal domain');
  if (addr.toLowerCase() !== cfg.recipient) throw new RecipientBlockedError(`Only the Corporate Sales recipient (${cfg.recipient}) is allowed`);
  return addr.toLowerCase();
}

/** Exact number formatting: no rounding of real digits (≤4 decimals, trailing zeros trimmed). */
export function fmtEgp(n: number): string {
  const s = Number(n.toPrecision(12)).toString();
  const [int, dec] = s.split('.');
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${withCommas}.${dec}` : withCommas;
}

export interface DraftInput {
  patientName: string;
  approvalRef: string | null;
  insurer: string;
  lines: PricedLine[];
  signerName?: string;
  signerTitle?: string;
}

export interface PriceApprovalDraft {
  to: string;
  subject: string;
  body: string;
  total: number;
  lineCount: number;
}

export function buildPriceApprovalDraft(input: DraftInput, cfg: RecipientConfig = loadRecipientConfig()): PriceApprovalDraft | null {
  // ONLY items needing price approval; rejected / not found / needs-review lines never appear.
  const lines = input.lines.filter((l) => l.price_source === 'LIST_2026_PRICE_APPROVAL' && l.unit_price !== null && l.line_total !== null);
  if (!lines.length) return null;
  const to = assertInternalRecipient(cfg.recipient, cfg);
  const ref = input.approvalRef || 'N/A';
  const name = (l: PricedLine) => {
    const en = l.matched_name_en || l.canonical_en || l.item;
    const ar = l.matched_name_ar || '';
    return ar ? `${en} / ${ar}` : en;
  };
  const total = Number(lines.reduce((s, l) => s + (l.line_total as number), 0).toPrecision(12));
  const items = lines
    .map(
      (l, i) =>
        `${i + 1}. ${name(l)} – Qty: ${fmtEgp(l.qty)} – Unit price: EGP ${fmtEgp(l.unit_price as number)} – Total: EGP ${fmtEgp(l.line_total as number)}\n   Status: موافقة سعرية (2026 hospital pricelist, no discounts)`
    )
    .join('\n');
  const signerName = input.signerName || process.env.PRICE_APPROVAL_SIGNER_NAME || 'Duty Manager';
  const signerTitle = input.signerTitle || process.env.PRICE_APPROVAL_SIGNER_TITLE || 'Insurance & Approvals';
  const body = `To: Corporate Sales Department
Subject: Price approval required – ${input.patientName} – Ref ${ref} – ${input.insurer}

Dear Corporate Sales Team,

Regarding approval request ${ref} for patient ${input.patientName} (insurer: ${input.insurer}),
the following items are not found in the insurer's contracted pricelist.
Kindly obtain the insurer's price approval (موافقة سعرية) for each:

${items}

Total requiring price approval: EGP ${fmtEgp(total)}

Please update us with the outcome so we can proceed with the patient's care.

Regards,
${signerName} – ${signerTitle}
Elite Hospital`;
  return { to, subject: `Price approval required – ${input.patientName} – Ref ${ref} – ${input.insurer}`, body, total, lineCount: lines.length };
}

export interface DraftSender {
  /** Creates an Exchange draft (existing EWS channel). Returns true on success. */
  createDraft(p: { to: string; subject: string; body: string }): Promise<boolean>;
}

/** Default sender: existing EwsSource standalone draft (lands in Exchange Drafts; a human sends it). */
export const ewsDraftSender: DraftSender = {
  async createDraft({ to, subject, body }) {
    const { EwsSource } = await import('../mail/adapters/EwsSource');
    // Strip the "To:/Subject:" header lines the template carries; EWS has its own fields.
    const text = body.replace(/^To:.*\nSubject:.*\n\n/, '');
    const res = await new EwsSource().createDraft({ subject, body: text, to, signatureHtml: ' ', signatureText: ' ' });
    return !!res.success;
  },
};

/** Auto-send is opt-in (PRICE_APPROVAL_AUTOSEND=true) and never for lines needing human review. */
export function mayAutoSend(opts: { needsHumanReview: boolean; priced: PricedLine[]; env?: Record<string, string | undefined> }): boolean {
  const env = opts.env ?? process.env;
  if ((env.PRICE_APPROVAL_AUTOSEND || '').toLowerCase() !== 'true') return false;
  if (opts.needsHumanReview) return false;
  return !opts.priced.some((l) => l.price_source === 'NOT_FOUND' || l.price_source === 'NEEDS_REVIEW' || l.price_source === 'NO_MAPPING');
}

export async function sendPriceApprovalDraft(
  draft: PriceApprovalDraft,
  sender: DraftSender = ewsDraftSender,
  cfg: RecipientConfig = loadRecipientConfig()
): Promise<{ sent: boolean; to: string }> {
  const to = assertInternalRecipient(draft.to, cfg); // re-check at the last moment
  const ok = await sender.createDraft({ to, subject: draft.subject, body: draft.body });
  return { sent: ok, to };
}
