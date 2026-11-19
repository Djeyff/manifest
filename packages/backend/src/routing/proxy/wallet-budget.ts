/**
 * Wallet budgets (RET-692) — pure decision core.
 *
 * A "wallet" is one `tenant_providers` row (a Provider Connection). Its
 * optional `budget` JSONB column carries the operator-set lines:
 *
 *   {
 *     "daily_usd": 12,                      // hard line per SDQ day
 *     "weekly_usd": 60,                     // hard line per anchor week
 *     "week_anchor_utc": "00:00",           // Monday HH:MM UTC week reset
 *     "night_window": {                     // spend restricted to allowlist
 *       "start": "00:30", "end": "06:05",   // HH:MM in the window timezone
 *       "offset_minutes": -240              // default -240 = America/Santo_Domingo (no DST)
 *     },
 *     "allow": ["KaanAssistV2", "owner-answer"] // night-window exemptions
 *   }
 *
 * Semantics (locked with the owner 2026-11-18):
 *  - Cap rules (daily/weekly) are HARD: no allowlist entry bypasses an empty
 *    wallet. The router is expected to jump to the next wallet in the chain.
 *  - The night window restricts WHO may spend, not how much: callers matched
 *    by `allow` (tier/agent name, or the pseudo-entry `owner-answer` meaning
 *    the request carries an `x-manifest-trigger: owner-…` header set by the
 *    coordinator turn that is answering the owner) pass through; everyone
 *    else is rejected until the window closes.
 *
 * This module is deliberately pure (no Nest, no DB, no fs) so the routing
 * gate and the specs can import it cheaply. Persistence and Nest lifecycle
 * live in wallet-budget.service.ts; the admission choke point is
 * resolveRouteCredentials() in route-credentials.ts, so a request is always
 * charged to the wallet that will actually serve it, before any provider
 * call. Flipping the `budget` column changes behavior on the next request —
 * nothing is cached and no rollout is involved.
 */

export type WalletBudgetMode = 'off' | 'shadow' | 'enforce';

export interface WalletBudgetNightWindow {
  /** Inclusive window start, "HH:MM" in the window timezone. */
  start: string;
  /** Exclusive window end, "HH:MM" in the window timezone. */
  end: string;
  /** Fixed UTC offset of the window timezone in minutes. Default -240 (SDQ). */
  offset_minutes?: number;
}

export interface WalletBudgetConfig {
  daily_usd?: number | null;
  weekly_usd?: number | null;
  /** "HH:MM" UTC — the Monday-anchored weekly reset point. Default "00:00". */
  week_anchor_utc?: string;
  night_window?: WalletBudgetNightWindow | null;
  /**
   * Night-window exemptions: tier names, agent names (case-insensitive), or
   * the pseudo-entry "owner-answer" matching an owner-answer trigger header.
   */
  allow?: string[] | null;
}

export interface WalletSpend {
  /** Spent since the current SDQ day opened. */
  day_usd: number;
  /** Spent since the current anchor week opened. */
  week_usd: number;
}

export interface WalletGateCallerContext {
  agentName?: string | null;
  tierName?: string | null;
  /** Raw `x-manifest-trigger` header value, when the caller sent one. */
  triggerHeader?: string | null;
}

export type WalletBudgetRule = 'daily_cap' | 'weekly_cap' | 'night_window';

export type WalletBudgetDecision =
  | { allowed: true }
  | { allowed: false; rule: WalletBudgetRule; detail: string };

/** Default window timezone: Santo Domingo (UTC-4, no DST). */
export const WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES = -240;

export const WALLET_NIGHT_WINDOW_DEFAULT: WalletBudgetNightWindow = {
  start: '00:30',
  end: '06:05',
  offset_minutes: WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES,
};

/** Env knob selecting the enforcement posture; read fresh on every request. */
export const WALLET_BUDGET_MODE_ENV = 'MANIFEST_WALLET_BUDGET_MODE';

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface ParsedWalletBudget {
  config: WalletBudgetConfig | null;
  /** Human-readable problems with the stored JSON; empty when clean. */
  warnings: string[];
}

/**
 * Parse + validate a wallet `budget` column value. Null/absent → no budget
 * (wallet is ungoverned). Malformed pieces are dropped with a warning instead
 * of rejecting the whole config: a typo must never widen what the wallet
 * allows beyond the operator's surviving lines, and never crash routing.
 */
export function parseWalletBudget(raw: unknown): ParsedWalletBudget {
  const warnings: string[] = [];
  if (raw === null || raw === undefined) return { config: null, warnings };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { config: null, warnings };
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return { config: null, warnings: ['budget is not valid JSON — wallet ungoverned'] };
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, warnings: ['budget is not an object — wallet ungoverned'] };
  }
  const src = raw as Record<string, unknown>;
  const config: WalletBudgetConfig = {};

  for (const key of ['daily_usd', 'weekly_usd'] as const) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      warnings.push(`${key} is not a non-negative number — ignored`);
      continue;
    }
    config[key] = value;
  }

  if (src.week_anchor_utc !== undefined && src.week_anchor_utc !== null) {
    if (typeof src.week_anchor_utc === 'string' && HHMM_RE.test(src.week_anchor_utc)) {
      config.week_anchor_utc = src.week_anchor_utc;
    } else {
      warnings.push('week_anchor_utc is not "HH:MM" — defaulting to 00:00 UTC Monday');
    }
  }

  if (src.night_window !== undefined && src.night_window !== null) {
    if (typeof src.night_window !== 'object' || Array.isArray(src.night_window)) {
      warnings.push('night_window is not an object — window not enforced');
    } else {
      const win = src.night_window as Record<string, unknown>;
      const start = typeof win.start === 'string' ? win.start : '';
      const end = typeof win.end === 'string' ? win.end : '';
      if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
        warnings.push('night_window start/end are not "HH:MM" — window not enforced');
      } else {
        const window: WalletBudgetNightWindow = { start, end };
        if (win.offset_minutes !== undefined && win.offset_minutes !== null) {
          if (
            typeof win.offset_minutes === 'number' &&
            Number.isFinite(win.offset_minutes) &&
            Number.isInteger(win.offset_minutes) &&
            Math.abs(win.offset_minutes) < 1440
          ) {
            window.offset_minutes = win.offset_minutes;
          } else {
            warnings.push('night_window offset_minutes invalid — using SDQ (-240)');
          }
        }
        config.night_window = window;
      }
    }
  }

  if (src.allow !== undefined && src.allow !== null) {
    if (!Array.isArray(src.allow)) {
      warnings.push('allow is not an array — no night-window exemptions');
    } else {
      const allow = src.allow
        .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim());
      if (allow.length !== src.allow.length) {
        warnings.push('allow contained non-string entries — dropped');
      }
      config.allow = allow;
    }
  }

  const hasAny =
    config.daily_usd !== undefined ||
    config.weekly_usd !== undefined ||
    config.night_window !== undefined ||
    config.allow !== undefined;
  if (!hasAny) return { config: null, warnings };

  return { config, warnings };
}

/** Parse the mode env var. Invalid values fall back to `off` so a typo can never block traffic. */
export function resolveWalletBudgetMode(raw: string | undefined | null): WalletBudgetMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  if (value === 'enforce') return 'enforce';
  return 'off';
}

function minutesOfHHMM(value: string): number {
  const match = value.match(HHMM_RE);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes-since-local-midnight for `now` under a fixed UTC offset. */
function localMinutes(now: Date, offsetMinutes: number): number {
  const shifted = now.getTime() + offsetMinutes * 60_000;
  return Math.floor((shifted % 86_400_000) / 60_000);
}

/** True when `now` sits inside [start, end) — supports windows that cross midnight. */
export function inNightWindow(now: Date, window: WalletBudgetNightWindow): boolean {
  const offset = window.offset_minutes ?? WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES;
  const m = localMinutes(now, offset);
  const start = minutesOfHHMM(window.start);
  const end = minutesOfHHMM(window.end);
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** UTC instant the current SDQ day opened (fixed offset, no DST). */
export function dayWindowStart(now: Date, offsetMinutes = WALLET_NIGHT_WINDOW_DEFAULT_OFFSET_MINUTES): Date {
  const shifted = now.getTime() + offsetMinutes * 60_000;
  return new Date(Math.floor(shifted / 86_400_000) * 86_400_000 - offsetMinutes * 60_000);
}

/** UTC instant the current Monday-anchored week opened at `anchorUtc` ("HH:MM", default 00:00). */
export function weekWindowStart(now: Date, anchorUtc = '00:00'): Date {
  const anchorMinutes = HHMM_RE.test(anchorUtc) ? minutesOfHHMM(anchorUtc) : 0;
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const utcMidnight = Math.floor(now.getTime() / 86_400_000) * 86_400_000;
  let start = utcMidnight - daysSinceMonday * 86_400_000 + anchorMinutes * 60_000;
  if (start > now.getTime()) start -= 7 * 86_400_000;
  return new Date(start);
}

/**
 * The "owner-answer" pseudo-entry: the request was sent by a turn that is
 * answering an owner message, expressed as a trigger header the coordinator
 * sets (`x-manifest-trigger: owner-<message-id>`). Anything else — plain
 * session traffic, scheduled sweeps — does not match.
 */
export function isOwnerAnswerTrigger(triggerHeader: string | null | undefined): boolean {
  return typeof triggerHeader === 'string' && /^owner-/.test(triggerHeader.trim().toLowerCase());
}

/**
 * Night-window allowlist match: a caller passes when any allow entry equals
 * (case-insensitively) the caller's tier or agent name, or when the entry is
 * the `owner-answer` pseudo-entry and the request carries an owner trigger.
 */
export function callerIsAllowlisted(allow: string[] | null | undefined, caller: WalletGateCallerContext): boolean {
  if (!allow || allow.length === 0) return false;
  const tier = (caller.tierName ?? '').trim().toLowerCase();
  const agent = (caller.agentName ?? '').trim().toLowerCase();
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (e === 'owner-answer') return isOwnerAnswerTrigger(caller.triggerHeader);
    if (!e) return false;
    return (tier !== '' && e === tier) || (agent !== '' && e === agent);
  });
}

function fmtUsd(value: number): string {
  return `${value.toFixed(2)} USD`;
}

/**
 * Decide one admission against one wallet. Order: daily cap, weekly cap,
 * then the night window. Caps are hard (never allowlist-bypassed); the night
 * window is a WHO filter and consults the allowlist.
 */
export function evaluateWalletBudget(
  config: WalletBudgetConfig,
  spend: WalletSpend,
  caller: WalletGateCallerContext,
  now: Date,
): WalletBudgetDecision {
  if (config.daily_usd !== undefined && config.daily_usd !== null) {
    if (spend.day_usd >= config.daily_usd) {
      return {
        allowed: false,
        rule: 'daily_cap',
        detail: `day spend ${fmtUsd(spend.day_usd)} >= daily line ${fmtUsd(config.daily_usd)}`,
      };
    }
  }
  if (config.weekly_usd !== undefined && config.weekly_usd !== null) {
    if (spend.week_usd >= config.weekly_usd) {
      return {
        allowed: false,
        rule: 'weekly_cap',
        detail: `week spend ${fmtUsd(spend.week_usd)} >= weekly line ${fmtUsd(config.weekly_usd)}`,
      };
    }
  }
  const window = config.night_window;
  if (window && inNightWindow(now, window)) {
    if (!callerIsAllowlisted(config.allow, caller)) {
      return {
        allowed: false,
        rule: 'night_window',
        detail: `inside night window ${window.start}-${window.end} (SDQ) and caller is not allowlisted`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Pin-aware candidate order for the in-router budget failover: a pinned
 * connection still gets first claim (today's behavior), but when it is over
 * its line the next wallet in the owner chain takes the call.
 */
export function orderCandidates<K extends { label: string }>(keys: K[], pin?: string | null): K[] {
  if (!pin) return keys;
  const p = pin.toLowerCase();
  const idx = keys.findIndex((k) => k.label.toLowerCase() === p);
  if (idx <= 0) return keys;
  return [keys[idx], ...keys.slice(0, idx), ...keys.slice(idx + 1)];
}

/** HTTP status for a wallet-budget rejection: policy, not auth — 429. */
export const WALLET_BUDGET_HTTP_STATUS = 429;

/**
 * Pull the owner-answer trigger header out of a request's headers. The
 * coordinator turn that is ANSWERING an owner message sends
 * `x-manifest-trigger: owner-<message-id>`; scheduled sweeps and background
 * sessions send nothing, which is exactly the distinction the tier policy
 * (architect answer-only) and the night-window `owner-answer` allowlist
 * entry rely on. Header names arrive lowercased from Node/Express.
 */
export function triggerHeaderValue(
  headers: Record<string, unknown> | undefined | null,
): string | null {
  if (!headers) return null;
  const raw = headers['x-manifest-trigger'] ?? headers['X-Manifest-Trigger'];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim();
}

/**
 * The admission gate `resolveRouteCredentials` consults when wallet budgets
 * govern. Implemented by WalletBudgetService; kept as an interface so the
 * routing module depends on the contract, not on Nest wiring, and specs can
 * pass fakes. All reads are fresh per request — flipping the wallet's
 * `budget` row changes behavior on the next request.
 */
export interface WalletBudgetGate {
  /** Current posture from the mode env var; `off` disables the whole gate. */
  mode(): WalletBudgetMode;
  /** The provider's key chain in priority order — the owner chain to walk. */
  listProviderKeys(
    tenantId: string,
    provider: string,
    authType?: string,
    agentId?: string,
  ): Promise<Array<{ id: string; label: string; apiKey: string | null; region?: string | null }>>;
  /** Fresh read + parse of one wallet's `budget` column (config null = ungoverned). */
  configFor(tenantProviderId: string): Promise<ParsedWalletBudget>;
  /** Spend aggregation + decision for one wallet, evaluated at `now`. */
  decide(
    config: WalletBudgetConfig,
    tenantProviderId: string,
    caller: WalletGateCallerContext,
    now: Date,
  ): Promise<{ spend: WalletSpend; decision: WalletBudgetDecision }>;
  /** Structured log line for a wallet the gate refused (shadow + enforce trail). */
  noteBlocked(
    walletLabel: string,
    decision: Extract<WalletBudgetDecision, { allowed: false }>,
    config: WalletBudgetConfig,
    spend: WalletSpend,
    caller: WalletGateCallerContext,
  ): void;
}

/**
 * User-facing M200 presentation for a wallet rejection. Reuses the existing
 * `limit_exceeded` reason + M200 code so the error taxonomy, recording, and
 * analytics need zero changes; the wallet/rule live in the interpolated
 * variables and in the recorded attempt's tenant_provider_id + error message.
 */
export function walletBudgetMessage(
  walletLabel: string,
  decision: Extract<WalletBudgetDecision, { allowed: false }>,
  config: WalletBudgetConfig,
  spend: WalletSpend,
): { metric: string; used: string; threshold: string; period: string } {
  switch (decision.rule) {
    case 'daily_cap':
      return {
        metric: `${walletLabel} wallet daily cap`,
        used: fmtUsd(spend.day_usd),
        threshold: fmtUsd(config.daily_usd ?? 0),
        period: 'today (SDQ)',
      };
    case 'weekly_cap':
      return {
        metric: `${walletLabel} wallet weekly cap`,
        used: fmtUsd(spend.week_usd),
        threshold: fmtUsd(config.weekly_usd ?? 0),
        period: 'this week',
      };
    case 'night_window': {
      const window = config.night_window;
      return {
        metric: `${walletLabel} wallet night window`,
        used: 'blocked',
        threshold: window ? `${window.start}-${window.end} SDQ` : 'night window',
        period: 'night; allowlisted callers and owner answers only',
      };
    }
  }
}
