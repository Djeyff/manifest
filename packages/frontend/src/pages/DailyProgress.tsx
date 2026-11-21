import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { Title } from '@solidjs/meta';
import {
  askCrew,
  getDailyProgress,
  getWalletConsoleAccess,
  type ProgressBlock,
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
 * Daily progress (RET-721, mockup 3/3 — DARK).
 *
 * The arithmetic is the interface: every bar shows used against allowed, and
 * allowed is always spelled out as base + rollover + reserve − floor. The
 * vertical marker is where the day is projected to land at reset.
 */

const REFRESH_MS = 30_000;

/** Gauge arc geometry (matches the mockup: r=45 on a 108px circle). */
const ARC_CIRCUMFERENCE = 2 * Math.PI * 45;

function paceLabel(pace: ProgressBlock['pace']): string {
  if (pace === 'ahead') return 'ahead';
  if (pace === 'behind') return 'behind';
  return 'on pace';
}

export default function DailyProgress() {
  const [access] = createResource(getWalletConsoleAccess);
  const [progress, { refetch }] = createResource(
    () => access()?.owner === true,
    async () => getDailyProgress(),
  );
  const [walletFilter, setWalletFilter] = createSignal<string>('all');
  const [error, setError] = createSignal<string | null>(null);

  const refresh = async () => {
    try {
      await refetch();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh progress.');
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

  const visibleBlocks = () => {
    const all = progress()?.blocks ?? [];
    const filter = walletFilter();
    return filter === 'all' ? all : all.filter((b) => b.name === filter);
  };

  return (
    <>
      <Title>Daily progress · Manifest</Title>
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
            <h1>Daily progress</h1>
            <div class="wc-breadcrumb">Wallets / today used vs today allowed</div>
          </div>
          <div class="wc-header-controls">
            <Show when={progress()?.demo}>
              <span class="wc-demo-note">demo data · live API not deployed yet</span>
            </Show>
            <div class="wc-wallet-tabs" role="tablist" aria-label="Filter by wallet">
              <button
                class={`wc-wallet-tab${walletFilter() === 'all' ? ' wc-wallet-tab--active' : ''}`}
                role="tab"
                aria-selected={walletFilter() === 'all'}
                type="button"
                onClick={() => setWalletFilter('all')}
              >
                All
              </button>
              <For each={progress()?.blocks ?? []}>
                {(block) => (
                  <button
                    class={`wc-wallet-tab${walletFilter() === block.name ? ' wc-wallet-tab--active' : ''}`}
                    role="tab"
                    aria-selected={walletFilter() === block.name}
                    type="button"
                    onClick={() => setWalletFilter(block.name)}
                  >
                    {block.name}
                  </button>
                )}
              </For>
            </div>
            <button class="btn btn--outline" type="button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </div>

        <Show when={error()}>
          <Callout tone="danger">{error()!}</Callout>
        </Show>

        <Show
          when={progress()}
          fallback={
            <div class="wc-state" role="status">
              Loading daily progress…
            </div>
          }
        >
          {(data) => (
            <>
              <Callout>
                <b>The arithmetic is the interface.</b> Every bar shows <i>used</i> against{' '}
                <i>allowed</i>, and <i>allowed</i> is always spelled out as base + rollover + reserve −
                floor — never a bare percentage, never a number the owner has to trust. The vertical
                marker is where the day is projected to land at reset.
              </Callout>

              <For each={visibleBlocks()}>
                {(block) => {
                  const used = () => block.used_pct;
                  const allow = () => block.still_allowed_pct;
                  const floor = () => block.floor_pct;
                  const unused = () =>
                    Math.max(0, 100 - used() - allow() - floor());
                  return (
                    <div class="wc-progress-block">
                      <div class="wc-progress-block__head">
                        <div>
                          <div class="wc-lb-card__name">
                            <WalletChip tone={block.color}>
                              {block.name} · {block.provider}
                            </WalletChip>
                          </div>
                          <div class="wc-note" style="margin-top:4px">
                            Today · {block.resets_label} · {block.reset_hint}
                          </div>
                        </div>
                        <div class="wc-progress-block__badges">
                          <span class={`wc-pace wc-pace--${block.pace}`}>
                            {paceLabel(block.pace)}
                          </span>
                          <For each={block.badges}>
                            {(badge) => <Pill tone="drain">{badge}</Pill>}
                          </For>
                        </div>
                      </div>

                      <div class="wc-meter-block">
                        <div class="wc-meter-row">
                          <span class="wc-meter-row__label">Today used vs today allowed</span>
                          <span class="wc-meter-row__value">
                            {used().toFixed(1)}% of {block.allowed_pct.toFixed(1)}%
                            <small>{allow().toFixed(1)}% of the line still allowed</small>
                          </span>
                        </div>
                        <div
                          class="wc-stack-bar"
                          role="img"
                          aria-label={`${block.name}: ${used().toFixed(1)} percent used of ${block.allowed_pct.toFixed(1)} percent allowed; projected to land at ${block.projected_pct.toFixed(1)} percent at reset, which is ${paceLabel(block.pace)}.`}
                        >
                          <div class="wc-stack-bar__seg wc-stack-bar__seg--used" style={`width:${used()}%`} />
                          <div
                            class="wc-stack-bar__seg wc-stack-bar__seg--allow"
                            style={`width:${allow()}%`}
                          />
                          <div
                            class="wc-stack-bar__seg wc-stack-bar__seg--floor"
                            style={`width:${floor()}%`}
                          />
                          <div
                            class="wc-stack-bar__seg wc-stack-bar__seg--unused"
                            style={`width:${unused()}%`}
                          />
                          <span
                            class="wc-stack-bar__mark"
                            style={`left:${block.projected_pct}%`}
                            data-label={`proj ${block.projected_pct.toFixed(1)}%`}
                          />
                        </div>
                        <div class="wc-legend">
                          <span class="wc-legend__item">
                            <span class="wc-legend__swatch wc-legend__swatch--used" />
                            used today ({used().toFixed(1)}%)
                          </span>
                          <span class="wc-legend__item">
                            <span class="wc-legend__swatch" style="background:hsl(var(--bar-output))" />
                            still allowed today ({allow().toFixed(1)}%)
                          </span>
                          <span class="wc-legend__item">
                            <span
                              class="wc-legend__swatch"
                              style="background:hsl(var(--warning) / 0.55)"
                            />
                            emergency floor ({floor().toFixed(1)}%) — locked
                          </span>
                          <span class="wc-legend__item">
                            <span class="wc-legend__mark" />
                            projection at reset ({block.projected_pct.toFixed(1)}%)
                          </span>
                        </div>
                      </div>

                      <div style="margin-top:16px">
                        <Formula
                          formula={block.formula}
                          used={block.used_pct}
                          projected={block.projected_pct}
                        />
                      </div>

                      <Show when={block.note}>
                        <Callout tone="warn">{block.note}</Callout>
                      </Show>
                    </div>
                  );
                }}
              </For>

              <div class="wc-split-2">
                <div>
                  <section class="wc-panel">
                    <div class="wc-panel__title">
                      Burn-meter gauge <span class="sub">lane concurrency vs quota headroom</span>
                    </div>
                    <div class="wc-burn-gauge">
                      <div
                        class="wc-gauge"
                        style={`--gauge-value:${data().burn.quota_headroom_pct}%`}
                        role="img"
                        aria-label={`Burn meter: recommended lane concurrency ${data().burn.recommended} of a target band of ${data().burn.target_band}, with ${data().burn.quota_headroom_pct} percent of quota headroom remaining.`}
                      >
                        <svg class="wc-gauge__svg" width="108" height="108" viewBox="0 0 108 108" aria-hidden="true">
                          <circle class="wc-gauge__track" cx="54" cy="54" r="45" />
                          <circle
                            class="wc-gauge__arc"
                            cx="54"
                            cy="54"
                            r="45"
                            stroke-dasharray={ARC_CIRCUMFERENCE.toFixed(1)}
                            stroke-dashoffset={(
                              ARC_CIRCUMFERENCE *
                              (1 - data().burn.quota_headroom_pct / 100)
                            ).toFixed(1)}
                          />
                        </svg>
                        <div class="wc-gauge__center">
                          <span class="wc-gauge__num">{data().burn.recommended}</span>
                          <span class="wc-gauge__cap">lanes / {data().burn.target_band}</span>
                        </div>
                      </div>
                      <div style="flex:1;min-width:0">
                        <Kv k="In flight now" v={data().burn.in_flight} />
                        <Kv k="Recommended now" v={data().burn.recommended} />
                        <Kv k="Quota headroom" v={`${data().burn.quota_headroom_pct}%`} />
                        <Kv k="Target band" v={`${data().burn.target_band} lanes`} />
                        <Kv k="Verdict" v={data().burn.verdict} />
                      </div>
                    </div>
                    <Callout tone="warn">
                      The gauge <b>proposes</b> the lane count — it never moves a lane by itself; the
                      crew (or the governor, once armed) applies.
                    </Callout>
                    <p class="wc-note">
                      When headroom is <b>above 90%</b> the gauge proposes the top of the band. Below{' '}
                      <b>60%</b> it proposes the floor of the band, never fewer, so a line never
                      starves.
                    </p>
                  </section>

                  <Show when={data().day_strip}>
                    {(strip) => (
                      <section class="wc-panel">
                        <div class="wc-panel__title">
                          14-day burn vs plan <span class="sub">MAIN · daily spend against daily allowance</span>
                        </div>
                        <div class="wc-day-strip">
                          <For each={strip()}>
                            {(day) => (
                              <div
                                class={`wc-day-strip__col${day.day === '21' ? ' wc-day-strip__col--today' : ''}`}
                              >
                                <div
                                  class={`wc-day-strip__bar${day.over ? ' wc-day-strip__bar--over' : ''}${day.drain ? ' wc-day-strip__bar--plan' : ''}`}
                                  style={`height:${day.pct}%`}
                                />
                                <span class="wc-day-strip__label">{day.day}</span>
                              </div>
                            )}
                          </For>
                        </div>
                        <div class="wc-legend">
                          <span class="wc-legend__item">
                            <span class="wc-legend__swatch wc-legend__swatch--used" />
                            under allowance
                          </span>
                          <span class="wc-legend__item">
                            <span class="wc-legend__swatch" style="background:hsl(var(--warning))" />
                            over allowance
                          </span>
                          <span class="wc-legend__item">
                            <span
                              class="wc-legend__swatch"
                              style="background:hsl(var(--bar-output-axis))"
                            />
                            drain day
                          </span>
                        </div>
                      </section>
                    )}
                  </Show>
                </div>

                <div>
                  <section class="wc-panel">
                    <div class="wc-panel__title">
                      Weekly burn vs plan <span class="sub">4 weeks · % of weekly allowance burned per day</span>
                    </div>
                    <div class="wc-heat-grid">
                      <span />
                      <span class="wc-heat-grid__head">Mon</span>
                      <span class="wc-heat-grid__head">Tue</span>
                      <span class="wc-heat-grid__head">Wed</span>
                      <span class="wc-heat-grid__head">Thu</span>
                      <span class="wc-heat-grid__head">Fri</span>
                      <span class="wc-heat-grid__head">Sat</span>
                      <span class="wc-heat-grid__head">Sun</span>
                      <For each={data().heatmap.weeks}>
                        {(week) => (
                          <>
                            <span class="wc-heat-grid__rowlabel">{week.label}</span>
                            <For each={week.cells}>
                              {(cell) => (
                                <span
                                  class={`wc-heat-cell wc-heat-cell--${cell.state}`}
                                  aria-label={
                                    cell.pct === null
                                      ? `${week.label}: not yet`
                                      : `${week.label}: ${cell.pct}% of weekly allowance burned`
                                  }
                                >
                                  {cell.pct === null ? '—' : `${cell.pct}%`}
                                </span>
                              )}
                            </For>
                          </>
                        )}
                      </For>
                    </div>
                    <div class="wc-heat-legend">
                      <span class="wc-heat-legend__item">
                        <span
                          class="wc-heat-legend__swatch"
                          style="background:hsl(var(--muted))"
                        />
                        under
                      </span>
                      <span class="wc-heat-legend__item">
                        <span
                          class="wc-heat-legend__swatch"
                          style="background:hsl(var(--success) / 0.24);border:1px solid hsl(var(--success) / 0.4)"
                        />
                        on plan
                      </span>
                      <span class="wc-heat-legend__item">
                        <span
                          class="wc-heat-legend__swatch"
                          style="background:hsl(var(--warning) / 0.24);border:1px solid hsl(var(--warning) / 0.45)"
                        />
                        over
                      </span>
                      <span class="wc-heat-legend__item">
                        <span
                          class="wc-heat-legend__swatch"
                          style="background:hsl(var(--destructive) / 0.24);border:1px solid hsl(var(--destructive) / 0.5)"
                        />
                        burn
                      </span>
                      <span class="wc-heat-legend__item">
                        <span
                          class="wc-heat-legend__swatch"
                          style="border:1px dashed hsl(var(--border))"
                        />
                        not yet
                      </span>
                    </div>
                    <Show when={data().heatmap.note}>
                      <p class="wc-note">{data().heatmap.note}</p>
                    </Show>
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
                      One tap files a needs-you card against this wallet and posts it to the crew lane.
                      Nothing here changes the live line until the crew answers.
                    </p>
                  </section>

                  <section class="wc-panel">
                    <div class="wc-panel__title">
                      Audit &amp; rulings <span class="sub">auto-minted</span>
                    </div>
                    <AuditTrail entries={data().audit ?? []} />
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
