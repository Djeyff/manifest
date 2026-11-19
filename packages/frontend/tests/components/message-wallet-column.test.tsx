import { describe, it, expect, vi } from 'vitest';
import { render } from '@solidjs/testing-library';
import { WalletCell } from '../../src/components/message-table-cells';
import { buildRequestColumns, type MessageRow } from '../../src/components/message-table-types';

vi.mock('@solidjs/router', () => ({
  A: (props: any) => (
    <a href={props.href} class={props.class}>
      {props.children}
    </a>
  ),
}));

vi.mock('../../src/services/formatters.js', () => ({
  formatCost: (v: number) => `$${v.toFixed(2)}`,
  formatNumber: (v: number) => String(v),
  formatStatus: (s: string) => s,
  formatTime: (t: string) => t,
  formatDuration: (ms: number) => `${ms}ms`,
  formatErrorMessage: (s: string) => s,
  customProviderColor: () => '#6366f1',
}));

vi.mock('../../src/services/routing-utils.js', () => ({
  inferProviderFromModel: () => null,
  inferProviderName: (m: string) => m,
  resolveProviderId: () => undefined,
  stripCustomPrefix: (m: string) => m,
}));

vi.mock('../../src/services/model-display.js', () => ({
  getModelDisplayName: (slug: string) => slug,
}));

vi.mock('../../src/components/ProviderIcon.jsx', () => ({
  providerIcon: () => null,
  customProviderLogo: () => null,
}));

vi.mock('../../src/components/AuthBadge.js', () => ({
  authBadgeFor: () => null,
  authLabel: () => 'API Key',
}));

vi.mock('../../src/components/InfoTooltip.jsx', () => ({
  default: (props: any) => <span title={props.text} />,
}));

function baseRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '1',
    timestamp: '2025-01-01T00:00:00Z',
    agent_name: 'demo',
    model: 'gpt-4o',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cost: 0.01,
    status: 'success',
    ...overrides,
  };
}

function renderCell(row: MessageRow) {
  return render(() => (
    <table>
      <tbody>
        <tr>{WalletCell(row)}</tr>
      </tbody>
    </table>
  ));
}

describe('Requests page wallet column', () => {
  it('places the wallet column immediately after the harness column in global mode', () => {
    const columns = buildRequestColumns(true);
    expect(columns).toContain('wallet');
    const agent = columns.indexOf('agent');
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(columns[agent + 1]).toBe('wallet');
    // The wallet chip sits between the harness and the model columns.
    expect(columns.indexOf('model')).toBe(agent + 2);
  });

  it('places the wallet column right after the model column in per-harness mode', () => {
    const columns = buildRequestColumns(false);
    expect(columns).toContain('wallet');
    expect(columns).not.toContain('agent');
    const model = columns.indexOf('model');
    expect(columns[model + 1]).toBe('wallet');
  });

  it('keeps the rest of the column list unchanged', () => {
    const global = buildRequestColumns(true);
    const perHarness = buildRequestColumns(false);
    expect(global.filter((c) => c !== 'agent' && c !== 'wallet')).toEqual(
      perHarness.filter((c) => c !== 'wallet'),
    );
  });
});

describe('WalletCell', () => {
  it('renders the wallet name in a chip with a title attribute', () => {
    const { container } = renderCell(baseRow({ wallet_name: 'MAIN' }));
    const chip = container.querySelector('.tier-badge');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('MAIN');
    expect(chip!.getAttribute('title')).toBe('MAIN');
  });

  it('applies a palette-token color class', () => {
    const { container } = renderCell(baseRow({ wallet_name: 'MAIN', wallet_color: 'indigo' }));
    const chip = container.querySelector('.tier-badge') as HTMLElement;
    expect(chip.className).toContain('tier-color--indigo');
  });

  it('applies a hex color as an inline background', () => {
    const { container } = renderCell(
      baseRow({ wallet_name: 'MAIN', wallet_color: '#4f46e5' }),
    );
    const chip = container.querySelector('.tier-badge') as HTMLElement;
    expect(chip.style.backgroundColor).toBe('rgb(79, 70, 229)');
  });

  it('falls back to a neutral chip for an unknown color', () => {
    const { container } = renderCell(
      baseRow({ wallet_name: 'MAIN', wallet_color: 'not-a-color' }),
    );
    const chip = container.querySelector('.tier-badge') as HTMLElement;
    expect(chip.className).not.toContain('tier-color--');
    expect(chip.style.backgroundColor).not.toBe('');
  });

  it('renders an em dash when the wallet name is null or empty', () => {
    const { container } = renderCell(baseRow({ wallet_name: null }));
    expect(container.querySelector('td')!.textContent).toContain('\u2014');
    expect(container.querySelector('.tier-badge')).toBeNull();

    const empty = renderCell(baseRow({ wallet_name: '   ' }));
    expect(empty.container.querySelector('td')!.textContent).toContain('\u2014');
  });
});
