import { For, Show, createResource, createSignal } from 'solid-js';
import { Title } from '@solidjs/meta';
import {
  askCrew,
  getWalletConsoleAccess,
  getWalletSettings,
  updateWalletLine,
  type WalletLine,
} from '../services/api/wallet-console';
import {
  AskCrew,
  AuditTrail,
  Callout,
  Formula,
  Kv,
  Pill,
  WalletChip,
} from '../components/wallet-console/Console';

/**
 * Wallet settings (RET-721, mockup 1/3 — DARK).
 *
 * Every change on this page writes an audit row and auto-mints a ruling; the
 * console renders the ruling id the server returns. Budget arithmetic happens
 * on the server: the formula strip below is the server's strip, not a
 * client-side sum.
 */
export default function WalletSettings() {
  const [access] = createResource(getWalletConsoleAccess);
  const [settings, { refetch }] = createResource(
    () => access()?.owner !== false,
    async () => getWalletSettings(),
  );
  const [drafts, setDrafts] = createSignal<Record<string, { base: number; rollover: number }>>({});
  const [saving, setSaving] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const draftFor = (line: WalletLine) =>
    drafts()[line.wallet_id] ?? { base: line.base_pct, rollover: line.rollover_pct };

  const setDraft = (walletId: string, key: 'base' | 'rollover', value: number) => {
    const line = settings()?.lines.find((l) => l.wallet_id === walletId);
    if (!line) return;
    setDrafts((prev) => ({
      ...prev,
      [walletId]: {
        base: prev[walletId]?.base ?? line.base_pct,
        rollover: prev[walletId]?.rollover ?? line.rollover_pct,
        ...(key === 'base' ? { base: value } : { rollover: value }),
      },
    }));
    setSaved(null);
  };

  const save = async (line: WalletLine) => {
    const draft = draftFor(line);
    setSaving(line.wallet_id);
    setError(null);
    try {
      const next = await updateWalletLine({
        wallet_id: line.wallet_id,
        base_pct: draft.base,
        rollover_pct: draft.rollover,
      });
      // The server response carries the new line, the fresh audit row and the
      // re-read governor tick — replace the page state with it wholesale.
      setDrafts((prev) => {
        const { [line.wallet_id]: _dropped, ...rest } = prev;
        return rest;
      });
      setSaved(line.wallet_id);
      refetch();
      void next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the line.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <Title>Wallet settings · Manifest</Title>
      <Show when={access()?.owner === false}>
        <div class="wc-gate">
          <h1>Owner only</h1>
          <p class="wc-note">
            The wallet console is restricted to the tenant owner. Sign in as the owner to see budget
            lines, governor state and audit history.
          </p>
        </div>
      </Show>
      <Show when={access()?.owner !== false}>
        <div class="wc-page-header">
          <div>
            <h1>Wallet settings</h1>
            <div class="wc-breadcrumb">Wallets / Budget lines &amp; routing order</div>
          </div>
          <div class="wc-header-controls">
            <Show when={settings()?.demo}>
              <span class="wc-demo-note">demo data · live API not deployed yet</span>
            </Show>
            <Show when={settings()?.governor_tick}>
              {(tick) => (
                <Pill tone="ok">
                  governor tick {tick().mode} · {tick().allowed_pct.toFixed(1)}% allowed
                </Pill>
              )}
            </Show>
          </div>
        </div>

        <Show when={error()}>
          <Callout tone="danger">{error()!}</Callout>
        </Show>

        <Show when={saved()}>
          <Callout>
            Line saved. The audit row and the auto-minted ruling are below, and the governor tick
            above re-read the new allowance.
          </Callout>
        </Show>

        <Show
          when={settings()}
          fallback={
            <div class="wc-state" role="status">
              Loading wallet lines…
            </div>
          }
        >
          {(data) => (
            <>
              <Callout>
                Every change on this page writes an <b>audit row</b> and <b>auto-mints a
                decisions-ledger ruling</b>. The ruling id is shown beside the change — a UI action is
                doctrine, so nothing here can drift from the ledger.
              </Callout>

              <section class="wc-panel" aria-labelledby="wc-lines-title">
                <div class="wc-panel__title" id="wc-lines-title">
                  Daily budget line <span class="sub">per wallet · base + rollover + reserve − floor</span>
                </div>
                <For each={data().lines}>
                  {(line) => {
                    const draft = () => draftFor(line);
                    return (
                      <div class="wc-budget-line">
                        <div class="wc-budget-line__grid">
                          <div>
                            <span class="wc-field__label">Wallet</span>
                            <WalletChip tone={line.color}>
                              {line.name} · {line.provider}
                            </WalletChip>
                            <Show when={line.reset_hint}>
                              <span class="wc-field__hint">{line.reset_hint}</span>
                            </Show>
                            <Show when={line.note}>
                              <span class="wc-field__hint">{line.note}</span>
                            </Show>
                          </div>
                          <div>
                            <label class="wc-field__label" for={`base-${line.wallet_id}`}>
                              Daily base (%)
                            </label>
                            <input
                              id={`base-${line.wallet_id}`}
                              class="wc-input"
                              inputmode="decimal"
                              value={draft().base.toFixed(1)}
                              onInput={(e) =>
                                setDraft(line.wallet_id, 'base', Number(e.currentTarget.value))
                              }
                            />
                            <span class="wc-field__hint">Owner words: “10% per day + reserve.”</span>
                          </div>
                          <div>
                            <label class="wc-field__label" for={`roll-${line.wallet_id}`}>
                              Rollover carried in (%)
                            </label>
                            <input
                              id={`roll-${line.wallet_id}`}
                              class="wc-input"
                              inputmode="decimal"
                              value={draft().rollover.toFixed(1)}
                              onInput={(e) =>
                                setDraft(line.wallet_id, 'rollover', Number(e.currentTarget.value))
                              }
                            />
                            <span class="wc-field__hint">
                              Yesterday's reserve, unlocked this morning.
                            </span>
                          </div>
                          <div>
                            <span class="wc-field__label">Emergency floor (%)</span>
                            <input
                              class="wc-input wc-input--locked"
                              value={line.floor_pct.toFixed(1)}
                              readonly
                              aria-describedby={`floor-hint-${line.wallet_id}`}
                            />
                            <span class="wc-field__hint" id={`floor-hint-${line.wallet_id}`}>
                              Locked. Normal traffic can never touch it.
                            </span>
                          </div>
                          <div>
                            <span class="wc-field__label">Save</span>
                            <button
                              class="btn btn--primary"
                              type="button"
                              disabled={saving() === line.wallet_id}
                              onClick={() => void save(line)}
                            >
                              {saving() === line.wallet_id ? 'Saving…' : 'Save & mint ruling'}
                            </button>
                            <span class="wc-field__hint">
                              Writes an audit row and mints a ruling for this wallet.
                            </span>
                          </div>
                        </div>
                        <Formula formula={line.formula} />
                      </div>
                    );
                  }}
                </For>
              </section>

              <div class="wc-split-2">
                <div>
                  <section class="wc-panel" aria-labelledby="wc-behaviour-title">
                    <div class="wc-panel__title" id="wc-behaviour-title">
                      Behaviour
                    </div>
                    <div class="wc-kv">
                      <span class="wc-kv__k">Drain-day auto-lift</span>
                      <span class="wc-kv__v">
                        <Pill tone="drain">
                          {data().behaviour.drain_auto_lift ? 'Default ON' : 'Off'}
                        </Pill>
                      </span>
                    </div>
                    <div class="wc-kv">
                      <span class="wc-kv__k">Emergency park</span>
                      <span class="wc-kv__v">
                        <Pill tone={data().behaviour.parked ? 'warn' : 'neutral'}>
                          {data().behaviour.parked ? 'Parked' : 'Active'}
                        </Pill>
                      </span>
                    </div>
                    <div class="wc-kv">
                      <span class="wc-kv__k">Kill-switch to fallback</span>
                      <span class="wc-kv__v">
                        <Pill tone={data().behaviour.kill_switch_to_fallback ? 'danger' : 'neutral'}>
                          {data().behaviour.kill_switch_to_fallback ? 'On fallback' : 'Armed'}
                        </Pill>
                      </span>
                    </div>
                    <div class="wc-kv">
                      <span class="wc-kv__k">Budget enforcement mode</span>
                      <span class="wc-kv__v">
                        <Pill tone="ok">
                          <span class="wc-pill__dot" aria-hidden="true" />
                          {data().behaviour.budget_mode}
                        </Pill>
                      </span>
                    </div>
                    <p class="wc-note">
                      Reads live from <code>{data().behaviour.budget_mode_source}</code>.
                    </p>
                  </section>

                  <section class="wc-panel" aria-labelledby="wc-order-title">
                    <div class="wc-panel__title" id="wc-order-title">
                      Wallet priority &amp; order <span class="sub">who draws first</span>
                    </div>
                    <div class="wc-order-list">
                      <For each={data().priority}>
                        {(row) => (
                          <div class="wc-order-item">
                            <span class="wc-order-item__rank">{row.rank}</span>
                            <span class="wc-order-item__name">{row.name}</span>
                            <span class="wc-lane-tags">
                              <For each={row.lane_tags}>
                                {(tag) => (
                                  <span
                                    class={`wc-lane-tag${row.lane_tags_live ? ' wc-lane-tag--live' : ''}`}
                                  >
                                    {tag}
                                  </span>
                                )}
                              </For>
                            </span>
                            <Pill tone={row.pill.tone}>{row.pill.label}</Pill>
                          </div>
                        )}
                      </For>
                    </div>
                    <p class="wc-note">
                      Reordering mints a routing-priority ruling on save.
                    </p>
                  </section>
                </div>

                <div>
                  <section class="wc-panel" aria-labelledby="wc-ask-title">
                    <div class="wc-panel__title" id="wc-ask-title">
                      Ask the crew
                    </div>
                    <AskCrew
                      placeholder="e.g. lift MM to 14% for the 03:00 batch"
                      onFile={async (message) => {
                        await askCrew(message);
                      }}
                    />
                    <p class="wc-note">
                      Files a needs-you card against this wallet and posts it to the crew lane.
                      Nothing here changes the live line until the crew answers.
                    </p>
                  </section>

                  <section class="wc-panel" aria-labelledby="wc-audit-title">
                    <div class="wc-panel__title" id="wc-audit-title">
                      Audit &amp; rulings <span class="sub">auto-minted</span>
                    </div>
                    <AuditTrail entries={data().audit} />
                  </section>

                  <section class="wc-panel" aria-labelledby="wc-keys-title">
                    <div class="wc-panel__title" id="wc-keys-title">
                      Wallet keys
                    </div>
                    <For each={data().members}>
                      {(member) => <Kv k={member.wallet} v={member.keys} />}
                    </For>
                    <Kv k="Week anchor" v={data().week_anchor ?? '—'} />
                    <Kv k="Night window" v={data().night_window ?? '—'} />
                  </section>
                </div>
              </div>
            </>
          )}
        </Show>
      </Show>
    </>
  );
}
