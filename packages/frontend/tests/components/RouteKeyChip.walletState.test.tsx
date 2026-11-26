import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import RouteKeyChip from '../../src/components/RouteKeyChip';
import { resetWalletOptionsCache } from '../../src/services/api/wallet-options';
import { resetWalletStates } from '../../src/services/api/wallet-states';
import type { WalletOption } from '../../src/services/api/wallet-options';

/**
 * RET-776-C, architect decision DC1: the tier-builder wallet dropdown
 * shows a READ-ONLY state pill — never a pause/unpause button. A control
 * inside a tier form would read as "editing the tier".
 */

const WALLETS: WalletOption[] = [
  {
    wallet_id: 'w-main',
    name: 'MAIN',
    display_name: 'MAIN (Z.AI Max)',
    provider: 'zai',
    key_labels: ['RCR'],
  },
  {
    wallet_id: 'w-mm',
    name: 'MM',
    display_name: 'MM (MiniMax)',
    provider: 'minimax',
    key_labels: ['RCR MM'],
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetWalletOptionsCache();
  resetWalletStates();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/quota-board')) {
        return json({
          wallets: [
            { wallet_id: 'w-main', name: 'MAIN', provider: 'zai', keys: [{ label: 'RCR' }] },
            {
              wallet_id: 'w-mm',
              name: 'MM',
              provider: 'minimax',
              keys: [{ label: 'RCR MM' }],
            },
          ],
        });
      }
      if (url.includes('/wallets/w-main/state')) {
        return json({
          state: {
            wallet_id: 'w-main',
            name: 'MAIN',
            state: 'paused_by_owner',
            daily_left_pct: 10,
            weekly_left_pct: 30,
            read_at: '2026-11-26T09:12:00.000Z',
            numbers_stale: false,
            last_intent: null,
            keys_active: true,
          },
        });
      }
      if (url.includes('/wallets/w-mm/state')) {
        return json({
          state: {
            wallet_id: 'w-mm',
            name: 'MM',
            state: 'running',
            daily_left_pct: 50,
            weekly_left_pct: 80,
            read_at: '2026-11-26T09:12:00.000Z',
            numbers_stale: false,
            last_intent: null,
            keys_active: true,
          },
        });
      }
      return json({ message: 'Not found' }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openDropdown() {
  render(() => (
    <RouteKeyChip
      keys={[]}
      wallets={() => WALLETS}
      currentLabel={undefined}
      modelLabel="GLM-5"
      buttonClass="routing-card__key-chip"
      onPick={() => {}}
    />
  ));
  fireEvent.click(screen.getByRole('button', { name: /GLM-5/ }));
}

describe('RouteKeyChip — the read-only wallet state pill', () => {
  it('shows the state of each wallet and offers no action', async () => {
    openDropdown();

    await waitFor(() => {
      expect(screen.getByText('Paused by owner')).toBeTruthy();
    });
    expect(screen.getByText('Running')).toBeTruthy();
    // No pause/unpause control lives in the dropdown.
    expect(screen.queryByRole('button', { name: /Pause wallet|Unpause wallet/ })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Pause \/ unpause wallet/ }),
    ).toBeNull();
  });
});
