import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import {
  applyAbort,
  applyAgentAbort,
  applyAttempt,
  applyConsumed,
  applyWindowFlush,
  normalizeProviderKey,
  QUOTA_ACCOUNTING_FILE_DEFAULT,
  QUOTA_ACCOUNTING_FLUSH_DEBOUNCE_MS,
  AbortTiming,
  QuotaAccountingSnapshot,
  QuotaAgentAbortAccounting,
  QuotaProviderAccounting,
  QuotaUsageShape,
  setQuotaAccountingHooks,
  WindowFlushOutcome,
} from './quota-accounting';

/**
 * Attempted-vs-consumed quota accounting (RET-480-B2) — persistence + Nest
 * lifecycle over the pure core in quota-accounting.ts.
 *
 * Persistence mirrors quota-state.json: atomic tmp+rename at
 * QUOTA_ACCOUNTING_FILE (default /data/quota-accounting.json), debounced 30s,
 * with an immediate flush on window roll and on shutdown. When persistence
 * fails the service degrades to in-memory with a warn-once — accounting is
 * telemetry and must never break forwarding.
 */
@Injectable()
export class QuotaAccountingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuotaAccountingService.name);
  private readonly state: QuotaAccountingSnapshot = { providers: {}, agents: {} };
  private readonly filePath: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistDegraded = false;

  constructor(
    @Optional()
    filePath?: string,
  ) {
    this.filePath = filePath ?? process.env.QUOTA_ACCOUNTING_FILE ?? QUOTA_ACCOUNTING_FILE_DEFAULT;
    this.loadFromDisk();
  }

  /** Wire the response-handler error paths to this service (optional hooks). */
  onModuleInit(): void {
    setQuotaAccountingHooks({
      noteWindowFlush: (provider, flushMs) => this.noteWindowFlush(provider, flushMs),
    });
  }

  onModuleDestroy(): void {
    setQuotaAccountingHooks(null);
    this.flush();
  }

  /** One attempt on a provider, counted from the exact serialized wire body. */
  recordAttempt(provider: string, wireBody: string): void {
    try {
      applyAttempt(this.state, provider, wireBody, Date.now());
      this.schedulePersist();
    } catch (e) {
      this.warnDegrade(e);
    }
  }

  /** One consumed response, from normalized prompt+completion usage. */
  recordConsumed(provider: string, usage?: QuotaUsageShape | null): void {
    try {
      applyConsumed(this.state, provider, usage, Date.now());
      this.schedulePersist();
    } catch (e) {
      this.warnDegrade(e);
    }
  }

  /**
   * One client-aborted provider attempt (D-2026-10-30-11). after_dispatch
   * means the provider bills the attempt (burn slice of attempted);
   * before_dispatch means nothing was ever sent. Both timings count on the
   * agent's cumulative map when the agent is known; provider burn is only
   * counted for a real (non-empty) provider.
   */
  recordAbort(
    agentName: string | null | undefined,
    provider: string,
    timing: AbortTiming,
    estTokens: number,
  ): void {
    try {
      const now = Date.now();
      if (provider) applyAbort(this.state, provider, timing, estTokens, now);
      if (agentName) applyAgentAbort(this.state, agentName, timing, estTokens, now);
      this.schedulePersist();
    } catch (e) {
      this.warnDegrade(e);
    }
  }

  /** Adopt a 429-halt `next_flush_time` as the provider's window identity. */
  noteWindowFlush(provider: string, flushMs: number): WindowFlushOutcome {
    try {
      const outcome = applyWindowFlush(this.state, provider, flushMs, Date.now());
      if (outcome === 'rolled') this.flush();
      else this.schedulePersist();
      return outcome;
    } catch (e) {
      this.warnDegrade(e);
      return 'unchanged';
    }
  }

  /** Day-deck shape: { providers: { <lowercased provider>: {...} } }. */
  snapshot(): QuotaAccountingSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as QuotaAccountingSnapshot;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    const timer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, QUOTA_ACCOUNTING_FLUSH_DEBOUNCE_MS);
    // A pending accounting flush must never hold the process open.
    timer.unref?.();
    this.persistTimer = timer;
  }

  /** Atomic tmp+rename persist; clears the debounce clock. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot()));
      renameSync(tmp, this.filePath);
      this.persistDegraded = false;
    } catch (e) {
      this.warnDegrade(e);
    }
  }

  private warnDegrade(e: unknown): void {
    if (this.persistDegraded) return;
    this.persistDegraded = true;
    this.logger.warn(`quota-accounting degraded to in-memory (will retry silently): ${e}`);
  }

  private loadFromDisk(): void {
    let parsed: {
      providers?: Record<string, QuotaProviderAccounting>;
      agents?: Record<string, QuotaAgentAbortAccounting>;
    };
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      // First boot (ENOENT) or unreadable state: start from an empty window.
      return;
    }
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed?.providers ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      this.state.providers[normalizeProviderKey(key)] = {
        ...{
          window_start: new Date(now).toISOString(),
          window_flush_at: null,
          attempted_requests: 0,
          attempted_est_tokens: 0,
          consumed_requests: 0,
          consumed_tokens: 0,
          aborted_requests: 0,
          aborted_est_tokens: 0,
          updated_at: new Date(now).toISOString(),
        },
        ...entry,
      };
    }
    // Pre-abort state files have no agents map — default it to empty.
    for (const [name, entry] of Object.entries(parsed?.agents ?? {})) {
      if (!entry || typeof entry !== 'object') continue;
      this.state.agents[name] = {
        ...{
          aborts_before_dispatch: 0,
          aborts_after_dispatch: 0,
          abort_billed_est_tokens: 0,
          updated_at: new Date(now).toISOString(),
        },
        ...entry,
      };
    }
  }
}
