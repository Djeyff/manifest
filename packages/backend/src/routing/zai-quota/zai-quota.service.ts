import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { decryptWithAny, getDecryptionSecrets } from '../../common/utils/crypto.util';
import { isZaiProviderId } from '../zai-region';
import {
  MINIMAX_QUOTA_SOURCE,
  ZAI_MONITOR_BASE_DEFAULT,
  ZAI_MONITOR_QUOTA_PATH,
  ZAI_QUOTA_SOURCE,
  ZaiQuotaLabelSnapshot,
  ZaiQuotaSnapshot,
  emptyLabelSnapshot,
  fiveHWindowParsed,
  parseZaiQuotaLimitPayload,
} from './zai-quota-monitor';
import {
  MINIMAX_QUOTA_BASE_DEFAULT,
  MINIMAX_QUOTA_PATH,
  parseMinimaxSubscriptionBlob,
  parseMinimaxTokenPlanRemainsPayload,
} from './minimax-quota-monitor';

/** Poll cadence: every 60s unless ZAI_QUOTA_POLL_SEC says otherwise. */
const DEFAULT_POLL_SEC = 60;
const MIN_POLL_SEC = 15;
const MAX_POLL_SEC = 600;
/** Per-request monitor timeout (the poll must never pile up behind a slow z.ai). */
const DEFAULT_TIMEOUT_MS = 10_000;
/** After a monitor 429, skip this label for a while — never storm the endpoint. */
const MONITOR_429_COOLDOWN_MS = 300_000;
/** First poll waits a beat after boot so the app finishes warming up first. */
const BOOT_DELAY_MS = 5_000;

/** tenant_providers.provider value of MiniMax M Plan subscription connections. */
const MINIMAX_PROVIDER_ID = 'minimax';

type FetchJsonImpl = (
  url: string,
  bearerKey: string,
  timeoutMs: number,
) => Promise<{ status: number; body: unknown }>;

function clampPollMs(envValue: string | undefined): number {
  const parsed = Number(envValue);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_SEC;
  const bounded = Math.min(MAX_POLL_SEC, Math.max(MIN_POLL_SEC, seconds));
  return Math.trunc(bounded * 1000);
}

function clampTimeoutMs(envValue: string | undefined): number {
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(1_000, Math.trunc(parsed)));
}

/** Feed provenance for one connection kind (RET-500-nodupe). */
function sourceForKind(kind: QuotaConnectionKind): string {
  return kind === 'minimax' ? MINIMAX_QUOTA_SOURCE : ZAI_QUOTA_SOURCE;
}

/**
 * Live Z.AI coding-plan quota poller (RET-595), extended additively in
 * RET-598-FU7-GW to also poll MiniMax M Plan subscription connections
 * (`provider = minimax`, labels like `RCR MM` / `CCR MM`) into the SAME
 * per-label snapshot — the zai filter, monitor URL, cadence and error
 * semantics are untouched, so existing rows stay byte-compatible.
 *
 * Every cycle it reads ALL subscription connections for the feed — z.ai and
 * MiniMax, active OR parked (RET-500-nodupe: `is_active` gates ROUTING, not
 * telemetry; a parked seat still owns quota truth the owner must see) — asks
 * the provider monitor endpoints for each key's rolling 5-hour/weekly gauges,
 * and exposes the per-label snapshots at `GET /api/v1/zai-quota`, every label
 * provenance-stamped (`source` + per-label `polled_at`, success or error).
 * The admission proxy mirrors
 * this route into its `/status` `quota_labels` contract so the owner widget
 * shows real percentages. Telemetry only: every failure path degrades to a
 * per-label error class and never breaks forwarding, and no key material is
 * ever logged or surfaced.
 */
@Injectable()
export class ZaiQuotaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ZaiQuotaService.name);
  private readonly state: ZaiQuotaSnapshot = { labels: {}, polled_at: null, polls: 0, poll_errors: 0 };
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly monitorBase: string;
  private readonly minimaxBase: string;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly fetchImpl?: FetchJsonImpl;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private destroyed = false;
  private repoWarned = false;

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    // Test seams: @Optional() so Nest DI injects undefined and the built-in
    // fetchJson / process.env fallbacks apply in production. Undecorated
    // optional params made Nest resolve them as providers and crash the whole
    // module boot (UnknownDependenciesException, RET-595 hotfix 2).
    @Optional()
    fetchImpl?: FetchJsonImpl,
    @Optional()
    env: Record<string, string | undefined> = process.env,
  ) {
    this.pollMs = clampPollMs(env['ZAI_QUOTA_POLL_SEC']);
    this.timeoutMs = clampTimeoutMs(env['ZAI_QUOTA_TIMEOUT_MS']);
    const configuredBase = (env['ZAI_QUOTA_MONITOR_BASE'] ?? '').replace(/\/+$/, '');
    this.monitorBase = configuredBase !== '' ? configuredBase : ZAI_MONITOR_BASE_DEFAULT;
    const configuredMinimaxBase = (env['MINIMAX_QUOTA_MONITOR_BASE'] ?? '').replace(/\/+$/, '');
    this.minimaxBase = configuredMinimaxBase !== '' ? configuredMinimaxBase : MINIMAX_QUOTA_BASE_DEFAULT;
    this.fetchImpl = fetchImpl;
  }

  /** Boot the poll loop; an unwired repository idles with a warn-once. */
  onModuleInit(): void {
    if (this.destroyed) return;
    if (!this.providerRepo) {
      if (!this.repoWarned) {
        this.repoWarned = true;
        this.logger.warn('zai-quota: no tenant-provider repository wired — poller idle');
      }
      return;
    }
    this.scheduleNext(BOOT_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Public read model (deep copy — callers must not hold live state). */
  snapshot(): ZaiQuotaSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as ZaiQuotaSnapshot;
  }

  /**
   * One poll cycle. Errors are per-label classes on the snapshot; a cycle
   * never throws. Single-flighted: overlapping invocations (slow tick inside
   * the next interval) collapse into the running one.
   */
  async tick(): Promise<void> {
    if (this.inFlight || this.destroyed) return;
    this.inFlight = true;
    try {
      await this.tickInner();
    } finally {
      this.inFlight = false;
    }
  }

  private async tickInner(): Promise<void> {
    const { rows, failed } = await this.loadConnections();
    if (failed) {
      // A DB hiccup must not wipe live readings: retain the last snapshot.
      this.state.polled_at = new Date().toISOString();
      this.state.polls += 1;
      return;
    }
    const labels: Record<string, ZaiQuotaLabelSnapshot> = {};
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    for (const connection of rows) {
      const label = connection.label;
      if (label === '') continue;
      const cooldownUntil = this.cooldownUntil.get(label) ?? 0;
      if (nowMs < cooldownUntil) {
        // Retain the last reading while the label cools down (429 protection).
        const retained = this.state.labels[label] ?? emptyLabelSnapshot(label);
        if (retained.source === null) retained.source = sourceForKind(connection.kind);
        labels[label] = retained;
        continue;
      }
      labels[label] = await this.pollLabel(connection, nowIso, this.state.labels[label]);
    }
    this.state.labels = labels;
    this.state.polled_at = nowIso;
    this.state.polls += 1;
  }

  private async pollLabel(
    connection: ZaiSubscriptionConnection,
    nowIso: string,
    previous?: ZaiQuotaLabelSnapshot,
  ): Promise<ZaiQuotaLabelSnapshot> {
    const snapshot = emptyLabelSnapshot(connection.label);
    // Provenance + attempt time are stamped before anything can fail, so even
    // an errored label answers "which feed, how recently tried" honestly
    // (RET-500-nodupe: never silently serve a stale anchor).
    snapshot.source = sourceForKind(connection.kind);
    snapshot.polled_at = nowIso;
    let bearerKey: string;
    let url: string;
    try {
      const plaintext = decryptWithAny(
        connection.apiKeyEncrypted,
        getDecryptionSecrets(),
      ).plaintext;
      if (connection.kind === 'minimax') {
        // MiniMax subscriptions store an OAuth blob `{t, r, e, u}`; the quota
        // endpoint wants the access token and answers at the blob's resource
        // origin (global region). A blob that no longer parses is a per-label
        // error, never a cycle failure and never a key leak.
        const blob = parseMinimaxSubscriptionBlob(plaintext);
        if (!blob) {
          snapshot.error = 'key_blob_invalid';
          carryForward(previous, snapshot);
          this.state.poll_errors += 1;
          return snapshot;
        }
        bearerKey = blob.accessToken;
        url = `${blob.resourceOrigin ?? this.minimaxBase}${MINIMAX_QUOTA_PATH}`;
      } else {
        bearerKey = plaintext;
        url = this.monitorUrl();
      }
    } catch {
      snapshot.error = 'key_decrypt_failed';
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    let response: { status: number; body: unknown };
    try {
      response = await (this.fetchImpl
        ? this.fetchImpl(url, bearerKey, this.timeoutMs)
        : this.fetchJson(url, bearerKey, this.timeoutMs));
    } catch (error) {
      snapshot.error = error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network_error';
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    if (response.status === 429) {
      this.cooldownUntil.set(connection.label, Date.now() + MONITOR_429_COOLDOWN_MS);
      snapshot.error = 'http_429';
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    if (response.status < 200 || response.status >= 300) {
      snapshot.error = `http_${response.status}`;
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    if (response.body === null || response.body === undefined) {
      // 200 but no parseable JSON: a shape failure, not a healthy empty poll.
      snapshot.error = 'bad_json';
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    if (connection.kind === 'minimax') {
      // RET-598-FU7-GW: MiniMax M Plan rows ride the same feed shape — the
      // documented `/v1/token_plan/remains` payload maps its 5-hour interval
      // (`current_interval_remaining_percent` + `end_time`) and weekly window
      // (`current_weekly_remaining_percent` + `weekly_end_time`) straight onto
      // the zai gauges. A non-zero `base_resp.status_code` (e.g. 2049 invalid
      // api key) is a per-label error, never a cycle failure.
      const parsed = parseMinimaxTokenPlanRemainsPayload(response.body);
      if (parsed.plan_status_code !== null && parsed.plan_status_code !== 0) {
        snapshot.error = `minimax_status_${parsed.plan_status_code}`;
        carryForward(previous, snapshot);
        this.state.poll_errors += 1;
        return snapshot;
      }
      snapshot.five_h_pct_left = parsed.five_h_pct_left;
      snapshot.weekly_pct_left = parsed.weekly_pct_left;
      snapshot.five_h_reset_at = parsed.five_h_reset_at;
      snapshot.weekly_reset_at = parsed.weekly_reset_at;
      snapshot.plan_level = parsed.plan_level;
      snapshot.subscription_status = parsed.subscription_status;
      if (!fiveHWindowParsed(parsed)) {
        // 200 + ok envelope but no usable 5-hour window in the payload:
        // provider shape drift. Keep the previous readings visible but say
        // so — never a silent anchor (RET-500-nodupe).
        snapshot.error = 'parse_failed_5h';
        carryForward(previous, snapshot);
        this.state.poll_errors += 1;
        return snapshot;
      }
      snapshot.seen_at = nowIso;
      snapshot.error = null;
      return snapshot;
    }
    const parsed = parseZaiQuotaLimitPayload(response.body);
    snapshot.five_h_pct_left = parsed.five_h_pct_left;
    snapshot.weekly_pct_left = parsed.weekly_pct_left;
    snapshot.five_h_reset_at = parsed.five_h_reset_at;
    snapshot.weekly_reset_at = parsed.weekly_reset_at;
    snapshot.plan_level = parsed.plan_level;
    snapshot.subscription_status = parsed.subscription_status;
    if (!fiveHWindowParsed(parsed) && parsed.subscription_status !== 'inactive_or_free') {
      // 200 + success envelope but the 5-hour window is gone from the
      // payload: shape drift -> labeled failure, previous readings carried
      // forward. (`inactive_or_free` is the healthy unfunded-key answer —
      // null gauges there are truth, not a parse failure.)
      snapshot.error = 'parse_failed_5h';
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    snapshot.seen_at = nowIso;
    snapshot.error = null;
    return snapshot;
  }

  private monitorUrl(): string {
    return `${this.monitorBase}${ZAI_MONITOR_QUOTA_PATH}`;
  }

  private async loadConnections(): Promise<{ rows: ZaiSubscriptionConnection[]; failed: boolean }> {
    try {
      // RET-500-nodupe: poll every subscription row REGARDLESS of is_active —
      // a parked/inactive seat still owns quota the owner must see; is_active
      // governs ROUTING, not telemetry. Without this, parking a key silently
      // removes its label (and its live 5h/weekly truth) from the feed.
      const found = await this.providerRepo.find({ where: { auth_type: 'subscription' } });
      const subscriptionKeyPresent = (row: (typeof found)[number]): boolean =>
        row.auth_type === 'subscription' &&
        typeof row.api_key_encrypted === 'string' &&
        row.api_key_encrypted.length > 0;
      const zai = found
        .filter((row) => subscriptionKeyPresent(row) && isZaiProviderId(String(row.provider)))
        .map((row) => ({
          label: (row.label ?? '').trim(),
          apiKeyEncrypted: row.api_key_encrypted as string,
          kind: 'zai' as const,
        }));
      // RET-598-FU7-GW: MiniMax M Plan keys (labels like `RCR MM` / `CCR MM`)
      // ride the SAME snapshot and feed contract — additive rows only, the
      // zai filter above is untouched so existing labels stay byte-compatible.
      const minimax = found
        .filter(
          (row) => subscriptionKeyPresent(row) && String(row.provider) === MINIMAX_PROVIDER_ID,
        )
        .map((row) => ({
          label: (row.label ?? '').trim(),
          apiKeyEncrypted: row.api_key_encrypted as string,
          kind: 'minimax' as const,
        }));
      const connections = [...zai, ...minimax]
        .filter((connection) => connection.label !== '')
        .sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
      this.repoWarned = false;
      return { rows: connections, failed: false };
    } catch (error) {
      // A DB hiccup must not look like "no connections exist".
      if (!this.repoWarned) {
        this.repoWarned = true;
        this.logger.warn(`zai-quota: connection read failed, retaining last snapshot: ${error}`);
      }
      this.state.poll_errors += 1;
      return { rows: [], failed: true };
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.destroyed) return;
    this.timer = setTimeout(() => {
      void this.runCycle();
    }, delayMs);
    // A pending poll must never hold the process open.
    this.timer.unref?.();
  }

  private async runCycle(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.warn(`zai-quota: cycle failed: ${error}`);
    }
    this.scheduleNext(this.pollMs);
  }

  /**
   * One monitor call. Bounded by an abort timeout; the bearer key rides the
   * Authorization header only — never in logs, never in error text.
   */
  protected async fetchJson(
    url: string,
    bearerKey: string,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }
}

/** Minimal connection view the poller needs (keeps specs honest and small). */
type QuotaConnectionKind = 'zai' | 'minimax';

interface ZaiSubscriptionConnection {
  label: string;
  apiKeyEncrypted: string;
  kind: QuotaConnectionKind;
}

/**
 * Carry last-known readings forward onto an errored snapshot, so consumers
 * keep a stale-but-labeled gauge (with the error class + old seen_at saying
 * exactly how stale) instead of losing a working reading to one bad poll.
 * `source`/`polled_at` are stamped by the caller BEFORE this runs, so they
 * always describe the fresh attempt, not the stale reading (RET-500-nodupe).
 */
function carryForward(
  previous: ZaiQuotaLabelSnapshot | undefined,
  errored: ZaiQuotaLabelSnapshot,
): void {
  if (!previous || previous.seen_at === null) return;
  errored.five_h_pct_left = previous.five_h_pct_left;
  errored.weekly_pct_left = previous.weekly_pct_left;
  errored.five_h_reset_at = previous.five_h_reset_at;
  errored.weekly_reset_at = previous.weekly_reset_at;
  errored.plan_level = previous.plan_level;
  errored.subscription_status = previous.subscription_status;
  errored.seen_at = previous.seen_at;
}
