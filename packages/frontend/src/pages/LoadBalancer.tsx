import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { Title } from '@solidjs/meta';
import {
  askCrew,
  getLoadBalancer,
  getWalletConsoleAccess,
  type LoadBalancerCard,
} from '../services/api/wallet-console';
import {
  AskCrew,
  Callout,
  Kv,
  Meter,
  Pill,
  WalletChip,
} from '../components/wallet-console/Console';

/**
 * Load balancer (RET-721, mockup 2/3 — DARK).
 *
 * Cards refresh on a timer so the owner sees the balancer move; every number
 * arrives from the server. Nothing here computes headroom on the client.
 */

const REFRESH_MS = 15_000;

/** A server-published percentage, or an explicit "not published" marker. */
function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}%`;
}

export default function LoadBalancer() {
  const [access] = createResource(getWalletConsoleAccess);
  const [balancer, { refetch }] = createResource(
    () => access()?.owner === true,
    async () => getLoadBalancer(),
  );
  const [lastRefresh, setLastRefresh] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      await refetch();
      setLastRefresh(new Date().toISOString());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh the balancer.');
    }
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => void refresh(), REFRESH_MS);
    void refresh();
  });
  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  const tone = (card: LoadBalancerCard) => card.state.tone;

  /** The engine's published base daily line (% of the weekly pool per ration day). */
  const baseLine = (): number | null => {
    for (const line of balancer()?.day_lines ?? []) {
      if (typeof line.base_pct === 'number') return line.base_pct;
    }
    return null;
  };

  /** The engine's published reserve held back (% of the weekly pool). */
  const reserveLine = (): number | null => {
    for (const line of balancer()?.day_lines ?? []) {
      if (typeof line.reserve_pct === 'number') return line.reserve_pct;
    }
    return null;
  };

  return (
    <>
      <Title>Load balancer · Manifest</Title>
      <Show when={access()?.owner === false}>
        <div class="wc-gate">
          <h1>Owner only</h1>
          <p class="wc-note">
            The wallet console is restricted to the tenant owner. Sign in as the owner to see lane
            concurrency, quota headroom and provider state.
          </p>
        </div>
      </Show>
      <Show when={access()?.owner !== false}>
        <div class="wc-page-header">
          <div>
            <h1>Load balancer</h1>
            <div class="wc-breadcrumb">Wallets / who draws first</div>
          </div>
          <div class="wc-header-controls">
            <Show when={lastRefresh()}>
              {(at) => <span class="wc-note">updated {at().slice(11, 16)}Z</span>}
            </Show>
            <button class="btn btn--outline" type="button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </div>

        <Show when={error()}>
          <Callout tone="danger">{error()!}</Callout>
        </Show>

        <Show
          when={balancer()}
          fallback={
            <div class="wc-state" role="status">
              Loading balancer…
            </div>
          }
        >
          {(data) => (
            <>
              <Callout>
                The balancer decides <b>which wallet draws next</b> by priority, then by remaining
                headroom. Every card below is a live read — the console refreshes them on a timer so
                the owner sees the lane move.
              </Callout>

              <div class="wc-panel">
                <div class="wc-panel__title">
                  Admission <span class="sub">who is drawing right now</span>
                </div>
                <Pill tone={data().admission.tone}>{data().admission.label}</Pill>
              </div>

              <Show
                when={data().engine}
                fallback={
                  <div class="wc-panel">
                    <div class="wc-panel__title">
                      Allowance engine <span class="sub">rollover · anchors · ticks</span>
                    </div>
                    <div class="wc-state" role="status">
                      The governor published no allowance-engine state, so no engine numbers are
                      drawn.
                    </div>
                  </div>
                }
              >
                {(engine) => (
                  <div class="wc-panel">
                    <div class="wc-panel__title">
                      Allowance engine <span class="sub">rollover · anchors · ticks</span>
                    </div>
                    <div class="wc-split-2">
                      <section class="wc-panel">
                        <div class="wc-panel__title">Rollover</div>
                        <Kv
                          k="Rollover"
                          v={
                            engine().rollover_enabled
                              ? 'on — completed-day surplus is replayed'
                              : 'off — no surplus is replayed'
                          }
                        />
                        <Kv k="Model" v={engine().rollover_model ?? 'not published'} />
                        <Kv k="Mode" v={engine().rollover_mode ?? 'not published'} />
                        <Kv k="Active" v={engine().rollover_active ?? 'not published'} />
                        <Kv k="Reason" v={engine().rollover_reason ?? 'not published'} />
                      </section>
                      <section class="wc-panel">
                        <div class="wc-panel__title">Pool membership</div>
                        <Kv k="Primary" v={engine().primary ?? 'not published'} />
                        <Kv
                          k="Primary usable"
                          v={
                            engine().primary_usable_pct === null
                              ? 'not published'
                              : `${engine().primary_usable_pct!.toFixed(2)}%`
                          }
                        />
                        <Kv k="Backup" v={engine().backup ?? 'not published'} />
                        <Kv
                          k="Backup usable"
                          v={
                            engine().backup_usable_pct === null
                              ? 'not published'
                              : `${engine().backup_usable_pct!.toFixed(2)}%`
                          }
                        />
                        <Kv
                          k="Backup membership"
                          v={
                            engine().backup_membership_active
                              ? `active${engine().backup_membership_end ? ` until ${engine().backup_membership_end}` : ''}`
                              : 'inactive'
                          }
                        />
                      </section>
                    </div>
                    <div class="wc-split-2">
                      <section class="wc-panel">
                        <div class="wc-panel__title">Reset anchors</div>
                        <Kv k="Week start" v={engine().week_start ?? 'not published'} />
                        <Kv k="Day start (UTC)" v={engine().day_start_utc ?? 'not published'} />
                        <Kv k="Day epoch" v={engine().day_epoch ?? 'not published'} />
                        <Kv
                          k="New ration day"
                          v={engine().new_ration_day ? 'yes — today is a new ration day' : 'no'}
                        />
                      </section>
                      <section class="wc-panel">
                        <div class="wc-panel__title">Enforcement</div>
                        <Kv
                          k="Last enforcement tick"
                          v={data().enforce_tick_at ?? engine().enforce_tick_at ?? 'not published'}
                        />
                        <Kv
                          k="Base daily line"
                          v={
                            baseLine()
                              ? `${baseLine()!.toFixed(2)}% of the weekly pool per ration day`
                              : 'not published'
                          }
                        />
                        <Kv
                          k="Reserve held back"
                          v={
                            reserveLine()
                              ? `${reserveLine()!.toFixed(2)}% of the weekly pool`
                              : 'not published'
                          }
                        />
                      </section>
                    </div>
                    <p class="wc-note">
                      Every number here is the governor's own published state — the console never
                      recomputes the allowance engine.
                    </p>
                  </div>
                )}
              </Show>

              <div class="wc-panel">
                <div class="wc-panel__title">
                  Per-wallet day lines <span class="sub">one line per wallet account</span>
                </div>
                <Show
                  when={data().day_lines.length > 0}
                  fallback={
                    <div class="wc-state" role="status">
                      The governor published no day lines for this tenant.
                    </div>
                  }
                >
                  <table class="wc-table">
                    <thead>
                      <tr>
                        <th scope="col">Wallet</th>
                        <th scope="col">Day</th>
                        <th scope="col" class="num">
                          Base
                        </th>
                        <th scope="col" class="num">
                          Rollover
                        </th>
                        <th scope="col" class="num">
                          Reserve
                        </th>
                        <th scope="col" class="num">
                          Allowed
                        </th>
                        <th scope="col" class="num">
                          Used
                        </th>
                        <th scope="col" class="num">
                          Left
                        </th>
                        <th scope="col" class="num">
                          Pace / h
                        </th>
                        <th scope="col" class="num">
                          End of day
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={data().day_lines}>
                        {(line) => (
                          <tr>
                            <th scope="row" style="font-weight:600;text-align:left">
                              <WalletChip tone={line.name.toLowerCase()}>
                                {line.display_name}
                              </WalletChip>
                              <div class="wc-note">{line.account}</div>
                            </th>
                            <td>{line.day_label ?? '—'}</td>
                            <td class="num">{pct(line.base_pct)}</td>
                            <td class="num">{pct(line.rollover_pct)}</td>
                            <td class="num">{pct(line.reserve_pct)}</td>
                            <td class="num">{pct(line.allowed_pct)}</td>
                            <td class="num">{pct(line.used_pct)}</td>
                            <td class="num">{pct(line.remaining_pct)}</td>
                            <td class="num">{pct(line.pace_pct_per_h)}</td>
                            <td class="num">{pct(line.projected_end_pct)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                  <p class="wc-note">
                    <b>Projected reset-day end state</b> — the last column is what each line is
                    projected to spend by the end of the ration day at the current burn pace. The
                    day line is the governor's own: base + rollover − floor, with the reserve held
                    back, and the day's reset anchor is the ration day, never a wall-clock midnight.
                  </p>
                </Show>
              </div>

              <div class="wc-lb-grid">
                <For each={data().cards}>
                  {(card) => (
                    <article class={`wc-lb-card wc-lb-card--${card.state.tone}`}>
                      <div class="wc-lb-card__head">
                        <div>
                          <div class="wc-lb-card__name">
                            <WalletChip tone={card.name.toLowerCase()}>
                              {card.display_name}
                            </WalletChip>
                          </div>
                          <div class="wc-lb-card__lanes">{card.state.label}</div>
                        </div>
                        <Pill tone={tone(card)}>{card.state.label}</Pill>
                      </div>

                      <div class="wc-lane-tags">
                        <For each={card.lane_tags}>
                          {(tag) => (
                            <span
                              class={`wc-lane-tag${card.lane_tags_live ? ' wc-lane-tag--live' : ''}`}
                            >
                              {tag}
                            </span>
                          )}
                        </For>
                      </div>

                      <Meter
                        label="5-hour window"
                        value={card.window.pct_left}
                        valueLabel={`${card.window.pct_left}% left`}
                        sub={card.window.resets_label ?? undefined}
                        tone={card.window.pct_left < 60 ? 'warn' : 'ok'}
                      />
                      <Meter
                        label="Weekly"
                        value={card.weekly.pct_left}
                        valueLabel={`${card.weekly.pct_left}% left`}
                        sub={card.weekly.resets_label ?? undefined}
                        tone={card.weekly.pct_left < 60 ? 'warn' : 'ok'}
                      />

                      <div class="wc-lb-card__stats">
                        <div>
                          <div class="wc-lb-stat__label">In flight</div>
                          <div class="wc-lb-stat__value">
                            {card.in_flight} / {card.ceiling}
                          </div>
                        </div>
                        <div>
                          <div class="wc-lb-stat__label">Priority</div>
                          <div class="wc-lb-stat__value">{card.priority}</div>
                          <div class="wc-lb-stat__reset">{card.priority_hint}</div>
                        </div>
                        <div>
                          <div class="wc-lb-stat__label">Provider state</div>
                          <div class="wc-lb-stat__value">
                            <Pill tone={card.provider_state.tone}>
                              {card.provider_state.label}
                            </Pill>
                          </div>
                          <div class="wc-lb-stat__reset">{card.provider_state.detail}</div>
                        </div>
                      </div>
                    </article>
                  )}
                </For>
              </div>

              <div class="wc-panel">
                <div class="wc-panel__title">
                  Cross-wallet comparison <span class="sub">Main vs MM vs Backup</span>
                </div>
                <table class="wc-table">
                  <thead>
                    <tr>
                      <th scope="col">Wallet</th>
                      <th scope="col" class="num">
                        5h left
                      </th>
                      <th scope="col" class="num">
                        Weekly left
                      </th>
                      <th scope="col" class="num">
                        In flight
                      </th>
                      <th scope="col" class="num">
                        Reset
                      </th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={data().cards}>
                      {(card) => (
                        <tr>
                          <th scope="row" style="font-weight:600;text-align:left">
                            <WalletChip tone={card.name.toLowerCase()}>{card.name}</WalletChip>
                          </th>
                          <td class="num">{card.window.pct_left}%</td>
                          <td class="num">{card.weekly.pct_left}%</td>
                          <td class="num">
                            {card.in_flight} / {card.ceiling}
                          </td>
                          <td class="num">{card.window.resets_label}</td>
                          <td>
                            <Pill tone={card.state.tone}>{card.state.label}</Pill>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <p class="wc-note">
                  Read left to right: the wallet with the <b>most weekly headroom</b> is not the one
                  drawing. MAIN draws because it holds priority 1 — MM is the tightest line and is
                  being drained on purpose. The comparison answers <i>“where is the room left?”</i>,
                  not <i>“who is busy?”</i>.
                </p>
              </div>

              <div class="wc-split-2">
                <div>
                  <section class="wc-panel">
                    <div class="wc-panel__title">
                      Lane concurrency <span class="sub">who is in flight</span>
                    </div>
                    <For each={data().cards}>
                      {(card) => (
                        <Kv
                          k={`${card.name} in flight`}
                          v={`${card.in_flight} / ${card.ceiling}`}
                        />
                      )}
                    </For>
                    <Show when={data().lane_targets}>
                      {(targets) => <Kv k="Target band" v={targets().target_band} />}
                    </Show>
                    <p class="wc-note">
                      The <b>burn-meter gauge</b> on Daily progress reads these in-flight numbers
                      against quota headroom and proposes the lane count to hold. It is advisory — it
                      never moves a lane by itself.
                    </p>
                  </section>
                </div>

                <div>
                  <section class="wc-panel">
                    <div class="wc-panel__title">Provider state</div>
                    <For each={data().provider_state}>
                      {(row) => <Kv k={row.provider} v={row.value} />}
                    </For>
                  </section>

                  <section class="wc-panel">
                    <div class="wc-panel__title">Ask the crew</div>
                    <AskCrew
                      placeholder="e.g. hold MM at 7 lanes until the 5h reset"
                      onFile={async (message) => {
                        await askCrew(message);
                      }}
                    />
                    <p class="wc-note">
                      Files a needs-you card against this wallet and posts it to the crew lane.
                      Nothing here changes the live line until the crew answers.
                    </p>
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
