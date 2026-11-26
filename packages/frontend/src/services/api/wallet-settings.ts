import { BASE_URL, fetchMutate, parseErrorMessage } from './core.js';

/**
 * Wallet settings API client (RET-720, owner order D-2026-11-22-13).
 *
 * This module talks to the REAL backend contract. There is no fixture and no
 * demo fallback here: every number on the settings page comes from the
 * server, and a server refusal is surfaced verbatim.
 *
 * Routes (all under `BASE_URL` = `/api/v1`):
 *
 *   GET  /wallets                 → { wallets: WalletListItem[] }
 *   GET  /wallets/:id/settings    → { settings: WalletSettingsView }
 *   PUT  /wallets/:id/settings    → { settings, changed, audit_id, ruling }
 *   GET  /wallets/:id/settings/audit → { audit: WalletAuditRow[] }
 *   GET  /wallet-console/keys     → { keys: ProviderKeyView[] }
 *
 * (`/wallet-console/keys`, not `/wallets/keys`: the wallets controller owns a
 * `:id` route that shadows any sibling path under `/wallets/`.)
 */

/** The owner-editable daily lines of a wallet (% of the weekly pool). */
export interface WalletDailyLines {
  base_pct?: number;
  rollover_pool_pct?: number;
  floor_pct?: number;
}

/** One wallet→key binding: which registered key serves this wallet per room. */
export interface WalletKeyBinding {
  room: string;
  tenant_provider_id: string;
  /** Display only — the server resolves these from the key id. */
  label?: string;
  /** Display only. */
  provider?: string;
}

/** The wallet settings as the server serves them. */
export interface WalletSettingsView {
  wallet_id: string;
  tenant_id: string;
  drain_day_enabled: boolean;
  priority: number;
  parked: boolean;
  kill_switch_fallback: boolean;
  daily_lines: WalletDailyLines | null;
  /** Owner reserve (% of the weekly pool); null = the governor's own reserve. */
  reserve_pct: number | null;
  rollover_enabled: boolean;
  cross_class_pause: boolean;
  key_bindings: WalletKeyBinding[];
  updated_at: string;
  updated_by_user_id: string | null;
}

/** A registered provider key a wallet can be bound to. */
export interface ProviderKeyView {
  id: string;
  label: string;
  provider: string;
  room: string;
  bound_wallet_id: string | null;
}

/** One audit row of a settings change (newest first). */
export interface WalletAuditRow {
  id: string;
  wallet_id: string;
  tenant_id: string;
  actor_user_id: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ruling_id: string | null;
  created_at: string;
}

/** The decisions-ledger ruling minted for a settings change. */
export interface MintedRuling {
  id: string;
  minted_at: string;
  persisted: boolean;
}

/** The PUT response: the new settings, the audit row id and the minted ruling. */
export interface WalletSettingsUpdateResult {
  settings: WalletSettingsView;
  changed: boolean;
  audit_id: string | null;
  ruling: MintedRuling | null;
}

/**
 * An error that carries the HTTP status, so the UI can tell a refusal
 * (403 = not the owner) from a bad request (400 = the server's own sentence)
 * from anything else.
 */
export class WalletApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'WalletApiError';
    this.status = status;
  }
}

/** The three governed wallet states (RET-776-B, `GET /wallets/:id/state`). */
export type WalletStateKind = 'running' | 'paused_by_owner' | 'parked_by_governor';

/** The live state of one wallet as the server serves it. */
export interface WalletState {
  wallet_id: string;
  name: string;
  state: WalletStateKind;
  daily_left_pct: number | null;
  weekly_left_pct: number | null;
  /** When the numbers behind this state were read. */
  read_at: string | null;
  /** The numbers are older than the server's own freshness window. */
  numbers_stale: boolean;
  /** The owner's last pause/resume intent on this wallet, if any. */
  last_intent: { action: string; actor: string | null; at: string | null } | null;
  keys_active: boolean;
}

/** The intent row the server mints for a pause/resume. */
export interface WalletIntentRow {
  action: string;
  actor: string | null;
  reason: string | null;
  at: string;
}

/** The `POST /wallets/:id/intent` response. */
export interface WalletIntentResult {
  changed: boolean;
  action: string;
  accounts: string[];
  intent: WalletIntentRow;
  audit_id: string | null;
  ruling: MintedRuling | null;
  /** The state as the server sees it after the intent — the source of truth. */
  state: WalletState;
}

/**
 * GET the live state of one wallet.
 *
 * The route is `/wallets/:id/state`, NOT `/wallets/:id`: the latter is the
 * wallet-record route (RET-692-FU1) and would shadow this one.
 *
 * A refusal carries its status: 403 (not the owner) and 404 (feature off /
 * no session) are real answers the UI renders, not transport failures.
 */
export async function fetchWalletState(walletId: string): Promise<WalletState> {
  const res = await fetch(`${BASE_URL}/wallets/${encodeURIComponent(walletId)}/state`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new WalletApiError(res.status, await parseErrorMessage(res));
  }
  const body = (await res.json()) as { state?: WalletState };
  if (!body?.state) throw new WalletApiError(502, 'The server did not return a wallet state.');
  return body.state;
}

/**
 * Ask the server to pause or resume a wallet.
 *
 * The response carries the state the server ended up in — but the UI still
 * re-reads `GET /wallets/:id/state` afterwards, because a 200 with
 * `changed: false` means the intent was a no-op.
 */
export async function postWalletIntent(
  walletId: string,
  action: 'pause' | 'resume',
  reason?: string,
): Promise<WalletIntentResult> {
  const res = await fetch(`${BASE_URL}/wallets/${encodeURIComponent(walletId)}/intent`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reason ? { action, reason } : { action }),
  });
  if (!res.ok) {
    throw new WalletApiError(res.status, await parseErrorMessage(res));
  }
  return (await res.json()) as WalletIntentResult;
}

/** The intent rows of a wallet's audit trail (newest first). */
export const INTENT_ACTIONS = ['intent.pause', 'intent.resume'];

/** The last five pause/resume rows of a wallet's audit trail. */
export function intentRowsFromAudit(audit: WalletAuditRow[]): WalletAuditRow[] {
  return audit.filter((row) => INTENT_ACTIONS.includes(row.action)).slice(0, 5);
}

/** A wallet of the tenant (`GET /wallets`). */
export interface WalletListItem {
  id: string;
  name: string;
  color: string;
  member_keys: Array<{ tenant_provider_id: string; label: string; provider: string }>;
}

/** The patch body accepted by `PUT /wallets/:id/settings`. */
export interface UpdateWalletSettingsInput {
  drain_day_enabled?: boolean;
  priority?: number;
  parked?: boolean;
  kill_switch_fallback?: boolean;
  daily_lines?: WalletDailyLines | null;
  reserve_pct?: number | null;
  rollover_enabled?: boolean;
  cross_class_pause?: boolean;
  key_bindings?: Array<{ room: string; tenant_provider_id: string }>;
}

/**
 * GET with the server's own error message surfaced verbatim.
 *
 * `fetchJson` would hand back the raw body text; a Nest error body is JSON
 * (`{"message":"…"}`), so the owner would read a blob instead of the server's
 * sentence. `parseErrorMessage` unwraps it.
 */
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { credentials: 'include', cache: 'default' });
  if (!res.ok) {
    throw new Error(await parseErrorMessage(res));
  }
  return (await res.json()) as T;
}

/** The wallets of the tenant. Never a fixture: an empty list is an empty list. */
export async function fetchWallets(): Promise<WalletListItem[]> {
  const body = await getJson<{ wallets?: WalletListItem[] }>('/wallets');
  return body?.wallets ?? [];
}

/** The current settings of one wallet (defaults when never tuned). */
export async function fetchWalletSettings(walletId: string): Promise<WalletSettingsView> {
  const body = await getJson<{ settings: WalletSettingsView }>(
    `/wallets/${encodeURIComponent(walletId)}/settings`,
  );
  return body.settings;
}

/**
 * Apply a settings change.
 *
 * The server validates the patch, writes an audit row and auto-mints a
 * decisions-ledger ruling; the response carries both ids back.
 */
export async function updateWalletSettings(
  walletId: string,
  input: UpdateWalletSettingsInput,
): Promise<WalletSettingsUpdateResult> {
  return fetchMutate<WalletSettingsUpdateResult>(
    `/wallets/${encodeURIComponent(walletId)}/settings`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

/** The audit trail of one wallet (newest first). */
export async function fetchWalletAudit(
  walletId: string,
  limit?: number,
): Promise<WalletAuditRow[]> {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  const body = await getJson<{ audit?: WalletAuditRow[] }>(
    `/wallets/${encodeURIComponent(walletId)}/settings/audit${query}`,
  );
  return body?.audit ?? [];
}

/**
 * The registered provider keys a wallet can be bound to.
 *
 * The path is `/wallet-console/keys` — NOT `/wallets/keys`: the wallets
 * controller owns a `:id` route that answers 404 for anything else under
 * `/wallets/`.
 */
export async function fetchProviderKeys(): Promise<ProviderKeyView[]> {
  const body = await getJson<{ keys?: ProviderKeyView[] }>('/wallet-console/keys');
  return body?.keys ?? [];
}

/**
 * The rooms the owner can bind a key in: every room the tenant has a
 * registered key for, plus every room the wallet already has a binding in.
 */
export function bindingRooms(keys: ProviderKeyView[], bindings: WalletKeyBinding[]): string[] {
  const rooms = new Set<string>();
  for (const key of keys) if (key.room) rooms.add(key.room);
  for (const binding of bindings) if (binding.room) rooms.add(binding.room);
  return [...rooms].sort((a, b) => a.localeCompare(b));
}

/** The keys of one room, as options for the binding editor. */
export function keysForRoom(keys: ProviderKeyView[], room: string): ProviderKeyView[] {
  return keys.filter((key) => key.room === room);
}

/**
 * Build the `key_bindings` body from the owner's per-room choice.
 *
 * Only rooms with a chosen key are sent: the server replaces the wallet's
 * membership with exactly the keys it receives, so an empty room means "no key
 * in this room" — the server drops the old member.
 */
export function buildKeyBindings(
  keys: ProviderKeyView[],
  selection: Record<string, string>,
): Array<{ room: string; tenant_provider_id: string }> {
  const out: Array<{ room: string; tenant_provider_id: string }> = [];
  for (const room of Object.keys(selection).sort((a, b) => a.localeCompare(b))) {
    const id = selection[room];
    if (!id) continue;
    const key = keys.find((k) => k.id === id);
    if (!key) continue;
    out.push({ room, tenant_provider_id: id });
  }
  return out;
}
