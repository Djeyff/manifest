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

beforeEach(() => {
  mockFetchJson.mockReset();
  mockFetchMutate.mockReset();
});

describe('wallet console API client', () => {
  it('reads live settings from the console endpoint and flags demo=false', async () => {
    mockFetchJson.mockResolvedValue({ ...DEMO_SETTINGS, demo: false });
    const data = await getWalletSettings();
    expect(data.demo).toBe(false);
    expect(mockFetchJson).toHaveBeenCalledWith(
      '/wallets/console/settings',
      undefined,
      expect.objectContaining({ cache: false }),
    );
  });

  it('falls back to the demo payload when the console API is not deployed yet', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    const data = await getWalletSettings();
    expect(data.demo).toBe(true);
    expect(data.lines.length).toBeGreaterThan(0);
  });

  it('never falls back to demo data on an auth failure', async () => {
    mockFetchJson.mockRejectedValue(new Error('Unauthorized'));
    await expect(getWalletSettings()).rejects.toThrow(/Unauthorized/);
  });

  it('reads the balancer and the progress surface from their own endpoints', async () => {
    mockFetchJson.mockResolvedValue({ demo: false, cards: [] });
    await getLoadBalancer();
    expect(mockFetchJson).toHaveBeenCalledWith(
      '/wallets/console/balancer',
      undefined,
      expect.objectContaining({ cache: false }),
    );
    mockFetchJson.mockResolvedValue({ demo: false, blocks: [] });
    await getDailyProgress();
    expect(mockFetchJson).toHaveBeenCalledWith(
      '/wallets/console/progress',
      undefined,
      expect.objectContaining({ cache: false }),
    );
  });
});

describe('owner gate', () => {
  it('reports owner=false for a signed-out caller', async () => {
    mockFetchJson.mockRejectedValue(new Error('Unauthorized'));
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

  it('marks the gate as unverified demo when the endpoint is missing', async () => {
    mockFetchJson.mockRejectedValue(new Error('API error: 404 Not Found'));
    const access = await getWalletConsoleAccess();
    expect(access.owner).toBe(true);
    expect(access.demo).toBe(true);
  });

  it('reads a live owner=true verdict', async () => {
    mockFetchJson.mockResolvedValue({ owner: true });
    const access = await getWalletConsoleAccess();
    expect(access).toEqual({ owner: true, demo: false });
  });
});

describe('settings round-trip', () => {
  it('PATCHes the line and returns the server response verbatim', async () => {
    const serverLine = {
      ...DEMO_SETTINGS.lines[0],
      base_pct: 12,
      allowed_pct: 16.6,
    };
    mockFetchMutate.mockResolvedValue({
      ...DEMO_SETTINGS,
      demo: false,
      lines: [serverLine, ...DEMO_SETTINGS.lines.slice(1)],
      audit: [
        { at: '2026-11-21T18:00:00.000Z', summary: 'MAIN base set 12%', ruling_id: 'D-2026-11-21-09' },
        ...DEMO_SETTINGS.audit,
      ],
      governor_tick: { at: '2026-11-21T18:00:00.000Z', mode: 'enforce', allowed_pct: 16.6, used_pct: 9.1 },
    });

    const next = await updateWalletLine({ wallet_id: 'w-main', base_pct: 12 });

    expect(mockFetchMutate).toHaveBeenCalledWith('/wallets/console/settings/w-main', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_pct: 12, rollover_pct: undefined }),
    });
    expect(next.demo).toBe(false);
    expect(next.lines[0].base_pct).toBe(12);
    expect(next.governor_tick?.allowed_pct).toBe(16.6);
    expect(next.audit[0].ruling_id).toBe('D-2026-11-21-09');
  });

  it('applies the change locally (with audit row + governor tick) when the API is absent', async () => {
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

  it('degrades to a demo filing when the endpoint is not deployed yet', async () => {
    mockFetchMutate.mockRejectedValue(new Error('API error: 501 Not Implemented'));
    const res = await askCrew('hello');
    expect(res.ok).toBe(true);
    expect(res.demo).toBe(true);
  });
});
