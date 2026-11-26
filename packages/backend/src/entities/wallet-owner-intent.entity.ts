import { Entity, PrimaryColumn, Index } from 'typeorm';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';

/**
 * Owner wallet pause/resume INTENT (RET-776-B).
 *
 * This table is a CONTRACT with the control-room governor lane
 * (RET-776-A), which reads it straight out of the mnfs postgres:
 *
 *   SELECT account, action, actor, reason, created_at
 *     FROM wallet_owner_intents
 *    WHERE account = $1
 *    ORDER BY created_at DESC
 *    LIMIT 1;
 *
 * The column names are therefore LITERAL and must not be renamed: account,
 * action, actor, reason, created_at. The action is 'pause' or 'resume'.
 *
 * The row is an INTENT, never a key state: the API never flips
 * `tenant_providers.is_active`. The governor + tick (RET-776-A) read this
 * table and decide whether the keys park / unpark.
 *
 * The primary key is the composite of the contract columns — no extra
 * surrogate column, so the table stays exactly the contract above.
 */
@Entity('wallet_owner_intents')
@Index(['account'])
export class WalletOwnerIntent {
  /** The governed account the intent applies to (e.g. "zai-max"). */
  @PrimaryColumn('text')
  account!: string;

  /** 'pause' | 'resume'. */
  @PrimaryColumn('text')
  action!: string;

  /** Who asked (the tenant owner user id). */
  @PrimaryColumn('text')
  actor!: string;

  /** Owner free-text reason (empty string when the owner gave none). */
  @PrimaryColumn('text')
  reason!: string;

  /** When the intent was recorded (the row the governor reads). */
  @PrimaryColumn(timestampType(), { default: timestampDefault() })
  created_at!: string;
}
