import { createSignal } from 'solid-js';
import { fetchWalletState, WalletApiError, type WalletState } from './wallet-settings.js';
import { loadWalletOptions } from './wallet-options.js';

/**
 * The live state of every wallet the owner can pick in the tier builder
 * (RET-776-C, architect decision DC1).
 *
 * The tier-builder dropdowns show a READ-ONLY state pill. They never offer a
 * pause/unpause button: an action inside a tier form control would read as
 * "editing the tier".
 *
 * The state route is owner-only, so a non-owner simply gets an empty map and
 * no pill is rendered — the same gate the settings surface uses.
 */

const [statesSignal, setStatesSignal] = createSignal<Record<string, WalletState>>({});
let started = false;

/**
 * Read the state of every wallet the server knows about.
 *
 * One wallet failing (403 for a non-owner, 404 while the feature is off, a
 * transport hiccup) must not blank the rest: each wallet is read on its own
 * and a failure only skips that wallet.
 */
export async function fetchWalletStates(walletIds: string[]): Promise<Record<string, WalletState>> {
  const entries = await Promise.all(
    walletIds.map(async (id) => {
      try {
        return [id, await fetchWalletState(id)] as const;
      } catch (err) {
        // A refusal is not a failure of the page: skip this wallet.
        if (err instanceof WalletApiError) return null;
        throw err;
      }
    }),
  );
  const out: Record<string, WalletState> = {};
  for (const entry of entries) if (entry) out[entry[0]] = entry[1];
  return out;
}

/** Reactive map of wallet id → live state. Starts the first live read. */
export function useWalletStates(): () => Record<string, WalletState> {
  if (!started) {
    started = true;
    void loadWalletOptions()
      .then((options) => fetchWalletStates(options.map((option) => option.wallet_id)))
      .then(setStatesSignal)
      .catch(() => setStatesSignal({}));
  }
  return statesSignal;
}

/** Test seam: drop the cached states and the one-shot start. */
export function resetWalletStates(): void {
  started = false;
  setStatesSignal({});
}
