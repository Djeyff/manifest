import { fetchJson, fetchMutate } from './core';

/**
 * Wallet console (RET-721) — the owner-only console on mnfs.retena.app.
 *
 * Contract notes:
 * - Every budget number in here is SERVER-PROVIDED. The console never does
 *   budget arithmetic on the client: `allowed_pct`, `used_pct` and
 *   `projected_pct` arrive already computed, together with the component
 *   strips that spell the arithmetic out (base + rollover + reserve − floor).
 *   The UI renders those strips verbatim.
 * - The live API (RET-720) may not be deployed yet. When it is missing the
 *   console falls back to the demo payload below and labels itself
 *   `demo: true` so the owner can tell demo data from live data.
 */

export interface WalletFormulaStrip {
  /** Human label for the whole strip, e.g. "today allowed". */
  label: string;
  /** Ordered terms of the formula. `op` is the operator that precedes it. */
  terms: Array<{ op: string; label: string; value: number; unit?: string }>;
  /** The server-computed result of the strip. */
  result: { label: string; value: number; unit?: string };
  /** Ruling that governs this arithmetic, when one applies. */
  ruling_id?: string | null;
}

export interface WalletLine {
  wallet_id: string;
  name: string;
  color: string;
  provider: string;
  /** Component values (server-computed). */
  base_pct: number;
  rollover_pct: number;
  reserve_pct: number;
  floor_pct: number;
  /** Server-computed result of base + rollover + reserve − floor. */
  allowed_pct: number;
  formula: WalletFormulaStrip;
  /** Underlying USD lines, when the wallet is governed by them. */
  daily_usd?: number | null;
  weekly_usd?: number | null;
  /** Provider-supplied reset stamp. */
  resets_at?: string | null;
  resets_label?: string | null;
  reset_hint?: string | null;
  /** Backup-as-finite-spare notes (owner pick D-2026-11-20-22). */
  note?: string | null;
}

export interface WalletAuditEntry {
  at: string;
  /** Short line describing the change, e.g. "MAIN rollover set 4.3%". */
  summary: string;
  ruling_id?: string | null;
}

export interface WalletBehaviour {
  drain_auto_lift: boolean;
  parked: boolean;
  kill_switch_to_fallback: boolean;
  budget_mode: 'enforce' | 'shadow' | 'off';
  budget_mode_source?: string | null;
}

export interface WalletPriorityRow {
  wallet_id: string;
  name: string;
  rank: number;
  lane_tags: string[];
  lane_tags_live?: boolean;
  pill: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'drain' | 'info' };
}

export interface WalletSettingsResponse {
  /** True when the payload is the built-in demo fallback, not live data. */
  demo: boolean;
  week_anchor?: string | null;
  night_window?: string | null;
  lines: WalletLine[];
  behaviour: WalletBehaviour;
  priority: WalletPriorityRow[];
  audit: WalletAuditEntry[];
  members: Array<{ wallet: string; keys: string }>;
  /** Latest governor tick, so the owner sees the gate re-read the line. */
  governor_tick?: {
    at: string;
    mode: string;
    allowed_pct: number;
    used_pct: number;
  } | null;
}

export interface LoadBalancerCard {
  wallet_id: string;
  name: string;
  provider: string;
  state: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' };
  lane_tags: string[];
  lane_tags_live?: boolean;
  in_flight: number;
  ceiling: number;
  window: { pct_left: number; resets_label?: string | null };
  weekly: { pct_left: number; resets_label?: string | null };
  priority: number;
  priority_hint?: string | null;
  provider_state: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; detail?: string | null };
}

export interface LoadBalancerResponse {
  demo: boolean;
  admission: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' };
  cards: LoadBalancerCard[];
  provider_state: Array<{ provider: string; value: string }>;
  lane_targets?: { target_band: string } | null;
}

export interface ProgressBlock {
  wallet_id: string;
  name: string;
  color: string;
  provider: string;
  used_pct: number;
  allowed_pct: number;
  projected_pct: number;
  still_allowed_pct: number;
  floor_pct: number;
  pace: 'ahead' | 'on-pace' | 'behind';
  badges: string[];
  formula: WalletFormulaStrip;
  resets_label?: string | null;
  reset_hint?: string | null;
  note?: string | null;
}

export interface BurnMeter {
  in_flight: number;
  recommended: number;
  quota_headroom_pct: number;
  target_band: string;
  verdict: string;
  /** Advisory only — the gauge proposes, it never moves a lane by itself. */
  advisory: boolean;
}

export interface HeatmapCell {
  /** Percent of weekly allowance burned, or null for a day that hasn't happened. */
  pct: number | null;
  state: 'under' | 'on' | 'over' | 'burn' | 'future';
}

export interface HeatmapWeek {
  label: string;
  cells: HeatmapCell[];
}

export interface ProgressResponse {
  demo: boolean;
  blocks: ProgressBlock[];
  burn: BurnMeter;
  heatmap: { weeks: HeatmapWeek[]; note?: string | null };
  day_strip?: Array<{ day: string; pct: number; over?: boolean; drain?: boolean }> | null;
}

export interface AskCrewResponse {
  ok: boolean;
  demo: boolean;
  card_ref?: string | null;
}

export interface WalletConsoleAccess {
  /** True when the signed-in user owns the tenant. */
  owner: boolean;
  demo: boolean;
}

const DEMO_STAMP = '2026-11-21T00:24:00.000Z';

function demoFormula(
  label: string,
  base: number,
  rollover: number,
  reserve: number,
  floor: number,
  allowed: number,
): WalletFormulaStrip {
  return {
    label,
    terms: [
      { op: '', label: 'base', value: base, unit: '%' },
      { op: '+', label: 'rollover carried in', value: rollover, unit: '%' },
      { op: '+', label: 'daily reserve', value: reserve, unit: '%' },
      { op: '−', label: 'emergency floor', value: floor, unit: '%' },
    ],
    result: { label: `${label} =`, value: allowed, unit: '%' },
    ruling_id: 'D-2026-11-19-04',
  };
}

export const DEMO_SETTINGS: WalletSettingsResponse = {
  demo: true,
  week_anchor: 'Mon 00:00Z',
  night_window: '00:00–05:00 UTC-4',
  lines: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      color: 'main',
      provider: 'zai-max',
      base_pct: 10.0,
      rollover_pct: 4.3,
      reserve_pct: 4.3,
      floor_pct: 4.0,
      allowed_pct: 14.6,
      formula: demoFormula('today allowed', 10.0, 4.3, 4.3, 4.0, 14.6),
      resets_at: '2026-11-21T07:13:00.000Z',
      resets_label: 'Fri 07:13Z',
      reset_hint: 'Resets weekly Fri 07:13Z (provider stamp).',
    },
    {
      wallet_id: 'w-mm',
      name: 'MM',
      color: 'mm',
      provider: 'minimax',
      base_pct: 10.0,
      rollover_pct: 2.1,
      reserve_pct: 4.3,
      floor_pct: 4.0,
      allowed_pct: 12.4,
      formula: demoFormula('today allowed', 10.0, 2.1, 4.3, 4.0, 12.4),
      resets_at: '2026-11-22T00:00:00.000Z',
      resets_label: 'Sat 00:00Z',
      reset_hint: 'Resets Sat 00:00Z — the tightest line we carry.',
    },
    {
      wallet_id: 'w-backup',
      name: 'BACKUP',
      color: 'backup',
      provider: 'zai-pro',
      base_pct: 10.0,
      rollover_pct: 0.0,
      reserve_pct: 4.3,
      floor_pct: 4.0,
      allowed_pct: 10.3,
      formula: demoFormula('today allowed', 10.0, 0.0, 4.3, 4.0, 10.3),
      resets_at: '2026-11-22T00:00:00.000Z',
      resets_label: 'Sat 00:00Z',
      reset_hint: 'Held in reserve; draws only when MAIN and MM are capped.',
      note: 'Finite spare — roughly 9% of the reserve is left and there is no refill. Gone after early Dec.',
    },
  ],
  behaviour: {
    drain_auto_lift: true,
    parked: false,
    kill_switch_to_fallback: false,
    budget_mode: 'enforce',
    budget_mode_source: 'MANIFEST_WALLET_BUDGET_MODE',
  },
  priority: [
    {
      wallet_id: 'w-main',
      name: 'MAIN · zai-max',
      rank: 1,
      lane_tags: ['RCR', 'CCR'],
      lane_tags_live: true,
      pill: { label: 'primary', tone: 'neutral' },
    },
    {
      wallet_id: 'w-mm',
      name: 'MM · minimax',
      rank: 2,
      lane_tags: ['RCR MM', 'CCR MM'],
      lane_tags_live: true,
      pill: { label: '48% left', tone: 'warn' },
    },
    {
      wallet_id: 'w-backup',
      name: 'BACKUP · zai-pro',
      rank: 3,
      lane_tags: ['RCR Backup', 'CCR Backup'],
      pill: { label: 'standby', tone: 'neutral' },
    },
  ],
  audit: [
    { at: '2026-11-21T00:04:00.000Z', summary: 'MAIN rollover set 4.3%', ruling_id: 'D-2026-11-21-03' },
    {
      at: '2026-11-20T21:21:00.000Z',
      summary: 'Budget mode → enforce, 5 wallet lines seeded',
      ruling_id: 'D-2026-11-20-10',
    },
    {
      at: '2026-11-20T17:02:00.000Z',
      summary: 'Drain-day auto-lift enabled on all wallets',
      ruling_id: 'D-2026-11-20-09',
    },
    {
      at: '2026-11-19T23:23:00.000Z',
      summary: 'Daily line doctrine corrected: base + reserve + rollover',
      ruling_id: 'D-2026-11-19-04',
    },
  ],
  members: [
    { wallet: 'MAIN members', keys: 'RCR, CCR' },
    { wallet: 'MM members', keys: 'RCR MM, CCR MM' },
    { wallet: 'BACKUP members', keys: 'RCR Backup, CCR Backup' },
  ],
  governor_tick: { at: DEMO_STAMP, mode: 'enforce', allowed_pct: 14.6, used_pct: 9.1 },
};

export const DEMO_BALANCER: LoadBalancerResponse = {
  demo: true,
  admission: { label: 'admission live', tone: 'ok' },
  cards: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      provider: 'zai-max',
      state: { label: 'drawing', tone: 'ok' },
      lane_tags: ['RCR', 'CCR'],
      lane_tags_live: true,
      in_flight: 8,
      ceiling: 10,
      window: { pct_left: 84, resets_label: 'resets 2h 41m' },
      weekly: { pct_left: 97, resets_label: 'resets Fri 07:13Z' },
      priority: 1,
      priority_hint: 'primary draw',
      provider_state: { label: 'no halt', tone: 'ok', detail: 'last error 1302 ×116' },
    },
    {
      wallet_id: 'w-mm',
      name: 'MM',
      provider: 'minimax',
      state: { label: 'draining', tone: 'warn' },
      lane_tags: ['RCR MM', 'CCR MM'],
      lane_tags_live: true,
      in_flight: 3,
      ceiling: 10,
      window: { pct_left: 97, resets_label: 'resets 1h 52m' },
      weekly: { pct_left: 48, resets_label: 'resets Sat 00:00Z' },
      priority: 2,
      priority_hint: 'volume worker target',
      provider_state: { label: 'backoff 30s', tone: 'warn', detail: '1310 ×162 · retry-after hint ×2' },
    },
    {
      wallet_id: 'w-backup',
      name: 'BACKUP',
      provider: 'zai-pro',
      state: { label: 'standby', tone: 'neutral' },
      lane_tags: ['RCR Backup', 'CCR Backup'],
      in_flight: 0,
      ceiling: 10,
      window: { pct_left: 81, resets_label: 'resets 3h 04m' },
      weekly: { pct_left: 70, resets_label: 'resets Nov 25 06:44Z' },
      priority: 3,
      priority_hint: 'draws only when capped',
      provider_state: { label: 'no halt', tone: 'ok', detail: 'clean' },
    },
  ],
  provider_state: [
    { provider: 'zai-max', value: 'ok · 1302 ×116' },
    { provider: 'minimax', value: 'backoff 30s · 1310 ×162' },
    { provider: 'zai-pro', value: 'ok · clean' },
    { provider: 'Last halt', value: 'none since 04:12Z' },
    { provider: 'Fallback key', value: 'armed' },
  ],
  lane_targets: { target_band: '8–10 lanes' },
};

export const DEMO_PROGRESS: ProgressResponse = {
  demo: true,
  blocks: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      color: 'main',
      provider: 'zai-max',
      used_pct: 9.1,
      allowed_pct: 14.6,
      projected_pct: 13.8,
      still_allowed_pct: 5.5,
      floor_pct: 4.0,
      pace: 'on-pace',
      badges: ['drain-day · 85% lift active'],
      formula: demoFormula('today allowed', 10.0, 4.3, 4.3, 4.0, 14.6),
      resets_label: 'resets Fri 07:13Z',
      reset_hint: '6h 49m left',
    },
    {
      wallet_id: 'w-mm',
      name: 'MM',
      color: 'mm',
      provider: 'minimax',
      used_pct: 11.2,
      allowed_pct: 12.4,
      projected_pct: 24.6,
      still_allowed_pct: 1.2,
      floor_pct: 4.0,
      pace: 'behind',
      badges: [],
      formula: demoFormula('today allowed', 10.0, 2.1, 4.3, 4.0, 12.4),
      resets_label: 'resets Sat 00:00Z',
      reset_hint: '23h 36m left',
      note: 'Behind pace. At the current rate MM projects to 24.6% of its line by reset — double its 12.4% allowance. The floor is still untouched (4.0% locked), so this is a pace problem, not a budget breach.',
    },
    {
      wallet_id: 'w-backup',
      name: 'BACKUP',
      color: 'backup',
      provider: 'zai-pro',
      used_pct: 0.4,
      allowed_pct: 10.3,
      projected_pct: 1.1,
      still_allowed_pct: 9.9,
      floor_pct: 4.0,
      pace: 'ahead',
      badges: [],
      formula: demoFormula('today allowed', 10.0, 0.0, 4.3, 4.0, 10.3),
      resets_label: 'resets Sat 00:00Z',
      reset_hint: '23h 36m left · standby',
    },
  ],
  burn: {
    in_flight: 8,
    recommended: 7,
    quota_headroom_pct: 72,
    target_band: '8–10 lanes',
    verdict: 'slow by 1',
    advisory: true,
  },
  heatmap: {
    weeks: [
      {
        label: 'W-3',
        cells: [
          { pct: 92, state: 'on' },
          { pct: 118, state: 'over' },
          { pct: 104, state: 'on' },
          { pct: 61, state: 'under' },
          { pct: 141, state: 'burn' },
          { pct: 99, state: 'on' },
          { pct: 44, state: 'under' },
        ],
      },
      {
        label: 'W-2',
        cells: [
          { pct: 97, state: 'on' },
          { pct: 88, state: 'on' },
          { pct: 126, state: 'over' },
          { pct: 108, state: 'on' },
          { pct: 163, state: 'burn' },
          { pct: 112, state: 'over' },
          { pct: 52, state: 'under' },
        ],
      },
      {
        label: 'W-1',
        cells: [
          { pct: 101, state: 'on' },
          { pct: 94, state: 'on' },
          { pct: 121, state: 'over' },
          { pct: 110, state: 'on' },
          { pct: 129, state: 'over' },
          { pct: 106, state: 'on' },
          { pct: 49, state: 'under' },
        ],
      },
      {
        label: 'This',
        cells: [
          { pct: 103, state: 'on' },
          { pct: 96, state: 'on' },
          { pct: 119, state: 'over' },
          { pct: 112, state: 'on' },
          { pct: 62, state: 'on' },
          { pct: null, state: 'future' },
          { pct: null, state: 'future' },
        ],
      },
    ],
    note: 'The pattern is the story: Thursday–Friday burn, Saturday sleeps. Weekends carry ~50% of a weekday, so the weekly line drains on the working days and rests when no one is asking.',
  },
  day_strip: [
    { day: '08', pct: 44, drain: true },
    { day: '09', pct: 52 },
    { day: '10', pct: 38 },
    { day: '11', pct: 71, over: true },
    { day: '12', pct: 47 },
    { day: '13', pct: 29 },
    { day: '14', pct: 66, over: true },
    { day: '15', pct: 41 },
    { day: '16', pct: 55 },
    { day: '17', pct: 48, drain: true },
    { day: '18', pct: 33 },
    { day: '19', pct: 58 },
    { day: '20', pct: 74, over: true },
    { day: '21', pct: 62 },
  ],
};

/**
 * Reads a console endpoint, falling back to the demo payload when the live
 * API is not deployed yet (404/501) or the request fails. The fallback never
 * masks an auth failure: a 401/403 is re-thrown so the owner gate holds.
 */
async function readWithFallback<T>(
  path: string,
  fallback: T,
): Promise<T> {
  try {
    const data = await fetchJson<T>(path, undefined, { cache: false });
    return { ...(data as object), demo: false } as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Unauthorized|session|401|403/i.test(message)) throw err;
    return fallback;
  }
}

export function getWalletSettings(): Promise<WalletSettingsResponse> {
  return readWithFallback<WalletSettingsResponse>('/wallets/console/settings', DEMO_SETTINGS);
}

export function getLoadBalancer(): Promise<LoadBalancerResponse> {
  return readWithFallback<LoadBalancerResponse>('/wallets/console/balancer', DEMO_BALANCER);
}

export function getDailyProgress(): Promise<ProgressResponse> {
  return readWithFallback<ProgressResponse>('/wallets/console/progress', DEMO_PROGRESS);
}

/**
 * Owner access check. When the endpoint is missing the console falls back to
 * "owner: true" so the demo build stays usable, but the response is flagged
 * `demo: true` so the UI can label the gate as unverified.
 */
export async function getWalletConsoleAccess(): Promise<WalletConsoleAccess> {
  try {
    const data = await fetchJson<{ owner: boolean }>('/wallets/console/access', undefined, {
      cache: false,
    });
    return { owner: data.owner === true, demo: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Unauthorized|session|401/i.test(message)) return { owner: false, demo: false };
    return { owner: true, demo: true };
  }
}

export interface UpdateLineInput {
  wallet_id: string;
  base_pct?: number;
  rollover_pct?: number;
}

/** Round-trips one settings line change. The response carries the new line. */
export async function updateWalletLine(input: UpdateLineInput): Promise<WalletSettingsResponse> {
  try {
    const data = await fetchMutate<WalletSettingsResponse>(
      `/wallets/console/settings/${encodeURIComponent(input.wallet_id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_pct: input.base_pct,
          rollover_pct: input.rollover_pct,
        }),
      },
    );
    return { ...data, demo: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/API error: 404|API error: 501|Not Found/i.test(message)) throw err;
    // Demo mode: apply the change locally so the round-trip (governor tick,
    // audit row, ruling) is still demonstrable without the live API.
    const settings = structuredClone(DEMO_SETTINGS);
    const line = settings.lines.find((l) => l.wallet_id === input.wallet_id);
    if (!line) throw new Error('Unknown wallet line');
    if (input.base_pct !== undefined) line.base_pct = input.base_pct;
    if (input.rollover_pct !== undefined) line.rollover_pct = input.rollover_pct;
    const allowed =
      line.base_pct + line.rollover_pct + line.reserve_pct - line.floor_pct;
    line.allowed_pct = allowed;
    line.formula = {
      ...line.formula,
      terms: line.formula.terms.map((term) => {
        if (term.label === 'base') return { ...term, value: line.base_pct };
        if (term.label === 'rollover carried in') return { ...term, value: line.rollover_pct };
        return term;
      }),
      result: { ...line.formula.result, value: allowed },
    };
    const at = new Date().toISOString();
    settings.audit = [
      {
        at,
        summary: `${line.name} line updated (base ${line.base_pct.toFixed(1)}%, rollover ${line.rollover_pct.toFixed(1)}%)`,
        ruling_id: 'D-DEMO-LOCAL',
      },
      ...settings.audit,
    ];
    settings.governor_tick = {
      at,
      mode: settings.behaviour.budget_mode,
      allowed_pct: allowed,
      used_pct: settings.governor_tick?.used_pct ?? 0,
    };
    return settings;
  }
}

/** Files a needs-you card for the crew. */
export async function askCrew(message: string): Promise<AskCrewResponse> {
  try {
    const data = await fetchMutate<AskCrewResponse>('/wallets/console/ask-crew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    return { ...data, demo: false };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    if (!/API error: 404|API error: 501|Not Found/i.test(messageText)) throw err;
    return { ok: true, demo: true, card_ref: 'needs-you (demo)' };
  }
}
