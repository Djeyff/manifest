import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { decryptWithAny, getDecryptionSecrets } from '../../common/utils/crypto.util';
import { isZaiProviderId } from '../zai-region';
import {
  ZAI_MONITOR_BASE_DEFAULT,
  ZAI_MONITOR_QUOTA_PATH,
  ZaiQuotaLabelSnapshot,
  ZaiQuotaSnapshot,
  emptyLabelSnapshot,
  parseZaiQuotaLimitPayload,
} from './zai-quota-monitor';

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

/**
 * Live Z.AI coding-plan quota poller (RET-595).
 *
 * Every cycle it reads the active `zai` subscription connections (the only
 * place the plan keys exist — encrypted at rest), asks the Z.AI monitor
 * endpoint for each key's rolling 5-hour/weekly gauges, and exposes the
 * per-label snapshots at `GET /api/v1/zai-quota`. The admission proxy mirrors
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
  private readonly cooldownUntil = new Map<string, number>();
  private readonly fetchImpl?: FetchJsonImpl;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private destroyed = false;
  private repoWarned = false;

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    fetchImpl?: FetchJsonImpl,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.pollMs = clampPollMs(env['ZAI_QUOTA_POLL_SEC']);
    this.timeoutMs = clampTimeoutMs(env['ZAI_QUOTA_TIMEOUT_MS']);
    const configuredBase = (env['ZAI_QUOTA_MONITOR_BASE'] ?? '').replace(/\/+$/, '');
    this.monitorBase = configuredBase !== '' ? configuredBase : ZAI_MONITOR_BASE_DEFAULT;
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
        labels[label] = this.state.labels[label] ?? emptyLabelSnapshot(label);
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
    let bearerKey: string;
    try {
      bearerKey = decryptWithAny(
        connection.apiKeyEncrypted,
        getDecryptionSecrets(),
      ).plaintext;
    } catch {
      snapshot.error = 'key_decrypt_failed';
      carryForward(previous, snapshot);
      this.state.poll_errors += 1;
      return snapshot;
    }
    let response: { status: number; body: unknown };
    try {
      response = await (this.fetchImpl
        ? this.fetchImpl(this.monitorUrl(), bearerKey, this.timeoutMs)
        : this.fetchJson(this.monitorUrl(), bearerKey, this.timeoutMs));
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
    const parsed = parseZaiQuotaLimitPayload(response.body);
    snapshot.five_h_pct_left = parsed.five_h_pct_left;
    snapshot.weekly_pct_left = parsed.weekly_pct_left;
    snapshot.five_h_reset_at = parsed.five_h_reset_at;
    snapshot.weekly_reset_at = parsed.weekly_reset_at;
    snapshot.plan_level = parsed.plan_level;
    snapshot.subscription_status = parsed.subscription_status;
    snapshot.seen_at = nowIso;
    snapshot.error = null;
    return snapshot;
  }

  private monitorUrl(): string {
    return `${this.monitorBase}${ZAI_MONITOR_QUOTA_PATH}`;
  }

  private async loadConnections(): Promise<{ rows: ZaiSubscriptionConnection[]; failed: boolean }> {
    try {
      const found = await this.providerRepo.find({ where: { is_active: true } });
      const connections = found
        .filter(
          (row) =>
            row.is_active === true &&
            isZaiProviderId(String(row.provider)) &&
            row.auth_type === 'subscription' &&
            typeof row.api_key_encrypted === 'string' &&
            row.api_key_encrypted.length > 0,
        )
        .map((row) => ({
          label: (row.label ?? '').trim(),
          apiKeyEncrypted: row.api_key_encrypted as string,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
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
interface ZaiSubscriptionConnection {
  label: string;
  apiKeyEncrypted: string;
}

/**
 * Carry last-known readings forward onto an errored snapshot, so consumers
 * keep a stale-but-labeled gauge (with the error class + old seen_at saying
 * exactly how stale) instead of losing a working reading to one bad poll.
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
