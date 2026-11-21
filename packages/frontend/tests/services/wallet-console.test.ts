import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchJson = vi.fn();
const mockFetchMutate = vi.fn();

vi.mock('../../src/services/api/core', () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  fetchMutate: (...args: unknown[]) => mockFetchMutate(...args),
}));

import {
  DEMO_SETTINGS,
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
          label: 'zai-max',
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
      keys: ['zai-max'],
      allowed_today_pct: 10.74409,
      used_today_pct: 4.092248,
      remaining_today_pct: 6.651842,
      base_pct: 10,
      rollover_pool_pct: 0.74409,
      floor_pct: 4,
      weekly_headroom_pct: 28.8,
      five_h_headroom_pct: 57.5,
      drain_day: false,
      drain_window: false,
      allow: true,
      halted: false,
      day_number: 1,
      day_index: 0,
      ration_model: 'RET-670-V3',
      reasons: [],
      halted_by_console: false,
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
};

const rawSettings = {
  wallet_id: 'w-main',
  tenant_id: 't-1',
  drain_day_enabled: true,
  priority: 1,
  parked: false,
  kill_switch_fallback: false,
  daily_lines: { base_pct: 10, rollover_pool_pct: 0.74409, floor_pct: 4 },
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
    expect(data.demo).toBe(false);
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

  it('maps the balancer board onto live cards', async () => {
    const data = await getLoadBalancer();
    expect(data.demo).toBe(false);
    expect(data.cards[0].name).toBe('MAIN');
    expect(data.cards[0].window.pct_left).toBeCloseTo(57.5, 3);
    expect(data.cards[0].weekly.pct_left).toBeCloseTo(28.8, 3);
    expect(data.admission.tone).toBe('ok');
  });

  it('maps the daily budget onto progress blocks with the used/allowed split', async () => {
    const data = await getDailyProgress();
    expect(data.demo).toBe(false);
    expect(data.available).toBe(true);
    expect(data.blocks[0].used_pct).toBeCloseTo(4.092248, 6);
    expect(data.blocks[0].allowed_pct).toBeCloseTo(10.74409, 6);
    expect(data.blocks[0].still_allowed_pct).toBeCloseTo(6.651842, 6);
    expect(data.blocks[0].published).toBe(true);
    expect(data.blocks[0].account).toBe('MAIN');
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

  it('falls back to the demo payload when the console surface is not deployed (404)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    const data = await getWalletSettings();
    expect(data.demo).toBe(true);
    expect(data.lines.length).toBeGreaterThan(0);
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
    expect(access.demo).toBe(false);
  });

  it('reports owner=false for a caller the server refuses (403)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 403 Forbidden'));
    const access = await getWalletConsoleAccess();
    expect(access.owner).toBe(false);
    expect(access.demo).toBe(false);
  });

  it('marks the gate as an unverified demo when the console is not deployed (404)', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    const access = await getWalletConsoleAccess();
    expect(access.owner).toBe(true);
    expect(access.demo).toBe(true);
  });

  it('reads a live owner=true verdict', async () => {
    const access = await getWalletConsoleAccess();
    expect(access).toEqual({ owner: true, demo: false });
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
    expect(next.demo).toBe(false);
    // The audit row carries the auto-minted ruling id.
    expect(next.audit[0].ruling_id).toBe('D-2026-11-21-01');
    expect(next.audit[0].summary).toContain('base_pct');
    // The governor tick is the server's, re-read from the published state.
    expect(next.governor_tick?.mode).toBe('enforce');
    expect(next.governor_tick?.allowed_pct).toBeCloseTo(10.74409, 6);
  });

  it('applies the change locally (with audit row + governor tick) when the API is absent', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    mockFetchMutate.mockRejectedValue(new Error('API error: 404 Not Found'));
    const next = await updateWalletLine({ wallet_id: 'w-main', base_pct: 11 });

    const line = next.lines.find((l) => l.wallet_id === 'w-main');
    expect(line?.base_pct).toBe(11);
    // allowed = base + rollover + reserve - floor (server owns the formula)
    expect(line?.allowed_pct).toBeCloseTo(
      11 + line!.rollover_pct + line!.reserve_pct - line!.floor_pct,
      5,
    );
    expect(next.audit[0].summary).toContain('line updated');
    expect(next.governor_tick?.allowed_pct).toBeCloseTo(line!.allowed_pct, 5);
  });

  it('re-throws a real server error instead of silently faking a save', async () => {
    mockFetchMutate.mockRejectedValue(new Error('API error: 500 Internal Server Error'));
    await expect(updateWalletLine({ wallet_id: 'w-main', base_pct: 11 })).rejects.toThrow(/500/);
  });
});

describe('ask the crew', () => {
  it('posts the message to the console endpoint', async () => {
    mockFetchMutate.mockResolvedValue({ ok: true, demo: false, card_ref: 'needs-you #123' });
    const res = await askCrew('hold MM at 7 lanes');
    expect(mockFetchMutate).toHaveBeenCalledWith('/wallets/console/ask-crew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hold MM at 7 lanes' }),
    });
    expect(res.ok).toBe(true);
    expect(res.card_ref).toBe('needs-you #123');
  });

  it('degrades to a local hold when no filing route is published', async () => {
    mockFetchMutate.mockRejectedValue(new Error('API error: 404 Not Found'));
    const res = await askCrew('hello');
    expect(res.ok).toBe(true);
    expect(res.demo).toBe(true);
  });
});

describe('demo payload sanity', () => {
  it('keeps the demo lines usable when the live API is absent', () => {
    expect(DEMO_SETTINGS.lines.length).toBeGreaterThan(0);
    expect(DEMO_SETTINGS.lines[0].formula.terms.length).toBeGreaterThan(1);
  });
});
