import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchJson = vi.fn();
const mockFetchMutate = vi.fn();

vi.mock('../../src/services/api/core', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  fetchMutate: (...args: unknown[]) => mockFetchMutate(...args),
}));

import {
  askCrew,
  getDailyProgress,
  getLoadBalancer,
  getWalletConsoleAccess,
  getWalletSettings,
  updateWalletLine,
} from '../../src/services/api/wallet-console';

/* ------------------------------------------------------------------ */
/* Fixtures — the real RET-720 shapes (commit 54047be73)                */
/* ------------------------------------------------------------------ */

const quotaBoard = {
  generated_at: '2026-11-21T18:53:25.000Z',
  polled_at: '2026-11-21T18:53:25.000Z',
  stale_feed: false,
  ration: { available: true, updated_at: '2026-11-21T18:40:00.000Z', unavailable_reason: null },
  wallets: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      color: 'main',
      parked: false,
      priority: 1,
      drain_day_enabled: true,
      halted: false,
      min_five_h_pct_left: 57.5,
      min_weekly_pct_left: 28.8,
      keys: [
        {
          label: 'RCR',
          provider: 'zai',
          account: 'MAIN',
          five_h_pct_left: 57.5,
          weekly_pct_left: 28.8,
          five_h_reset_at: '2026-11-22T07:13:00.000Z',
          weekly_reset_at: '2026-11-28T07:13:00.000Z',
          plan_level: 'pro',
          subscription_status: 'active',
          seen_at: '2026-11-21T18:53:20.000Z',
          stale: false,
          error: null,
          halted: false,
        },
      ],
    },
  ],
};

const dailyBudget = {
  generated_at: '2026-11-21T18:53:25.000Z',
  available: true,
  unavailable_reason: null,
  ration_updated_at: '2026-11-21T18:40:00.000Z',
  accounts: [
    {
      account: 'MAIN',
      keys: ['RCR'],
      allowed_today_pct: 10.74409,
      used_today_pct: 4.092248,
      remaining_today_pct: 6.651842,
      base_pct: 10,
      rollover_pool_pct: 0.74409,
      floor_pct: 4,
      reserve_pct: 4.28571,
      accrued_at_lift_pct: 8.57142,
      available_pct: 10.74409,
      weekly_headroom_pct: 28.8,
      five_h_headroom_pct: 57.5,
      spent_week_pct: 41.2,
      weekly_pool: 1200,
      denomination: 'credits',
      drain_day: false,
      drain_window: false,
      allow: true,
      halted: false,
      day_number: 1,
      day_index: 0,
      ration_model: 'RET-670-V3',
      reasons: [],
      halted_by_console: false,
      anchor: { epoch: 1763700000, source: 'provider', stale: false, note: 'provider reset stamp' },
      day_epoch: 1763700000,
      day_start_utc: '00:00',
      day_elapsed_hours: 3,
      pace_pct_per_h: 1.364,
      projected_end_pct: 24.644,
      working_hours_left: 15,
    },
  ],
  wallets: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      accounts: ['MAIN'],
      parked: false,
      drain_day_enabled: true,
      daily_lines: { base_pct: 10, rollover_pool_pct: 0.74409, floor_pct: 4 },
    },
  ],
  engine: {
    rollover_enabled: true,
    rollover_model: 'carry-surplus',
    rollover_mode: 'strict',
    rollover_active: 'RCR',
    rollover_reason: 'completed-day surplus replayed',
    primary: 'RCR',
    primary_usable_pct: 28.8,
    backup: 'CCR set',
    backup_usable_pct: 12.4,
    backup_membership_active: true,
    backup_membership_end: '2026-12-01T00:00:00.000Z',
    new_ration_day: false,
    week_start: '2026-11-18T00:00:00.000Z',
    day_start_utc: '00:00',
    day_epoch: '2026-11-21T00:00:00.000Z',
    enforce_tick_at: '2026-11-21T18:40:00.000Z',
  },
};

const rawSettings = {
  wallet_id: 'w-main',
  tenant_id: 't-1',
  drain_day_enabled: true,
  priority: 1,
  parked: false,
  kill_switch_fallback: false,
  daily_lines: { base_pct: 10, rollover_pool_pct: 0.74409, floor_pct: 4 },
  reserve_pct: 4.28571,
  rollover_enabled: true,
  cross_class_pause: false,
  key_bindings: [{ room: 'RCR', tenant_provider_id: 'tp-1', label: 'RCR', provider: 'zai' }],
  updated_at: '2026-11-21T18:40:00.000Z',
  updated_by_user_id: 'u-1',
};

/** Routes each live URL to its fixture. */
function routeLiveFetch() {
  mockFetchJson.mockImplementation((url: string) => {
    if (url === '/quota-board') return Promise.resolve(quotaBoard);
    if (url === '/budgets/daily') return Promise.resolve(dailyBudget);
    if (url === '/wallets/w-main/settings') return Promise.resolve({ settings: rawSettings });
    if (url === '/wallets/w-main/settings/audit')
      return Promise.resolve({
        audit: [
          {
            wallet_id: 'w-main',
            actor_user_id: 'u-1',
            action: 'settings updated',
            before: { base_pct: 10 },
            after: { base_pct: 11 },
            ruling_id: 'D-2026-11-21-01',
            created_at: '2026-11-21T18:40:00.000Z',
          },
        ],
      });
    return Promise.reject(new Error(`API error: 404 Not Found (${url})`));
  });
}

beforeEach(() => {
  mockFetchJson.mockReset();
  mockFetchMutate.mockReset();
  routeLiveFetch();
});

describe('wallet console reads (live RET-720 contract)', () => {
  it('reads the quota board, the daily budget, the settings and the audit trail', async () => {
    const data = await getWalletSettings();
    expect(mockFetchJson).toHaveBeenCalledWith('/quota-board', undefined, expect.anything());
    expect(mockFetchJson).toHaveBeenCalledWith('/budgets/daily', undefined, expect.anything());
    expect(mockFetchJson).toHaveBeenCalledWith(
      '/wallets/w-main/settings',
      undefined,
      expect.anything(),
    );
    expect(mockFetchJson).toHaveBeenCalledWith(
      '/wallets/w-main/settings/audit',
      undefined,
      expect.anything(),
    );
    expect(data.lines[0].wallet_id).toBe('w-main');
    // The server's own numbers, not a client-side sum.
    expect(data.lines[0].allowed_pct).toBeCloseTo(10.74409, 6);
  });

  it('spells the line out as base + rollover − floor from the server strip', async () => {
    const data = await getWalletSettings();
    const strip = data.lines[0].formula;
    const labels = strip.terms.map((t) => t.label);
    expect(labels).toContain('base');
    expect(labels).toContain('rollover pool');
    expect(labels).toContain('locked floor');
    expect(strip.result.value).toBeCloseTo(10.74409, 6);
  });

  it('names the wallet with its plan (MAIN (Z.AI Max)), not a raw provider label', async () => {
    const data = await getWalletSettings();
    expect(data.lines[0].display_name).toBe('MAIN (Z.AI Max)');
    expect(data.lines[0].provider).toBe('zai');
  });

  it('maps the balancer board onto live cards', async () => {
    const data = await getLoadBalancer();
    expect(data.cards[0].name).toBe('MAIN');
    expect(data.cards[0].display_name).toBe('MAIN (Z.AI Max)');
    expect(data.cards[0].window.pct_left).toBeCloseTo(57.5, 3);
    expect(data.cards[0].weekly.pct_left).toBeCloseTo(28.8, 3);
    expect(data.admission.tone).toBe('ok');
  });

  it('publishes the allowance engine state the balancer page renders', async () => {
    const data = await getLoadBalancer();
    expect(data.engine).not.toBeNull();
    expect(data.engine?.rollover_enabled).toBe(true);
    expect(data.engine?.primary).toBe('RCR');
    expect(data.engine?.backup).toBe('CCR set');
    expect(data.engine?.day_start_utc).toBe('00:00');
    expect(data.enforce_tick_at).toBe('2026-11-21T18:40:00.000Z');
  });

  it('publishes one day line per wallet account with the engine arithmetic', async () => {
    const data = await getLoadBalancer();
    expect(data.day_lines.length).toBe(1);
    const line = data.day_lines[0];
    expect(line.wallet_id).toBe('w-main');
    expect(line.display_name).toBe('MAIN (Z.AI Max)');
    expect(line.day_label).toBe('day 1');
    expect(line.base_pct).toBeCloseTo(10, 6);
    expect(line.rollover_pct).toBeCloseTo(0.74409, 6);
    expect(line.reserve_pct).toBeCloseTo(4.28571, 6);
    expect(line.allowed_pct).toBeCloseTo(10.74409, 6);
    expect(line.used_pct).toBeCloseTo(4.092248, 6);
    expect(line.remaining_pct).toBeCloseTo(6.651842, 6);
    expect(line.pace_pct_per_h).toBeCloseTo(1.364, 3);
    expect(line.projected_end_pct).toBeCloseTo(24.644, 3);
    expect(line.five_h.pct_left).toBeCloseTo(57.5, 3);
    expect(line.weekly.pct_left).toBeCloseTo(28.8, 3);
  });

  it('maps the daily budget onto progress blocks with the used/allowed split', async () => {
    const data = await getDailyProgress();
    expect(data.available).toBe(true);
    expect(data.blocks[0].used_pct).toBeCloseTo(4.092248, 6);
    expect(data.blocks[0].allowed_pct).toBeCloseTo(10.74409, 6);
    expect(data.blocks[0].still_allowed_pct).toBeCloseTo(6.651842, 6);
    expect(data.blocks[0].published).toBe(true);
    expect(data.blocks[0].account).toBe('MAIN');
  });

  it('reports the provider-own burn fields the progress page renders', async () => {
    const data = await getDailyProgress();
    const block = data.blocks[0];
    expect(block.five_h.pct_left).toBeCloseTo(57.5, 3);
    expect(block.five_h.resets_label).toBeTruthy();
    expect(block.weekly.pct_left).toBeCloseTo(28.8, 3);
    expect(block.spent_week_pct).toBeCloseTo(41.2, 3);
    expect(block.weekly_pool).toBe(1200);
    expect(block.denomination).toBe('credits');
    expect(block.pace_pct_per_h).toBeCloseTo(1.364, 3);
    expect(block.projected_end_pct).toBeCloseTo(24.644, 3);
    expect(block.working_hours_left).toBe(15);
    expect(block.reserve_pct).toBeCloseTo(4.28571, 6);
    expect(block.rollover_pct).toBeCloseTo(0.74409, 6);
    expect(block.day_start_utc).toBe('00:00');
    expect(block.anchor_stale).toBe(false);
  });

  it('reports the governor’s own day window instead of a wall-clock midnight', async () => {
    const data = await getDailyProgress();
    expect(data.blocks[0].day_label).toBe('day 1');
    expect(data.blocks[0].resets_label).toBe('day 1');
  });

  it('draws no bar when the governor published no line (no 0.0% fiction)', async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url === '/quota-board') return Promise.resolve(quotaBoard);
      if (url === '/budgets/daily')
        return Promise.resolve({
          ...dailyBudget,
          available: false,
          unavailable_reason: 'ration state unreadable at /opt/data/shared/state/ret670-ration.json',
          accounts: [],
          wallets: [{ ...dailyBudget.wallets[0], accounts: [] }],
          engine: null,
        });
      if (url === '/wallets/w-main/settings') return Promise.resolve({ settings: rawSettings });
      if (url === '/wallets/w-main/settings/audit') return Promise.resolve({ audit: [] });
      return Promise.reject(new Error(`API error: 404 Not Found (${url})`));
    });
    const data = await getDailyProgress();
    expect(data.available).toBe(false);
    expect(data.unavailable_reason).toMatch(/ration state unreadable/);
    expect(data.blocks.length).toBe(1);
    expect(data.blocks[0].published).toBe(false);
    // The block carries no spend numbers, so nothing can be drawn as 0%.
    expect(data.blocks[0].used_pct).toBe(0);
    expect(data.blocks[0].published_note).toMatch(/ration state unreadable/);
  });

  it('surfaces the transport error verbatim when the console surface is not deployed (404)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    await expect(getWalletSettings()).rejects.toThrow(/404/);
  });

  it('never falls back to demo data when the server refuses the caller (403)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 403 Forbidden'));
    await expect(getWalletSettings()).rejects.toThrow(/403/);
  });

  it('re-throws a real server error instead of faking data', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
    await expect(getWalletSettings()).rejects.toThrow(/500/);
  });
});

describe('owner gate', () => {
  it('reports owner=false for a signed-out caller', async () => {
    mockFetchJson.mockRejectedValue(new Error('Session expired'));
    const access = await getWalletConsoleAccess();
    expect(access.owner).toBe(false);
    expect(access.available).toBe(false);
  });

  it('reports owner=false for a caller the server refuses (403)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 403 Forbidden'));
    const access = await getWalletConsoleAccess();
    expect(access.owner).toBe(false);
  });

  it('reports the surface as unavailable when the console is not deployed (404)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    const access = await getWalletConsoleAccess();
    expect(access.owner).toBe(false);
    expect(access.available).toBe(false);
  });

  it('reads a live owner=true verdict', async () => {
    const access = await getWalletConsoleAccess();
    expect(access).toEqual({ owner: true, available: true });
  });
});

describe('settings round-trip', () => {
  it('PUTs the daily line and re-reads the board so the tick, audit and ruling are the server’s', async () => {
    mockFetchMutate.mockResolvedValue({
      settings: { ...rawSettings, daily_lines: { base_pct: 11, rollover_pool_pct: 0.74409, floor_pct: 4 } },
      changed: true,
      audit_id: 'audit-1',
      ruling: { id: 'D-2026-11-21-01' },
    });

    const next = await updateWalletLine({ wallet_id: 'w-main', base_pct: 11, rollover_pct: 0.74409 });

    expect(mockFetchMutate).toHaveBeenCalledWith('/wallets/w-main/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daily_lines: { base_pct: 11, rollover_pool_pct: 0.74409 },
      }),
    });
    // The audit row carries the auto-minted ruling id.
    expect(next.audit[0].ruling_id).toBe('D-2026-11-21-01');
    expect(next.audit[0].summary).toContain('base_pct');
    // The governor tick is the server's, re-read from the published state.
    expect(next.governor_tick?.mode).toBe('enforce');
    expect(next.governor_tick?.allowed_pct).toBeCloseTo(10.74409, 6);
  });

  it('re-throws a real server error instead of silently faking a save', async () => {
    mockFetchMutate.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
    await expect(updateWalletLine({ wallet_id: 'w-main', base_pct: 11 })).rejects.toThrow(/500/);
  });

  it('surfaces the transport error when the console surface is absent — no local save', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    mockFetchMutate.mockRejectedValue(new Error('API error: 404 Not Found'));
    await expect(updateWalletLine({ wallet_id: 'w-main', base_pct: 11 })).rejects.toThrow(/404/);
  });
});

describe('ask the crew', () => {
  it('posts the message to the console endpoint', async () => {
    mockFetchMutate.mockResolvedValue({ ok: true, card_ref: 'needs-you #123' });
    const res = await askCrew('hold MM at 7 lanes');
    expect(mockFetchMutate).toHaveBeenCalledWith('/wallets/console/ask-crew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hold MM at 7 lanes' }),
    });
    expect(res.ok).toBe(true);
    expect(res.card_ref).toBe('needs-you #123');
  });

  it('surfaces the failure when no filing route is published', async () => {
    mockFetchMutate.mockRejectedValue(new Error('API error: 404 Not Found'));
    await expect(askCrew('hello')).rejects.toThrow(/404/);
  });
});
