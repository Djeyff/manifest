import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import { Title } from '@solidjs/meta';
import { Callout, Kv, Pill, WalletChip } from '../components/wallet-console/Console';
import {
  PUBLIC_WALLET_ORDER,
  getPublicQuota,
  type PublicQuotaWallet,
} from '../services/api/public-quota';

/**
 * Public quota page (ret500-nodupe) — the always-served mirror of the owner
 * console's maths. NO login wall: parked wallets keep their rows, and a dead
 * provider poll degrades to a STALE badge over last-known values, never a
 * blank and never a 404. Owner order 2026-11-22: don't overcomplicate — one
 * progress bar per wallet, week left, used today, allowed today, pace.
 *
 * Loading is signal-based (not createResource): a failed fetch must render the
 * shell + an error callout, not throw out of the render tree.
 */

const REFRESH_MS = 30_000;

type PaceTone = 'fast' | 'slow' | 'on-pace' | 'unknown';

function paceKey(pace: PublicQuotaWallet['pace']): PaceTone {
  if (pace === 'FAST') return 'fast';
  if (pace === 'SLOW') return 'slow';
  if (pace === 'ON_PACE') return 'on-pace';
  return 'unknown';
}

function paceLabel(pace: PublicQuotaWallet['pace']): string {
  if (pace === 'FAST') return 'FAST';
  if (pace === 'SLOW') return 'SLOW';
  if (pace === 'ON_PACE') return 'ON PACE';
  return 'PACE UNKNOWN';
}

function pct(value: number | null): string {
  return value === null ? '--' : `${value.toFixed(1)}%`;
}

function fmtUtc(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--' : d.toUTCString();
}

export default function Quota() {
  const [feed, setFeed] = createSignal<Awaited<ReturnType<typeof getPublicQuota>> | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const load = async () => {
    try {
      const data = await getPublicQuota();
      setFeed(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  onMount(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  /** Bar fill: used-today vs allowed-today, clamped — the mnfs progress mirror. */
  const usedOf = (w: PublicQuotaWallet): number => {
    if (w.allowed_today_pct === null || w.allowed_today_pct <= 0) return 0;
    if (w.used_today_pct === null) return 0;
    return Math.max(0, Math.min(100, (w.used_today_pct / w.allowed_today_pct) * 100));
  };

  const formulaText = (w: PublicQuotaWallet): string | null => {
    const f = w.formula;
    if (f.base_pct === null || f.reserve_pct === null || f.rollover_pool_pct === null) return null;
    return `${f.base_pct.toFixed(1)}% base + ${f.reserve_pct.toFixed(1)}% reserve + ${f.rollover_pool_pct.toFixed(
      1,
    )}% rollover = ${pct(f.allowed_today_pct)} allowed today`;
  };

  return (
    <>
      <Title>Quota · Manifest</Title>
      <div class="wc-page-header pq-page">
        <div>
          <h1>Quota</h1>
          <div class="wc-breadcrumb">
            Always served · wallets MAIN / MM / BACKUP · parked wallets stay visible
          </div>
        </div>
        <div class="wc-header-controls">
          <Show when={feed()?.stale === true}>
            <span class="wc-pill wc-pill--warn" role="status">
              <span class="wc-pill__dot" aria-hidden="true" />
              STALE
            </span>
          </Show>
          <span class="wc-note pq-tick">
            <Show when={feed()?.tick_at} fallback="governor tick: not published">
              governor tick {fmtUtc(feed()!.tick_at)}
            </Show>
          </span>
        </div>
      </div>

      <main class="pq-page" aria-label="Quota status">
        <Show when={error()}>
          <Callout tone="danger">
            The quota feed could not be read ({error()}). The page keeps the last known values — the
            backend serves last-known numbers with a STALE badge on a failed poll; this row is the
            retry notice.
          </Callout>
        </Show>

        <Show
          when={feed()}
          fallback={
            <div class="wc-state" role="status">
              Loading quota…
            </div>
          }
        >
          {(data) => (
            <>
              <Show when={data().ration_available === false}>
                <Callout tone="warn">
                  No governor state is published (
                  {data().ration_unavailable_reason ?? 'unavailable'}) — last-known numbers are
                  shown where the day maths is missing.
                </Callout>
              </Show>

              <For each={PUBLIC_WALLET_ORDER.map((name) => data().wallets[name]).filter(Boolean)}>
                {(wallet) => (
                  <section
                    class="wc-progress-block"
                    data-wallet={wallet.name}
                    aria-label={`${wallet.display_name} quota`}
                  >
                    <div class="wc-progress-block__head">
                      <div>
                        <div class="wc-lb-card__name">
                          <WalletChip tone={wallet.color ?? 'indigo'}>
                            {wallet.display_name}
                          </WalletChip>
                        </div>
                        <div class="wc-note pq-source">{wallet.source.replace(/-/g, ' ')}</div>
                      </div>
                      <div class="wc-progress-block__badges">
                        <Show when={wallet.parked}>
                          <Pill tone="drain">PARKED</Pill>
                        </Show>
                        <Show when={wallet.stale}>
                          <Pill tone="warn">STALE</Pill>
                        </Show>
                        <span class={`wc-pace wc-pace--${paceKey(wallet.pace)}`}>
                          {paceLabel(wallet.pace)}
                        </span>
                      </div>
                    </div>

                    <div class="wc-meter-block">
                      <div class="wc-meter-row">
                        <span class="wc-meter-row__label">Today used vs allowed today</span>
                        <span class="wc-meter-row__value">
                          {pct(wallet.used_today_pct)} of {pct(wallet.allowed_today_pct)}
                        </span>
                      </div>
                      <Show when={formulaText(wallet)}>
                        {(text) => <div class="pq-formula">{text()}</div>}
                      </Show>
                      <div
                        class={`wc-meter${paceKey(wallet.pace) === 'fast' ? ' wc-meter--warn' : ''}`}
                        style={{ '--wc-meter-value': `${usedOf(wallet)}%` }}
                        role="img"
                        aria-label={`${wallet.display_name}: ${pct(wallet.used_today_pct)} used of ${pct(
                          wallet.allowed_today_pct,
                        )} allowed today, ${pct(wallet.weekly_pct_left)} of the week left, pace ${paceLabel(
                          wallet.pace,
                        )}${wallet.parked ? ', parked' : ''}.`}
                      >
                        <div class="wc-meter__fill" />
                      </div>
                      <div class="wc-legend">
                        <span class="wc-legend__item">
                          week left <b>{pct(wallet.weekly_pct_left)}</b>
                        </span>
                        <span class="wc-legend__item">
                          used today <b>{pct(wallet.used_today_pct)}</b>
                        </span>
                        <span class="wc-legend__item">
                          allowed today <b>{pct(wallet.allowed_today_pct)}</b>
                        </span>
                      </div>
                    </div>

                    <div class="pq-split">
                      <section class="wc-panel">
                        <div class="wc-panel__title">
                          Pace <span class="sub">burn vs even spread to the next window</span>
                        </div>
                        <Kv k="Pace status" v={paceLabel(wallet.pace)} />
                        <Kv
                          k="Burn rate"
                          v={
                            wallet.pace_pct_per_h === null
                              ? 'not published'
                              : `${wallet.pace_pct_per_h.toFixed(2)}% / h`
                          }
                        />
                        <Kv k="Projection" v={wallet.projection ?? 'not published'} />
                        <Kv
                          k="Week left"
                          v={
                            wallet.weekly_spent_pct === null
                              ? pct(wallet.weekly_pct_left)
                              : `${pct(wallet.weekly_pct_left)} (${wallet.weekly_spent_pct.toFixed(1)}% spent)`
                          }
                        />
                      </section>
                      <section class="wc-panel">
                        <div class="wc-panel__title">
                          Windows <span class="sub">provider-own resets</span>
                        </div>
                        <Kv k="5h left" v={pct(wallet.five_h_pct_left)} />
                        <Kv k="5h resets" v={fmtUtc(wallet.five_h_reset_at)} />
                        <Kv k="Week resets" v={fmtUtc(wallet.weekly_reset_at)} />
                        <Kv k="Read at" v={fmtUtc(wallet.polled_at)} />
                      </section>
                    </div>

                    <Show when={wallet.note}>
                      <Callout tone="warn">{wallet.note}</Callout>
                    </Show>
                  </section>
                )}
              </For>
            </>
          )}
        </Show>
      </main>
    </>
  );
}
