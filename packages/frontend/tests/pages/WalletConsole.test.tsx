import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

const mockGetWalletConsoleAccess = vi.fn();
const mockGetLoadBalancer = vi.fn();
const mockGetDailyProgress = vi.fn();
const mockAskCrew = vi.fn();

vi.mock('../../src/services/api/wallet-console', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/api/wallet-console')>(
    '../../src/services/api/wallet-console',
  );
  return {
    ...actual,
    getWalletConsoleAccess: () => mockGetWalletConsoleAccess(),
    getLoadBalancer: () => mockGetLoadBalancer(),
    getDailyProgress: () => mockGetDailyProgress(),
    askCrew: (...args: unknown[]) => mockAskCrew(...args),
  };
});

const mockFetchWallets = vi.fn();
const mockFetchWalletSettings = vi.fn();
const mockFetchWalletAudit = vi.fn();
const mockFetchProviderKeys = vi.fn();
const mockUpdateWalletSettings = vi.fn();

vi.mock('../../src/services/api/wallet-settings', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/api/wallet-settings')>(
    '../../src/services/api/wallet-settings',
  );
  return {
    ...actual,
    fetchWallets: (...args: unknown[]) => mockFetchWallets(...args),
    fetchWalletSettings: (...args: unknown[]) => mockFetchWalletSettings(...args),
    fetchWalletAudit: (...args: unknown[]) => mockFetchWalletAudit(...args),
    fetchProviderKeys: (...args: unknown[]) => mockFetchProviderKeys(...args),
    updateWalletSettings: (...args: unknown[]) => mockUpdateWalletSettings(...args),
  };
});

import WalletSettings from '../../src/pages/WalletSettings';
import LoadBalancer from '../../src/pages/LoadBalancer';
import DailyProgress from '../../src/pages/DailyProgress';

/* ------------------------------------------------------------------ */
/* Local fixtures — the LIVE server shapes. Never a demo payload in src. */
/* ------------------------------------------------------------------ */

const walletList = [
  {
    id: 'w-main',
    name: 'MAIN',
    color: 'main',
    member_keys: [{ tenant_provider_id: 'tp-1', label: 'RCR', provider: 'zai' }],
  },
];

const walletSettings = {
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

const providerKeys = [
  { id: 'tp-1', label: 'RCR', provider: 'zai', room: 'RCR', bound_wallet_id: 'w-main' },
  { id: 'tp-2', label: 'CCR set', provider: 'zai', room: 'CCR', bound_wallet_id: null },
];

const balancerResponse = {
  admission: { label: 'Live', tone: 'ok' as const },
  cards: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      display_name: 'MAIN (Z.AI Max)',
      provider: 'zai',
      state: { label: 'Drawing', tone: 'ok' as const },
      lane_tags: ['RCR'],
      lane_tags_live: true,
      in_flight: 8,
      ceiling: 10,
      window: { pct_left: 57.5, resets_label: '11-22 07:13' },
      weekly: { pct_left: 28.8, resets_label: '11-28 07:13' },
      priority: 1,
      priority_hint: 'Priority 1',
      provider_state: { label: 'Live', tone: 'ok' as const, detail: '2026-11-21T18:53:20.000Z' },
    },
  ],
  provider_state: [{ provider: 'zai', value: 'RCR: live' }],
  lane_targets: { target_band: '6–10 lanes' },
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
  day_lines: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      display_name: 'MAIN (Z.AI Max)',
      provider: 'zai',
      account: 'MAIN',
      day_label: 'day 1',
      allowed_pct: 10.74409,
      used_pct: 4.092248,
      remaining_pct: 6.651842,
      base_pct: 10,
      rollover_pct: 0.74409,
      reserve_pct: 4.28571,
      accrued_at_lift_pct: 8.57142,
      available_pct: 10.74409,
      floor_pct: 4,
      pace_pct_per_h: 1.364,
      projected_end_pct: 24.644,
      working_hours_left: 15,
      day_elapsed_hours: 3,
      day_epoch: 1763700000,
      day_start_utc: '00:00',
      anchor_note: 'provider reset stamp',
      anchor_source: 'provider',
      anchor_stale: false,
      five_h: { pct_left: 57.5, reset_at: '2026-11-22T07:13:00.000Z', resets_label: '11-22 07:13' },
      weekly: { pct_left: 28.8, reset_at: '2026-11-28T07:13:00.000Z', resets_label: '11-28 07:13' },
    },
  ],
  enforce_tick_at: '2026-11-21T18:40:00.000Z',
};

const progressResponse = {
  blocks: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      display_name: 'MAIN (Z.AI Max)',
      color: 'main',
      provider: 'zai',
      used_pct: 4.092248,
      allowed_pct: 10.74409,
      projected_pct: 4.092248,
      still_allowed_pct: 6.651842,
      floor_pct: 4,
      pace: 'ahead' as const,
      badges: [],
      formula: {
        label: 'allowed today',
        terms: [
          { op: '', label: 'base', value: 10, unit: '%' },
          { op: '+', label: 'rollover pool', value: 0.74409, unit: '%' },
          { op: '−', label: 'locked floor', value: 4, unit: '%' },
        ],
        result: { label: 'allowed today =', value: 10.74409, unit: '%' },
        ruling_id: null,
      },
      resets_label: 'day 1',
      reset_hint: 'RET-670-V3 day window',
      note: null,
      account: 'MAIN',
      day_label: 'day 1',
      published: true,
      published_note: null,
      five_h: { pct_left: 57.5, reset_at: '2026-11-22T07:13:00.000Z', resets_label: '11-22 07:13' },
      weekly: { pct_left: 28.8, reset_at: '2026-11-28T07:13:00.000Z', resets_label: '11-28 07:13' },
      spent_week_pct: 41.2,
      weekly_pool: 1200,
      denomination: 'credits',
      pace_pct_per_h: 1.364,
      projected_end_pct: 24.644,
      working_hours_left: 15,
      reserve_pct: 4.28571,
      accrued_at_lift_pct: 8.57142,
      rollover_pct: 0.74409,
      day_start_utc: '00:00',
      anchor_note: 'provider reset stamp',
      anchor_stale: false,
    },
  ],
  burn: {
    in_flight: 8,
    recommended: 8,
    quota_headroom_pct: 28.8,
    target_band: '6–10',
    verdict: 'Advisory only — the console proposes, the governor moves.',
    advisory: true,
  },
  heatmap: { weeks: [], note: 'Per-day burn history is not published by the read API yet.' },
  day_strip: null,
  audit: [],
  available: true,
  unavailable_reason: null,
};

beforeEach(() => {
  mockGetWalletConsoleAccess.mockReset();
  mockGetLoadBalancer.mockReset();
  mockGetDailyProgress.mockReset();
  mockAskCrew.mockReset();
  mockFetchWallets.mockReset();
  mockFetchWalletSettings.mockReset();
  mockFetchWalletAudit.mockReset();
  mockFetchProviderKeys.mockReset();
  mockUpdateWalletSettings.mockReset();

  mockGetWalletConsoleAccess.mockResolvedValue({ owner: true, available: true });
  mockGetLoadBalancer.mockResolvedValue(balancerResponse);
  mockGetDailyProgress.mockResolvedValue(progressResponse);
  mockAskCrew.mockResolvedValue({ ok: true, card_ref: 'needs-you #1' });

  mockFetchWallets.mockResolvedValue(walletList);
  mockFetchWalletSettings.mockResolvedValue(walletSettings);
  mockFetchWalletAudit.mockResolvedValue([
    {
      id: 'audit-1',
      wallet_id: 'w-main',
      tenant_id: 't-1',
      actor_user_id: 'u-1',
      action: 'settings.update',
      before: { base_pct: 10 },
      after: { base_pct: 11 },
      ruling_id: 'D-2026-11-22-01',
      created_at: '2026-11-21T18:40:00.000Z',
    },
  ]);
  mockFetchProviderKeys.mockResolvedValue(providerKeys);
  mockUpdateWalletSettings.mockResolvedValue({
    settings: { ...walletSettings, daily_lines: { ...walletSettings.daily_lines, base_pct: 11 } },
    changed: true,
    audit_id: 'audit-1',
    ruling: { id: 'D-2026-11-22-01', minted_at: '2026-11-21T18:40:00.000Z', persisted: true },
  });
});

describe('WalletSettings', () => {
  it('renders the wallet with its plan name and the live editable rules', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.textContent).toContain('MAIN (Z.AI Max)'));
    expect(container.querySelector('#base-w-main')).not.toBeNull();
    expect(container.querySelector('#reserve-w-main')).not.toBeNull();
    expect((container.querySelector('#base-w-main') as HTMLInputElement).value).toBe('10');
    expect((container.querySelector('#reserve-w-main') as HTMLInputElement).value).toBe('4.28571');
  });

  it('offers the rollover and cross-class pause rules as toggles', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.querySelector('#rollover-w-main')).not.toBeNull());
    expect((container.querySelector('#rollover-w-main') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('#pause-w-main') as HTMLInputElement).checked).toBe(false);
  });

  it('binds a registered key per room', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.querySelector('#binding-w-main-RCR')).not.toBeNull());
    const select = container.querySelector('#binding-w-main-RCR') as HTMLSelectElement;
    expect(select.value).toBe('tp-1');
  });

  it('writes the rules to the settings store and shows the server audit + ruling', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.querySelector('#base-w-main')).not.toBeNull());
    fireEvent.input(container.querySelector('#base-w-main') as HTMLInputElement, {
      target: { value: '11' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & mint ruling' }));
    await waitFor(() =>
      expect(mockUpdateWalletSettings).toHaveBeenCalledWith(
        'w-main',
        expect.objectContaining({
          daily_lines: expect.objectContaining({ base_pct: 11 }),
          reserve_pct: 4.28571,
          rollover_enabled: true,
          cross_class_pause: false,
          key_bindings: [{ room: 'RCR', tenant_provider_id: 'tp-1' }],
        }),
      ),
    );
    await waitFor(() => expect(container.textContent).toContain('audit audit-1'));
    await waitFor(() => expect(container.textContent).toContain('ruling D-2026-11-22-01'));
  });

  it('renders the server-written audit trail', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.textContent).toContain('settings.update'));
    expect(container.textContent).toContain('D-2026-11-22-01');
  });

  it('surfaces the server error verbatim when the save fails', async () => {
    mockUpdateWalletSettings.mockRejectedValue(new Error('reserve_pct must be between 0 and 100'));
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.querySelector('#base-w-main')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Save & mint ruling' }));
    await waitFor(() =>
      expect(container.textContent).toContain('reserve_pct must be between 0 and 100'),
    );
  });
});

describe('LoadBalancer', () => {
  it('renders a live card per wallet with in-flight and ceiling', async () => {
    const { container } = render(() => <LoadBalancer />);
    await waitFor(() => expect(container.querySelectorAll('.wc-lb-card').length).toBeGreaterThan(0));
    const text = container.textContent ?? '';
    expect(text).toContain('8 / 10');
    expect(text).toContain('MAIN (Z.AI Max)');
    expect(screen.getAllByText('5-hour window').length).toBe(1);
  });

  it('renders the allowance engine state (rollover, membership, anchors, tick)', async () => {
    const { container } = render(() => <LoadBalancer />);
    await waitFor(() => expect(container.textContent).toContain('Allowance engine'));
    const text = container.textContent ?? '';
    expect(text).toContain('on — completed-day surplus is replayed');
    expect(text).toContain('carry-surplus');
    expect(text).toContain('CCR set');
    expect(text).toContain('00:00');
    expect(text).toContain('2026-11-21T18:40:00.000Z');
    // The base daily line and the reserve the engine holds back.
    expect(text).toContain('10.00% of the weekly pool per ration day');
    expect(text).toContain('4.29% of the weekly pool');
  });

  it('renders one day line per wallet account with the projected reset-day end state', async () => {
    const { container } = render(() => <LoadBalancer />);
    await waitFor(() => expect(container.textContent).toContain('Per-wallet day lines'));
    const text = container.textContent ?? '';
    expect(text).toContain('day 1');
    expect(text).toContain('10.74%');
    expect(text).toContain('4.09%');
    expect(text).toContain('24.64%');
    expect(text).toContain('Projected reset-day end state');
  });

  it('re-reads the balancer on the refresh button', async () => {
    const { container } = render(() => <LoadBalancer />);
    await waitFor(() => expect(container.querySelectorAll('.wc-lb-card').length).toBeGreaterThan(0));
    const before = mockGetLoadBalancer.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mockGetLoadBalancer.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows the owner-only gate to a non-owner', async () => {
    mockGetWalletConsoleAccess.mockResolvedValue({ owner: false, available: true });
    render(() => <LoadBalancer />);
    await waitFor(() => expect(screen.getByText('Owner only')).toBeDefined());
    expect(mockGetLoadBalancer).not.toHaveBeenCalled();
  });
});

describe('DailyProgress', () => {
  it('shows the rollover math visibly (used / still allowed / locked floor)', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() =>
      expect(container.querySelectorAll('.wc-progress-block').length).toBe(1),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('of the line still allowed');
    expect(text).toContain('emergency floor');
    expect(text).toContain('— locked');
    expect(text).toContain('projection at reset');
    expect(container.querySelector('.wc-stack-bar__mark')).not.toBeNull();
  });

  it('renders the provider-own burn windows and the reset anchors', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() => expect(container.textContent).toContain('Provider-own burn'));
    const text = container.textContent ?? '';
    expect(text).toContain('57.5%');
    expect(text).toContain('28.8%');
    expect(text).toContain('41.2%');
    expect(text).toContain('1200 credits');
    expect(text).toContain('11-22 07:13');
    expect(text).toContain('Day anchor');
  });

  it('renders the burn pace vs allowance panel', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() => expect(container.textContent).toContain('Burn pace vs allowance'));
    const text = container.textContent ?? '';
    expect(text).toContain('1.36% of the weekly pool / h');
    expect(text).toContain('24.6% of the weekly pool');
    expect(text).toContain('15.0 h');
    expect(text).toContain('4.29%');
  });

  it('renders the burn-meter gauge with an accessible label', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() => expect(container.querySelector('.wc-gauge')).not.toBeNull());
    const gauge = container.querySelector('.wc-gauge');
    expect(gauge?.getAttribute('aria-label')).toMatch(/Burn meter/);
    expect(container.textContent).toContain('never moves a lane by itself');
  });

  it('files a needs-you card from the ask-crew control', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() => expect(container.querySelector('#wc-ask-input')).not.toBeNull());
    const input = container.querySelector('#wc-ask-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'hold MM at 7 lanes' } });
    fireEvent.click(screen.getByRole('button', { name: 'File needs-you' }));
    await waitFor(() => expect(mockAskCrew).toHaveBeenCalledWith('hold MM at 7 lanes'));
    await waitFor(() => expect(container.textContent).toContain('Filed — the crew lane has it.'));
  });

  it('shows the owner-only gate to a non-owner', async () => {
    mockGetWalletConsoleAccess.mockResolvedValue({ owner: false, available: true });
    render(() => <DailyProgress />);
    await waitFor(() => expect(screen.getByText('Owner only')).toBeDefined());
    expect(mockGetDailyProgress).not.toHaveBeenCalled();
  });
});
