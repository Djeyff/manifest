import { Injectable, Logger, Optional } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Decisions-ledger auto-mint (RET-720).
 *
 * Every wallet-settings change mints a ruling id `D-YYYY-MM-DD-NN` and
 * appends one JSONL row to the ledger sink. The sink is a FILE (env
 * MANIFEST_DECISION_LEDGER_FILE) so the ledger stays append-only and
 * survives restarts — the crew's doctrine ledger ingests it out-of-band.
 *
 * Failure policy: the ledger is a receipt, never a gate on the money
 * surface. If the sink cannot be written the ruling id is still minted and
 * returned (the audit row records `persisted: false`) — the change itself
 * must not be lost because a disk is full.
 */
export const DECISION_LEDGER_FILE_DEFAULT = '/data/wallet-console-decisions.jsonl';

export interface MintRulingInput {
  tenant_id: string;
  wallet_id: string;
  actor_user_id: string | null;
  action: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface MintedRuling {
  id: string;
  minted_at: string;
  /** True when the row landed in the ledger sink. */
  persisted: boolean;
}

@Injectable()
export class DecisionLedgerService {
  private readonly logger = new Logger(DecisionLedgerService.name);

  constructor(@Optional() private readonly ledgerFile?: string) {}

  private get file(): string {
    return this.ledgerFile ?? process.env.MANIFEST_DECISION_LEDGER_FILE ?? DECISION_LEDGER_FILE_DEFAULT;
  }

  /**
   * Mint the next ruling id for today and append the ledger row.
   * Sequence numbers are per-day and derived from what the sink already
   * holds — never from an in-memory counter, so a restart cannot reuse a
   * number.
   */
  async mint(input: MintRulingInput): Promise<MintedRuling> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const seq = this.nextSequence(day);
    const id = `D-${day}-${String(seq).padStart(2, '0')}`;
    const row = {
      id,
      date: day,
      minted_at: now.toISOString(),
      tenant_id: input.tenant_id,
      wallet_id: input.wallet_id,
      actor_user_id: input.actor_user_id,
      action: input.action,
      summary: input.summary,
      before: input.before,
      after: input.after,
    };
    let persisted = false;
    try {
      const file = this.file;
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      persisted = true;
    } catch (error) {
      this.logger.warn(`decision-ledger: append failed (ruling ${id} still minted): ${error}`);
    }
    return { id, minted_at: now.toISOString(), persisted };
  }

  /** Highest NN already used today in the sink; 1 when the day is empty. */
  private nextSequence(day: string): number {
    let text = '';
    try {
      const file = this.file;
      if (existsSync(file)) text = readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    let max = 0;
    const pattern = new RegExp(`"id"\\s*:\\s*"D-${day}-(\\d{2})"`, 'g');
    let match = pattern.exec(text);
    while (match !== null) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
      match = pattern.exec(text);
    }
    return max + 1;
  }
}
