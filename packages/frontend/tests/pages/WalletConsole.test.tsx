import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';

vi.mock('@solidjs/meta', () => ({
  Title: (props: any) => <title>{props.children}</title>,
  Meta: () => null,
}));

const mockGetWalletConsoleAccess = vi.fn();
const mockGetWalletSettings = vi.fn();
const mockGetLoadBalancer = vi.fn();
const mockGetDailyProgress = vi.fn();
const mockUpdateWalletLine = vi.fn();
const mockAskCrew = vi.fn();

vi.mock('../../src/services/api/wallet-console', async () => {
  const demo = await vi.importActual<typeof import('../../src/services/api/wallet-console')>(
    '../../src/services/api/wallet-console',
  );
  return {
    DEMO_SETTINGS: demo.DEMO_SETTINGS,
    DEMO_BALANCER: demo.DEMO_BALANCER,
    DEMO_PROGRESS: demo.DEMO_PROGRESS,
    getWalletConsoleAccess: () => mockGetWalletConsoleAccess(),
    getWalletSettings: () => mockGetWalletSettings(),
    getLoadBalancer: () => mockGetLoadBalancer(),
    getDailyProgress: () => mockGetDailyProgress(),
    updateWalletLine: (...args: unknown[]) => mockUpdateWalletLine(...args),
    askCrew: (...args: unknown[]) => mockAskCrew(...args),
  };
});

import WalletSettings from '../../src/pages/WalletSettings';
import LoadBalancer from '../../src/pages/LoadBalancer';
import DailyProgress from '../../src/pages/DailyProgress';
import {
  DEMO_SETTINGS,
  DEMO_BALANCER,
  DEMO_PROGRESS,
} from '../../src/services/api/wallet-console';

beforeEach(() => {
  mockGetWalletConsoleAccess.mockReset();
  mockGetWalletSettings.mockReset();
  mockGetLoadBalancer.mockReset();
  mockGetDailyProgress.mockReset();
  mockUpdateWalletLine.mockReset();
  mockAskCrew.mockReset();
  mockGetWalletConsoleAccess.mockResolvedValue({ owner: true, demo: false });
  mockGetWalletSettings.mockResolvedValue(DEMO_SETTINGS);
  mockGetLoadBalancer.mockResolvedValue(DEMO_BALANCER);
  mockGetDailyProgress.mockResolvedValue(DEMO_PROGRESS);
  mockUpdateWalletLine.mockResolvedValue(DEMO_SETTINGS);
  mockAskCrew.mockResolvedValue({ ok: true, demo: false, card_ref: 'needs-you #1' });
});

describe('WalletSettings', () => {
  it('renders the server formula strip for every wallet line', async () => {
    const { container } = render(() => <WalletSettings />);
    // Wait for the LINES, not the header: the header renders before the
    // access check resolves.
    await waitFor(() =>
      expect(container.querySelectorAll('.wc-budget-line').length).toBe(
        DEMO_SETTINGS.lines.length,
      ),
    );
    // base + rollover + reserve − floor is spelled out, never a bare number.
    const terms = Array.from(container.querySelectorAll('.wc-formula__term')).map((n) =>
      n.textContent?.trim(),
    );
    expect(terms.some((t) => t?.startsWith('base'))).toBe(true);
    expect(terms.some((t) => t?.startsWith('rollover carried in'))).toBe(true);
    expect(terms.some((t) => t?.startsWith('daily reserve'))).toBe(true);
    expect(terms.some((t) => t?.startsWith('emergency floor'))).toBe(true);
    // The server result is rendered verbatim.
    expect(container.querySelector('.wc-formula__result')?.textContent).toContain('14.6%');
  });

  it('locks the emergency floor input (readonly)', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.querySelector('.wc-input--locked')).not.toBeNull());
    const locked = container.querySelector('.wc-input--locked');
    expect(locked?.hasAttribute('readonly')).toBe(true);
  });

  it('round-trips a base change and shows the saved confirmation', async () => {
    const { container } = render(() => <WalletSettings />);
    await waitFor(() => expect(container.querySelector('#base-w-main')).not.toBeNull());
    const base = container.querySelector('#base-w-main') as HTMLInputElement;
    fireEvent.input(base, { target: { value: '12.0' } });
    const save = screen
      .getAllByRole('button', { name: /Save & mint ruling/ })
      .find((b) => b.closest('.wc-budget-line')?.textContent?.includes('MAIN'));
    expect(save).toBeDefined();
    fireEvent.click(save!);
    await waitFor(() =>
      expect(mockUpdateWalletLine).toHaveBeenCalledWith({
        wallet_id: 'w-main',
        base_pct: 12,
        rollover_pct: DEMO_SETTINGS.lines[0].rollover_pct,
      }),
    );
    await waitFor(() => expect(container.textContent).toContain('Line saved.'));
  });

  it('shows the owner-only gate to a non-owner', async () => {
    mockGetWalletConsoleAccess.mockResolvedValue({ owner: false, demo: false });
    render(() => <WalletSettings />);
    await waitFor(() => expect(screen.getByText('Owner only')).toBeDefined());
    expect(mockGetWalletSettings).not.toHaveBeenCalled();
  });
});

describe('LoadBalancer', () => {
  it('renders a live card per wallet with in-flight and ceiling', async () => {
    const { container } = render(() => <LoadBalancer />);
    await waitFor(() => expect(container.querySelectorAll('.wc-lb-card').length).toBeGreaterThan(0));
    const text = container.textContent ?? '';
    expect(text).toContain('8 / 10');
    expect(text).toContain('3 / 10');
    expect(screen.getAllByText('5-hour window').length).toBe(DEMO_BALANCER.cards.length);
  });

  it('re-reads the balancer on the refresh button', async () => {
    const { container } = render(() => <LoadBalancer />);
    await waitFor(() => expect(container.querySelectorAll('.wc-lb-card').length).toBeGreaterThan(0));
    const before = mockGetLoadBalancer.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mockGetLoadBalancer.mock.calls.length).toBeGreaterThan(before));
  });

  it('shows the owner-only gate to a non-owner', async () => {
    mockGetWalletConsoleAccess.mockResolvedValue({ owner: false, demo: false });
    render(() => <LoadBalancer />);
    await waitFor(() => expect(screen.getByText('Owner only')).toBeDefined());
    expect(mockGetLoadBalancer).not.toHaveBeenCalled();
  });
});

describe('DailyProgress', () => {
  it('shows the rollover math visibly (used / still allowed / locked floor)', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() =>
      expect(container.querySelectorAll('.wc-progress-block').length).toBe(
        DEMO_PROGRESS.blocks.length,
      ),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('of the line still allowed');
    expect(text).toContain('emergency floor');
    expect(text).toContain('— locked');
    expect(text).toContain('projection at reset');
    // The stack bar carries the projection marker.
    expect(container.querySelector('.wc-stack-bar__mark')).not.toBeNull();
  });

  it('renders the burn-meter gauge with an accessible label', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() => expect(container.querySelector('.wc-gauge')).not.toBeNull());
    const gauge = container.querySelector('.wc-gauge');
    expect(gauge?.getAttribute('aria-label')).toMatch(/Burn meter/);
    expect(container.textContent).toContain('never moves a lane by itself');
  });

  it('renders the weekly heatmap cells with per-cell labels', async () => {
    const { container } = render(() => <DailyProgress />);
    await waitFor(() => expect(container.querySelector('.wc-heat-cell')).not.toBeNull());
    const cells = container.querySelectorAll('.wc-heat-cell');
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0].getAttribute('aria-label')).toBeTruthy();
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
    mockGetWalletConsoleAccess.mockResolvedValue({ owner: false, demo: false });
    render(() => <DailyProgress />);
    await waitFor(() => expect(screen.getByText('Owner only')).toBeDefined());
    expect(mockGetDailyProgress).not.toHaveBeenCalled();
  });
});
