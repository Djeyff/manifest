import { BASE_URL } from './core.js';
import { createSignal } from 'solid-js';

/**
 * Wallet options for the custom-tier route builder (owner order
 * D-2026-11-22-11 + naming correction D-2026-11-22-12).
 *
 * The route builder dropdown offers WALLETS, not providers. The wallet list
 * comes from the LIVE owner-only board (`GET /quota-board`); there is no
 * fixture here. A wallet that the server did not return is never invented.
 *
 * Choosing a wallet writes a KEY LABEL into the route (`keyLabel`), never the
 * wallet display name: the registered provider key labels (RCR, RCR Backup,
 * RCR MM, CCR set) are what the proxy resolves. The wallet -> key mapping is
 * automatic: the wallet's canonical key label is its first member key label
 * in the order the server returned it.
 */

/** One member key of a wallet as served by the quota board. */
export interface QuotaBoardKey {
  label: string;
  provider?: string;
}

/** One wallet as served by the quota board. */
export interface QuotaBoardWallet {
  wallet_id: string;
  name: string;
  color?: string;
  provider?: string;
  keys?: QuotaBoardKey[];
}

/** The `GET /quota-board` payload shape we consume. */
export interface QuotaBoardResponse {
  wallets?: QuotaBoardWallet[];
}

/** A wallet the owner can pick in the route builder. */
export interface WalletOption {
  wallet_id: string;
  /** Raw wallet name from the DB (MAIN / MM / BACKUP). */
  name: string;
  /** Display form, e.g. `MAIN (Z.AI Max)`. */
  display_name: string;
  /** Provider id the wallet serves (zai / minimax / …). */
  provider: string;
  /** Registered provider key labels of the wallet, in server order. */
  key_labels: string[];
}

/** Plan label per wallet name (the DB name is the source of truth). */
const PLAN_BY_NAME: Record<string, string> = {
  MAIN: 'Z.AI Max',
  MM: 'MiniMax',
  BACKUP: 'Z.AI Pro',
};

/** Fallback plan label per provider id, used when the name is unknown. */
const PLAN_BY_PROVIDER: Record<string, string> = {
  'zai-max': 'Z.AI Max',
  'zai-pro': 'Z.AI Pro',
  minimax: 'MiniMax',
};

/** Strip a decorated name (`MM · minimax`) down to its base name. */
function baseNameOf(name: string): string {
  return (name ?? '').split('·')[0]?.trim() ?? '';
}

/**
 * Display form of a wallet: `MAIN (Z.AI Max)`, `MM (MiniMax)`,
 * `BACKUP (Z.AI Pro)`. An unknown wallet name falls back to the raw name —
 * no invented wallet.
 */
export function walletDisplayName(name: string, provider?: string): string {
  const base = baseNameOf(name);
  if (!base) return name ?? '';
  const plan =
    PLAN_BY_NAME[base.toUpperCase()] ??
    (provider ? PLAN_BY_PROVIDER[provider.toLowerCase()] : undefined);
  return plan ? `${base} (${plan})` : name;
}

/** Map one quota-board wallet to a picker option. */
export function toWalletOption(wallet: QuotaBoardWallet): WalletOption {
  const keys = wallet.keys ?? [];
  const provider = (wallet.provider ?? keys[0]?.provider ?? '').trim();
  return {
    wallet_id: wallet.wallet_id,
    name: baseNameOf(wallet.name),
    display_name: walletDisplayName(wallet.name, provider),
    provider,
    key_labels: keys.map((k) => k.label).filter((label) => !!label),
  };
}

/**
 * The wallet's canonical key label: the first member key label in the order
 * the server returned it. This is the label that gets written into the route.
 */
export function canonicalKeyLabel(option: WalletOption): string | undefined {
  return option.key_labels[0];
}

/** True when the wallet can serve the given provider id. */
export function walletServesProvider(option: WalletOption, providerId: string | undefined): boolean {
  if (!providerId) return false;
  const wallet = option.provider.toLowerCase();
  const route = providerId.toLowerCase();
  if (!wallet || !route) return false;
  return wallet === route || wallet.startsWith(route) || route.startsWith(wallet);
}

/**
 * Fetch the live wallet list.
 *
 * - 403 → signed in but not the owner: empty list (never a fixture).
 * - 404 → the wallet console is not deployed: empty list (never a fixture).
 * - anything else → a real error, re-thrown.
 */
export async function fetchWalletOptions(): Promise<WalletOption[]> {
  const res = await fetch(`${BASE_URL}/quota-board`, {
    credentials: 'include',
    cache: 'default',
  });
  if (res.status === 403 || res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as QuotaBoardResponse;
  const wallets = body?.wallets ?? [];
  return wallets
    .map(toWalletOption)
    // A wallet without a member key cannot be pinned to a route.
    .filter((option) => option.key_labels.length > 0);
}

/** Shared, short-lived cache so the board is fetched once per session burst. */
const CACHE_TTL_MS = 30_000;
let cached: { at: number; promise: Promise<WalletOption[]> } | null = null;

/** Cached wallet fetch. Failures resolve to an empty list (no fixture). */
export function loadWalletOptions(): Promise<WalletOption[]> {
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    const promise = fetchWalletOptions().catch(() => [] as WalletOption[]);
    cached = { at: Date.now(), promise };
  }
  return cached.promise;
}

/** Test seam: drop the cached board. */
export function resetWalletOptionsCache(): void {
  cached = null;
}

const [walletOptionsSignal, setWalletOptionsSignal] = createSignal<WalletOption[]>([]);
let started = false;

/**
 * Reactive wallet list for the route builder. The first call starts the live
 * fetch; the signal updates when the board answers.
 */
export function useWalletOptions(): () => WalletOption[] {
  if (!started) {
    started = true;
    void loadWalletOptions().then(setWalletOptionsSignal);
  }
  return walletOptionsSignal;
}

/** The wallets that can serve a given provider id. */
export function walletOptionsForProvider(
  options: WalletOption[],
  providerId: string | undefined,
): WalletOption[] {
  if (!providerId) return [];
  return options.filter((option) => walletServesProvider(option, providerId));
}
