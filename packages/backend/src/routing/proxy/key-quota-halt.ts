/**
 * Key-scoped quota-halt registry (RET-647, D-2026-11-10-13).
 *
 * A provider quota-window halt (1310 class) means THIS credential is drained
 * until `next_flush_time` — not that the provider/model route is down. Before
 * RET-647 such a 429 cooled the shared route entry, which paused every other
 * caller of that route and re-taught the same dead key per agent. The registry
 * instead marks the exact key (the secret actually sent upstream) dead until
 * the provider's own window flush, so:
 *  - attempt-1 skips a known-dead key instantly (no provider round-trip);
 *  - other keys on the same route stay live and a funded fallback serves
 *    without any client-visible pause;
 *  - the entry expires exactly at the provider window reset — the auto-revive
 *    that ends guard corpses (a key that flunked one window is tried again at
 *    the next window, with no operator action).
 *
 * State is in-memory per replica, compared by secret and never persisted, for
 * the same reasons as CredentialRejectionCooldown: a restart or a re-key costs
 * at most one more halt probe before the registry learns the same thing.
 */

/** Safety cap so a pathological provider cannot grow the map unbounded. */
const MAX_ENTRIES = 2_000;

/** The credential a provider call used, as routing knows it. */
export interface KeyQuotaHaltRef {
  tenantId?: string;
  connectionId?: string | null;
  provider: string;
  authType?: string;
  keyLabel?: string;
  model?: string;
  /** The secret actually sent upstream: an API key or an OAuth access token. */
  secret: string;
}

interface Halt {
  /** Epoch ms when the provider window flushes and the key revives. */
  until: number;
  /** The exact secret the provider declared drained. */
  secret: string;
}

export class KeyQuotaHaltRegistry {
  private readonly halts = new Map<string, Halt>();

  constructor(
    private readonly maxEntries = MAX_ENTRIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Mark a key dead until `flushMs`. Re-insert so insertion order stays
   * expiry order, mirroring CredentialRejectionCooldown.evict.
   */
  halt(ref: KeyQuotaHaltRef, flushMs: number): void {
    const key = keyHaltKey(ref);
    if (!key || !ref.secret) return;
    const until = Math.max(flushMs, this.now() + 1);
    this.halts.delete(key);
    if (this.halts.size >= this.maxEntries) this.evict();
    this.halts.set(key, { until, secret: ref.secret });
  }

  /**
   * Epoch ms until which the key is known-dead, or null when it is usable.
   * An entry whose window has flushed is deleted on read — that read IS the
   * auto-revive at the provider window reset. Any other secret on the same
   * connection is never affected.
   */
  haltedUntil(ref: KeyQuotaHaltRef): number | null {
    const key = keyHaltKey(ref);
    if (!key) return null;
    const halt = this.halts.get(key);
    if (!halt) return null;
    if (halt.until <= this.now()) {
      this.halts.delete(key);
      return null;
    }
    return halt.secret === ref.secret ? halt.until : null;
  }

  /**
   * Drop every expired entry; returns how many corpses were revived. Called
   * before inserting so the window reset actively frees keys even when no
   * request probes them first.
   */
  reviveExpired(now: number = this.now()): number {
    let revived = 0;
    for (const [key, halt] of this.halts) {
      if (halt.until <= now) {
        this.halts.delete(key);
        revived++;
      }
    }
    return revived;
  }

  /** Current number of live (unexpired) halt entries. */
  size(now: number = this.now()): number {
    let live = 0;
    for (const halt of this.halts.values()) if (halt.until > now) live++;
    return live;
  }

  private evict(): void {
    this.reviveExpired();
    if (this.halts.size < this.maxEntries) return;
    // Insertion order is expiry order: every entry shares its own flush time,
    // but re-insert keeps the soonest-flushing entries at the front when they
    // share a window. Drop the oldest scan order entry as the tie-break.
    const oldest = this.halts.keys().next().value as string;
    this.halts.delete(oldest);
  }
}

function keyHaltKey(ref: KeyQuotaHaltRef): string | null {
  if (!ref.tenantId) return null;
  return [
    ref.tenantId,
    ref.connectionId ?? '',
    ref.provider.toLowerCase(),
    ref.authType ?? '',
    ref.keyLabel ?? '',
    ref.model?.toLowerCase() ?? '',
  ].join('\u0000');
}
