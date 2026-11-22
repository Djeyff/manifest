import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The wallet settings client talks to the REAL backend contract. These
 * receipts pin the paths it calls — in particular the provider-key list,
 * which must NOT live under /wallets/: the wallets controller owns a `:id`
 * route there and shadows every sibling path (404 "Wallet not found").
 */

const keys = [
  { id: 'tp-1', label: 'RCR', provider: 'zai', room: 'RCR', bound_wallet_id: 'w-main' },
];

let calls: string[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () =>
        String(url).endsWith('/wallet-console/keys')
          ? { keys }
          : { wallets: [], settings: {}, audit: [] },
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wallet settings client paths', () => {
  it('reads the provider keys from /wallet-console/keys', async () => {
    const { fetchProviderKeys } = await import('../../src/services/api/wallet-settings.js');
    const list = await fetchProviderKeys();
    expect(calls[0]).toContain('/api/v1/wallet-console/keys');
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('RCR');
  });

  it('never calls the shadowed /wallets/keys path', async () => {
    const { fetchProviderKeys, fetchWalletSettings, fetchWalletAudit } = await import(
      '../../src/services/api/wallet-settings.js'
    );
    await fetchProviderKeys();
    await fetchWalletSettings('w-main');
    await fetchWalletAudit('w-main');
    expect(calls.some((c) => c.endsWith('/wallets/keys'))).toBe(false);
  });
});
