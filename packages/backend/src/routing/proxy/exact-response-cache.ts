/**
 * RET-548 WP3 — gateway exact-response cache (flag-gated, default OFF).
 *
 * The cache is EXACT: a hit is only served when the canonical key of the
 * incoming request is byte-identical to a stored entry's key. There is no
 * fuzzy/semantic matching, no partial reuse, no prompt-prefix reuse — the
 * only reuse is a full response for a full identical request.
 *
 * Safety rails (all fail-closed, no exceptions thrown):
 *  - Disabled unless `MANIFEST_EXACT_CACHE_ENABLED` is a truthy env value.
 *  - Only requests that pass `isCacheableRequest` are stored or served:
 *    non-streaming, no tools, temperature 0, and an explicit opt-in marker.
 *  - Entries expire (TTL) and the store is bounded (max entries).
 *  - The cache NEVER changes the upstream response shape: a hit replays the
 *    stored response body verbatim with `cached: true` provenance.
 *
 * Deployment of the gateway image that carries this module is T0 owner-gated:
 * the code is merged behind a default-OFF flag, never enabled by default.
 */

import { createHash } from 'node:crypto';

export const EXACT_CACHE_ENV_FLAG = 'MANIFEST_EXACT_CACHE_ENABLED';
export const DEFAULT_EXACT_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_EXACT_CACHE_MAX_ENTRIES = 500;

/** Marker a caller may put in the request body to opt a request in. */
export const EXACT_CACHE_OPT_IN_KEY = 'x_manifest_exact_cache';

export interface ExactCacheEntry {
  /** Canonical key of the request that produced this response. */
  readonly key: string;
  /** The upstream response body, replayed verbatim on a hit. */
  readonly response: unknown;
  /** Epoch ms when this entry was written. */
  readonly createdAt: number;
  /** Epoch ms when this entry expires. */
  readonly expiresAt: number;
}

export interface ExactCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface ExactCacheLookup {
  readonly hit: boolean;
  readonly entry?: ExactCacheEntry;
}

/** Truthy env parsing: only explicit, case-insensitive "1"/"true"/"yes"/"on". */
export function envFlagEnabled(
  value: string | undefined,
  flag: string = EXACT_CACHE_ENV_FLAG,
): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Canonicalize a request body into a stable string. Key order does not
 * matter, but every VALUE does — an exact cache must not treat two
 * different requests as equal.
 */
export function canonicalizeRequest(body: unknown): string {
  return JSON.stringify(sortKeys(body));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortKeys(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Build the exact-match key for a request. The model is part of the key so a
 * cached answer for one model is never served for another.
 */
export function buildExactCacheKey(input: {
  model: string;
  body: unknown;
  agentId?: string | null;
  tenantId?: string | null;
}): string {
  const canonical = canonicalizeRequest(input.body);
  const scoped = [
    input.agentId ?? '',
    input.tenantId ?? '',
    input.model,
    canonical,
  ].join('\u0000');
  return createHash('sha256').update(scoped, 'utf8').digest('hex');
}

/**
 * A request is cacheable only when it is deterministic enough that an
 * identical repeat is expected to yield an identical answer:
 *  - not streaming,
 *  - no tools (tool calls are stateful),
 *  - temperature pinned to 0,
 *  - explicit opt-in marker present and truthy.
 */
export function isCacheableRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (record.stream === true) return false;
  if (Array.isArray(record.tools) && record.tools.length > 0) return false;
  if (record.temperature !== undefined && record.temperature !== 0) return false;
  const optIn = record[EXACT_CACHE_OPT_IN_KEY];
  return optIn === true || optIn === 'true' || optIn === 1;
}

/**
 * Bounded, TTL'd exact-match store. Insertion order is the eviction order
 * (oldest first) once the entry cap is reached.
 */
export class ExactResponseCache {
  private readonly entries = new Map<string, ExactCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ExactCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_EXACT_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_EXACT_CACHE_MAX_ENTRIES);
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the live entry for `key`, or undefined when absent/expired. */
  get(key: string): ExactCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Stores a response under `key`, replacing any previous entry. */
  set(key: string, response: unknown): ExactCacheEntry {
    const createdAt = this.now();
    const entry: ExactCacheEntry = {
      key,
      response,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return entry;
  }

  /** Lookup helper that never throws. */
  lookup(key: string): ExactCacheLookup {
    try {
      const entry = this.get(key);
      return entry ? { hit: true, entry } : { hit: false };
    } catch {
      return { hit: false };
    }
  }

  /** Drops expired entries. Safe to call from a periodic sweep. */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of [...this.entries.entries()]) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Facade used by the proxy layer. When the flag is off, every lookup misses
 * and every store is a no-op — production behaviour is byte-identical to a
 * build without this module.
 */
export class ExactResponseCacheService {
  private readonly cache: ExactResponseCache;
  private readonly enabled: boolean;

  constructor(
    enabled: boolean = envFlagEnabled(process.env[EXACT_CACHE_ENV_FLAG]),
    options: ExactCacheOptions = {},
  ) {
    this.enabled = enabled;
    this.cache = new ExactResponseCache(options);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Returns the cached response for an identical request, if any. */
  lookup(input: {
    model: string;
    body: unknown;
    agentId?: string | null;
    tenantId?: string | null;
  }): ExactCacheLookup {
    if (!this.enabled) return { hit: false };
    try {
      if (!isCacheableRequest(input.body)) return { hit: false };
      const key = buildExactCacheKey(input);
      return this.cache.lookup(key);
    } catch {
      return { hit: false };
    }
  }

  /** Stores a response for later exact replay. No-op when disabled. */
  store(
    input: { model: string; body: unknown; agentId?: string | null; tenantId?: string | null },
    response: unknown,
  ): void {
    if (!this.enabled) return;
    try {
      if (!isCacheableRequest(input.body)) return;
      const key = buildExactCacheKey(input);
      this.cache.set(key, response);
    } catch {
      /* fail closed: a cache write must never break the request path */
    }
  }

  prune(): number {
    return this.cache.prune();
  }
}
