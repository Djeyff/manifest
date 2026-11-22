import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchWalletOptions,
  toWalletOption,
  walletDisplayName,
  walletOptionsForProvider,
  walletServesProvider,
  canonicalKeyLabel,
  resetWalletOptionsCache,
  type QuotaBoardResponse,
} from '../../src/services/api/wallet-options.js';

/**
 * Wallet dropdown for the custom-tier route builder
 * (owner order D-2026-11-22-11 + naming correction D-2026-11-22-12).
 */

const board: QuotaBoardResponse = {
  wallets: [
    {
      wallet_id: 'w-main',
      name: 'MAIN',
      color: 'indigo',
      keys: [
        { label: 'RCR', provider: 'zai' },
        { label: 'CCR', provider: 'zai' },
      ],
    },
    {
      wallet_id: 'w-mm',
      name: 'MM',
      color: 'violet',
      keys: [
        { label: 'RCR MM', provider: 'minimax' },
        { label: 'CCR MM', provider: 'minimax' },
      ],
    },
    {
      wallet_id: 'w-backup',
      name: 'BACKUP',
      color: 'amber',
      keys: [
        { label: 'RCR Backup', provider: 'zai' },
        { label: 'CCR Backup', provider: 'zai' },
      ],
    },
  ],
};

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Error',
    json: async () => body,
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('wallet options (live /quota-board)', () => {
  beforeEach(() => {
    resetWalletOptionsCache();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the live board into wallet options with MAIN/MM/BACKUP display names', async () => {
    mockFetch(200, board);
    const options = await fetchWalletOptions();
    expect(options.map((o) => o.display_name)).toEqual([
      'MAIN (Z.AI Max)',
      'MM (MiniMax)',
      'BACKUP (Z.AI Pro)',
    ]);
    expect(options.map((o) => o.provider)).toEqual(['zai', 'minimax', 'zai']);
    expect(options[0]!.key_labels).toEqual(['RCR', 'CCR']);
  });

  it('never invents a wallet the API did not return', async () => {
    mockFetch(200, { wallets: [board.wallets![0]!] });
    const options = await fetchWalletOptions();
    expect(options).toHaveLength(1);
    expect(options[0]!.wallet_id).toBe('w-main');
  });

  it('returns an empty list on 403 (not the owner) — never a fixture', async () => {
    mockFetch(403, { message: 'Forbidden' });
    await expect(fetchWalletOptions()).resolves.toEqual([]);
  });

  it('returns an empty list on 404 (console disabled) — never a fixture', async () => {
    mockFetch(404, { message: 'Not found' });
    await expect(fetchWalletOptions()).resolves.toEqual([]);
  });

  it('throws on other server errors', async () => {
    mockFetch(500, { message: 'boom' });
    await expect(fetchWalletOptions()).rejects.toThrow(/500/);
  });

  it('drops wallets that have no member key (nothing to pin)', async () => {
    mockFetch(200, { wallets: [{ wallet_id: 'w-empty', name: 'EMPTY', keys: [] }] });
    await expect(fetchWalletOptions()).resolves.toEqual([]);
  });
});

describe('wallet display name', () => {
  it('maps the known wallet names to their plan labels', () => {
    expect(walletDisplayName('MAIN', 'zai')).toBe('MAIN (Z.AI Max)');
    expect(walletDisplayName('MM', 'minimax')).toBe('MM (MiniMax)');
    expect(walletDisplayName('BACKUP', 'zai')).toBe('BACKUP (Z.AI Pro)');
  });

  it('falls back to the raw name for an unknown wallet', () => {
    expect(walletDisplayName('SPARE', 'zai')).toBe('SPARE');
  });
});

describe('wallet -> key mapping', () => {
  it('uses the first member key label in server order as the canonical label', () => {
    const option = toWalletOption(board.wallets![0]!);
    expect(canonicalKeyLabel(option)).toBe('RCR');
    expect(canonicalKeyLabel(toWalletOption(board.wallets![1]!))).toBe('RCR MM');
    expect(canonicalKeyLabel(toWalletOption(board.wallets![2]!))).toBe('RCR Backup');
  });

  it('returns undefined when the wallet has no key label', () => {
    expect(canonicalKeyLabel(toWalletOption({ wallet_id: 'x', name: 'X' }))).toBeUndefined();
  });
});

describe('wallet -> provider matching', () => {
  const options = board.wallets!.map(toWalletOption);

  it('offers the zai wallets for a zai route', () => {
    expect(walletOptionsForProvider(options, 'zai').map((o) => o.name)).toEqual([
      'MAIN',
      'BACKUP',
    ]);
  });

  it('offers the minimax wallet for a minimax route', () => {
    expect(walletOptionsForProvider(options, 'minimax').map((o) => o.name)).toEqual(['MM']);
  });

  it('offers nothing for an unknown provider', () => {
    expect(walletOptionsForProvider(options, 'openai')).toEqual([]);
    expect(walletOptionsForProvider(options, undefined)).toEqual([]);
    expect(walletServesProvider(options[0]!, 'anthropic')).toBe(false);
  });
});
