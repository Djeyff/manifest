import { For, Show, createEffect, createResource, createSignal } from 'solid-js';
import { Title } from '@solidjs/meta';
import {
  buildKeyBindings,
  bindingRooms,
  fetchProviderKeys,
  fetchWalletAudit,
  fetchWalletSettings,
  fetchWallets,
  keysForRoom,
  updateWalletSettings,
  type ProviderKeyView,
  type WalletAuditRow,
  type WalletListItem,
  type WalletSettingsView,
} from '../services/api/wallet-settings.js';
import { walletDisplayName } from '../services/api/wallet-options.js';
import { Callout, Pill } from '../components/wallet-console/Console';
import WalletIntentControl from '../components/wallet-console/WalletIntentControl.js';
import { getWalletConsoleAccess } from '../services/api/wallet-console.js';

/**
 * Wallet settings — the real editor (RET-720, owner order D-2026-11-22-13).
 *
 * Every number on this page comes from the live API. There is no demo payload
 * and no client-side arithmetic: the daily line, the reserve, the rollover and
 * cross-class rules and the key bindings are read from
 * `GET /wallets/:id/settings` and written back with `PUT /wallets/:id/settings`.
 *
 * The server owns the consequences of a save: it validates the patch, writes
 * the audit row and auto-mints a decisions-ledger ruling. This page shows the
 * returned audit id and ruling id and then re-reads the audit trail, so the
 * owner sees the row the server actually wrote — never an optimistic guess.
 */

/** The editable draft of one wallet. */
interface WalletDraft {
  /** Daily base line (%), free text so an empty field stays empty. */
  base_pct: string;
  /** Owner reserve (%), empty = the governor's own reserve. */
  reserve_pct: string;
  rollover_enabled: boolean;
  cross_class_pause: boolean;
  /** room → the registered key id serving that room. */
  bindings: Record<string, string>;
}

/** One wallet with its settings and audit trail. */
interface WalletEntry {
  wallet: WalletListItem;
  settings: WalletSettingsView;
  audit: WalletAuditRow[];
}

function draftFrom(settings: WalletSettingsView): WalletDraft {
  const bindings: Record<string, string> = {};
  for (const binding of settings.key_bindings ?? []) {
    bindings[binding.room] = binding.tenant_provider_id;
  }
  return {
    base_pct:
      settings.daily_lines?.base_pct === undefined ? '' : String(settings.daily_lines.base_pct),
    reserve_pct: settings.reserve_pct === null ? '' : String(settings.reserve_pct),
    rollover_enabled: settings.rollover_enabled,
    cross_class_pause: settings.cross_class_pause,
    bindings,
  };
}

export default function WalletSettings() {
  const [bundle, { refetch }] = createResource(async () => {
    const [wallets, keys] = await Promise.all([fetchWallets(), fetchProviderKeys()]);
    const entries: WalletEntry[] = await Promise.all(
      wallets.map(async (wallet) => ({
        wallet,
        settings: await fetchWalletSettings(wallet.id),
        audit: await fetchWalletAudit(wallet.id),
      })),
    );
    return { wallets, keys, entries };
  });

  const [access] = createResource(async () => {
    try {
      return await getWalletConsoleAccess();
    } catch {
      return { owner: false, available: false };
    }
  });

  const [drafts, setDrafts] = createSignal<Record<string, WalletDraft>>({});
  const [saving, setSaving] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  // Seed a draft per wallet the first time its settings arrive, and re-seed
  // after a save (the server's own values win over the draft).
  createEffect(() => {
    const data = bundle();
    if (!data) return;
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const entry of data.entries) {
        if (!next[entry.wallet.id]) {
          next[entry.wallet.id] = draftFrom(entry.settings);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  });

  const patchDraft = (walletId: string, patch: Partial<WalletDraft>) => {
    setDrafts((prev) => {
      const current = prev[walletId];
      if (!current) return prev;
      return { ...prev, [walletId]: { ...current, ...patch } };
    });
    setStatus(null);
  };

  const setBinding = (walletId: string, room: string, keyId: string) => {
    setDrafts((prev) => {
      const current = prev[walletId];
      if (!current) return prev;
      const bindings = { ...current.bindings };
      if (keyId) bindings[room] = keyId;
      else delete bindings[room];
      return { ...prev, [walletId]: { ...current, bindings } };
    });
    setStatus(null);
  };

  const save = async (entry: WalletEntry, keys: ProviderKeyView[]) => {
    const draft = drafts()[entry.wallet.id];
    if (!draft) return;
    setSaving(entry.wallet.id);
    setStatus(null);
    try {
      const base = draft.base_pct.trim();
      const reserve = draft.reserve_pct.trim();
      const result = await updateWalletSettings(entry.wallet.id, {
        daily_lines: {
          ...(entry.settings.daily_lines ?? {}),
          ...(base === '' ? {} : { base_pct: Number(base) }),
        },
        reserve_pct: reserve === '' ? null : Number(reserve),
        rollover_enabled: draft.rollover_enabled,
        cross_class_pause: draft.cross_class_pause,
        key_bindings: buildKeyBindings(keys, draft.bindings),
      });
      setDrafts((prev) => ({ ...prev, [entry.wallet.id]: draftFrom(result.settings) }));
      const auditId = result.audit_id ?? 'no audit row (nothing changed)';
      const rulingId = result.ruling?.id ?? 'no ruling';
      setStatus({
        tone: 'ok',
        text: `Saved — audit ${auditId} · ruling ${rulingId}.`,
      });
      await refetch();
    } catch (err) {
      // The server's own sentence, verbatim.
      setStatus({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'Could not save the wallet settings.',
      });
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <Title>Wallet settings · Manifest</Title>
      <div class="wc-page-header">
        <div>
          <h1>Wallet settings</h1>
          <div class="wc-breadcrumb">Wallets / Rules &amp; key bindings</div>
        </div>
      </div>

      <Show
        when={bundle()}
        fallback={
          <Show
            when={!bundle.error}
            fallback={
              <div role="alert">
                <Callout tone="danger">
                  {bundle.error instanceof Error
                    ? bundle.error.message
                    : 'Could not load the wallet settings.'}
                </Callout>
              </div>
            }
          >
            <div class="wc-state" role="status">
              Loading wallet settings…
            </div>
          </Show>
        }
      >
        {(data) => (
          <>
            <Show when={status()}>
              {(note) => (
                <div role={note().tone === 'danger' ? 'alert' : 'status'}>
                  <Callout tone={note().tone === 'danger' ? 'danger' : 'info'}>
                    {note().text}
                  </Callout>
                </div>
              )}
            </Show>

            <Show
              when={data().entries.length > 0}
              fallback={
                <div class="wc-state" role="status">
                  No wallets yet. Create one in the Wallets page and it will appear here.
                </div>
              }
            >
              <For each={data().entries}>
                {(entry) => {
                  const draft = () => drafts()[entry.wallet.id];
                  const displayName = () =>
                    walletDisplayName(
                      entry.wallet.name,
                      entry.wallet.member_keys?.[0]?.provider ?? undefined,
                    );
                  const rooms = () => bindingRooms(data().keys, entry.settings.key_bindings ?? []);
                  return (
                    <section class="wc-panel" aria-labelledby={`wallet-${entry.wallet.id}`}>
                      <div class="wc-panel__title" id={`wallet-${entry.wallet.id}`}>
                        {displayName()}{' '}
                        <span class="sub">daily line · reserve · rules · key bindings</span>
                      </div>

                      <div class="wc-budget-line__grid">
                        <div>
                          <label class="wc-field__label" for={`base-${entry.wallet.id}`}>
                            Daily base (%)
                          </label>
                          <input
                            id={`base-${entry.wallet.id}`}
                            class="wc-input"
                            inputmode="decimal"
                            type="text"
                            value={draft()?.base_pct ?? ''}
                            aria-describedby={`base-hint-${entry.wallet.id}`}
                            onInput={(e) =>
                              patchDraft(entry.wallet.id, { base_pct: e.currentTarget.value })
                            }
                          />
                          <span class="wc-field__hint" id={`base-hint-${entry.wallet.id}`}>
                            % of the weekly pool allowed per ration day. Empty leaves the server
                            value.
                          </span>
                        </div>

                        <div>
                          <label class="wc-field__label" for={`reserve-${entry.wallet.id}`}>
                            Reserve (%)
                          </label>
                          <input
                            id={`reserve-${entry.wallet.id}`}
                            class="wc-input"
                            inputmode="decimal"
                            type="text"
                            value={draft()?.reserve_pct ?? ''}
                            aria-describedby={`reserve-hint-${entry.wallet.id}`}
                            onInput={(e) =>
                              patchDraft(entry.wallet.id, { reserve_pct: e.currentTarget.value })
                            }
                          />
                          <span class="wc-field__hint" id={`reserve-hint-${entry.wallet.id}`}>
                            Kept back for this wallet (0–100). Empty = the governor's own reserve.
                          </span>
                        </div>

                        <div>
                          <span class="wc-field__label" id={`rollover-label-${entry.wallet.id}`}>
                            Rollover
                          </span>
                          <div role="group" aria-labelledby={`rollover-label-${entry.wallet.id}`}>
                            <label class="wc-field__label" for={`rollover-${entry.wallet.id}`}>
                              <input
                                id={`rollover-${entry.wallet.id}`}
                                type="checkbox"
                                checked={draft()?.rollover_enabled ?? false}
                                onChange={(e) =>
                                  patchDraft(entry.wallet.id, {
                                    rollover_enabled: e.currentTarget.checked,
                                  })
                                }
                              />{' '}
                              Replay completed-day surplus
                            </label>
                            <span class="wc-field__hint">
                              When off, yesterday's surplus is not replayed into the next day.
                            </span>
                          </div>
                        </div>

                        <div>
                          <span class="wc-field__label" id={`pause-label-${entry.wallet.id}`}>
                            Cross-class pause
                          </span>
                          <div role="group" aria-labelledby={`pause-label-${entry.wallet.id}`}>
                            <label class="wc-field__label" for={`pause-${entry.wallet.id}`}>
                              <input
                                id={`pause-${entry.wallet.id}`}
                                type="checkbox"
                                checked={draft()?.cross_class_pause ?? false}
                                onChange={(e) =>
                                  patchDraft(entry.wallet.id, {
                                    cross_class_pause: e.currentTarget.checked,
                                  })
                                }
                              />{' '}
                              Pause the whole provider class
                            </label>
                            <span class="wc-field__hint">
                              When on, pausing this wallet also pauses its class.
                            </span>
                          </div>
                        </div>

                        <div>
                          <span class="wc-field__label">Save</span>
                          <button
                            class="btn btn--primary"
                            type="button"
                            disabled={saving() === entry.wallet.id}
                            onClick={() => void save(entry, data().keys)}
                          >
                            {saving() === entry.wallet.id ? 'Saving…' : 'Save & mint ruling'}
                          </button>
                          <span class="wc-field__hint">
                            Writes an audit row and mints a decisions-ledger ruling.
                          </span>
                        </div>
                      </div>

                      <div class="wc-panel" aria-labelledby={`keys-${entry.wallet.id}`}>
                        <div class="wc-panel__title" id={`keys-${entry.wallet.id}`}>
                          Key bindings{' '}
                          <span class="sub">which registered key serves each room</span>
                        </div>
                        <Show
                          when={rooms().length > 0}
                          fallback={
                            <div class="wc-state" role="status">
                              No registered keys to bind.
                            </div>
                          }
                        >
                          <For each={rooms()}>
                            {(room) => {
                              const options = () => keysForRoom(data().keys, room);
                              const selected = () => draft()?.bindings[room] ?? '';
                              const boundLabel = () =>
                                entry.settings.key_bindings?.find((b) => b.room === room)?.label ??
                                'not bound';
                              return (
                                <div>
                                  <label
                                    class="wc-field__label"
                                    for={`binding-${entry.wallet.id}-${room}`}
                                  >
                                    {room} room
                                  </label>
                                  <select
                                    id={`binding-${entry.wallet.id}-${room}`}
                                    class="wc-input"
                                    value={selected()}
                                    aria-describedby={`binding-hint-${entry.wallet.id}-${room}`}
                                    onChange={(e) =>
                                      setBinding(entry.wallet.id, room, e.currentTarget.value)
                                    }
                                  >
                                    <option value="">— no key —</option>
                                    <For each={options()}>
                                      {(key) => (
                                        <option value={key.id}>
                                          {key.label} · {key.provider}
                                          {key.bound_wallet_id ? ' (bound elsewhere)' : ''}
                                        </option>
                                      )}
                                    </For>
                                  </select>
                                  <span
                                    class="wc-field__hint"
                                    id={`binding-hint-${entry.wallet.id}-${room}`}
                                  >
                                    Currently {boundLabel()}. Saving replaces this wallet's keys
                                    with exactly the ones selected here.
                                  </span>
                                </div>
                              );
                            }}
                          </For>
                        </Show>
                      </div>

                      <WalletIntentControl
                        walletId={entry.wallet.id}
                        walletName={displayName()}
                        access={access()}
                      />

                      <div class="wc-panel" aria-labelledby={`audit-${entry.wallet.id}`}>
                        <div class="wc-panel__title" id={`audit-${entry.wallet.id}`}>
                          Audit &amp; rulings <span class="sub">server-written</span>
                        </div>
                        <Show
                          when={entry.audit.length > 0}
                          fallback={
                            <div class="wc-state" role="status">
                              No audit rows yet.
                            </div>
                          }
                        >
                          <div class="wc-trail">
                            <For each={entry.audit}>
                              {(row) => (
                                <div class="wc-trail__row">
                                  <span class="wc-trail__time">{row.created_at}</span>
                                  <div class="wc-trail__body">
                                    {row.action}
                                    <Show when={row.ruling_id}>
                                      <span class="wc-ruling-chip">{row.ruling_id}</span>
                                    </Show>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                        <p class="wc-note">
                          <Pill tone="neutral">
                            {entry.settings.rollover_enabled ? 'rollover on' : 'rollover off'}
                          </Pill>{' '}
                          <Pill tone="neutral">
                            {entry.settings.cross_class_pause
                              ? 'cross-class pause on'
                              : 'cross-class pause off'}
                          </Pill>
                          {entry.settings.updated_at ? (
                            <span class="wc-note"> · last change {entry.settings.updated_at}</span>
                          ) : null}
                        </p>
                      </div>
                    </section>
                  );
                }}
              </For>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
