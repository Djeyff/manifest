import 'reflect-metadata';
import { Repository } from 'typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { encrypt } from '../../common/utils/crypto.util';
import { ZaiQuotaService } from './zai-quota.service';

/**
 * MiniMax M Plan rows on the shared quota feed (RET-598-FU7-GW).
 * The zai-side behaviors live in zai-quota.service.spec.ts, untouched —
 * this spec pins the ADDITIVE minimax branch only.
 */

const TEST_SECRET = 'ret598-test-secret-0123456789abcdef'; // exactly 32 chars
const MONITOR_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
const MINIMAX_URL = 'https://api.minimax.io/v1/token_plan/remains';

const ZAI_OK_BODY = {
  success: true,
  data: {
    level: 'lite',
    limits: [
      { unit: 3, number: 5, percentage: 40, nextResetTime: 1799990400000 },
      { unit: 6, number: 1, percentage: 10, nextResetTime: 1800595200000 },
    ],
  },
};

/** Live payload shape captured from the crew's own keys (2026-11-12). */
const MINIMAX_OK_BODY = {
  model_remains: [
    {
      start_time: 1794479705026,
      end_time: 1794497705026,
      remains_time: 6925134,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: 'general',
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1794261570826,
      weekly_end_time: 1794866370826,
      weekly_remains_time: 375590934,
      current_interval_status: 2,
      current_interval_remaining_percent: 0,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 58,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

function minimaxBlobText(t = 'sk-cp-test-key'): string {
  return JSON.stringify({ t, r: 'rt-test', e: 4102444800000, u: 'https://api.minimax.io/anthropic/v1' });
}

interface FetchCall {
  url: string;
  bearerKey: string;
}

function makeRepo(rows: Partial<TenantProvider>[]): Repository<TenantProvider> {
  return { find: async () => rows } as unknown as Repository<TenantProvider>;
}

function zaiRow(overrides: Partial<TenantProvider> = {}): Partial<TenantProvider> {
  return {
    provider: 'zai',
    auth_type: 'subscription',
    label: 'RCR',
    api_key_encrypted: encrypt('test-key-rcr', TEST_SECRET),
    is_active: true,
    ...overrides,
  };
}

function minimaxRow(overrides: Partial<TenantProvider> = {}): Partial<TenantProvider> {
  return {
    provider: 'minimax',
    auth_type: 'subscription',
    label: 'RCR MM',
    api_key_encrypted: encrypt(minimaxBlobText(), TEST_SECRET),
    is_active: true,
    ...overrides,
  };
}

/** Route the seam by URL: zai monitor vs minimax token-plan endpoint. */
function routingFetchImpl(
  zai: { status: number; body: unknown } | Error,
  minimax: { status: number; body: unknown } | Error,
): { calls: FetchCall[]; impl: (url: string, bearer: string) => Promise<{ status: number; body: unknown }> } {
  const calls: FetchCall[] = [];
  const impl = async (url: string, bearerKey: string) => {
    calls.push({ url, bearerKey });
    const chosen = url === MONITOR_URL ? zai : minimax;
    if (chosen instanceof Error) throw chosen;
    return chosen;
  };
  return { calls, impl };
}

describe('ZaiQuotaService minimax rows (RET-598-FU7-GW)', () => {
  beforeAll(() => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = TEST_SECRET;
  });
  afterAll(() => {
    delete process.env['MANIFEST_ENCRYPTION_KEY'];
  });

  it('polls minimax subscription connections into the same snapshot as zai seats', async () => {
    const { calls, impl } = routingFetchImpl(
      { status: 200, body: ZAI_OK_BODY },
      { status: 200, body: MINIMAX_OK_BODY },
    );
    const svc = new ZaiQuotaService(
      makeRepo([
        zaiRow(),
        minimaxRow(),
        // A minimax row with an API-key auth type is NOT a subscription: never polled.
        minimaxRow({ label: 'OLD MM', auth_type: 'api_key' }),
      ]),
      impl,
    );
    await svc.tick();
    const snap = svc.snapshot();
    expect(Object.keys(snap.labels).sort()).toEqual(['RCR', 'RCR MM']);
    const mm = snap.labels['RCR MM'];
    expect(mm.five_h_pct_left).toBe(0);
    expect(mm.weekly_pct_left).toBe(58);
    expect(mm.five_h_reset_at).toBe(new Date(1794497705026).toISOString());
    expect(mm.weekly_reset_at).toBe(new Date(1794866370826).toISOString());
    expect(mm.plan_level).toBeNull();
    expect(mm.subscription_status).toBe('active');
    expect(mm.error).toBeNull();
    expect(mm.seen_at).not.toBeNull();
    // Zai seat still reads through the zai monitor shape.
    expect(snap.labels['RCR'].five_h_pct_left).toBe(60);
    expect(snap.labels['RCR'].plan_level).toBe('lite');
    // Exactly two monitor calls: one per live connection, each to its own endpoint.
    expect(calls).toHaveLength(2);
    const mmCall = calls.find((call) => call.url === MINIMAX_URL);
    expect(mmCall?.bearerKey).toBe('sk-cp-test-key');
    expect(calls.find((call) => call.url === MONITOR_URL)?.bearerKey).toBe('test-key-rcr');
    expect(snap.poll_errors).toBe(0);
    expect(snap.polls).toBe(1);
    // Key material never reaches the feed.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('sk-cp-test-key');
    expect(serialized).not.toContain(minimaxBlobText());
  });

  it('classifies a rejected minimax key per label without failing the cycle', async () => {
    const { impl } = routingFetchImpl(
      { status: 200, body: ZAI_OK_BODY },
      { status: 200, body: { base_resp: { status_code: 2049, status_msg: 'invalid api key' } } },
    );
    const svc = new ZaiQuotaService(makeRepo([zaiRow(), minimaxRow()]), impl);
    await svc.tick();
    const snap = svc.snapshot();
    expect(snap.labels['RCR MM'].error).toBe('minimax_status_2049');
    expect(snap.labels['RCR MM'].five_h_pct_left).toBeNull();
    expect(snap.labels['RCR MM'].subscription_status).toBeNull();
    expect(snap.labels['RCR'].error).toBeNull();
    expect(snap.poll_errors).toBe(1);
    expect(snap.polled_at).not.toBeNull();
  });

  it('maps the blob resource origin onto the monitor URL and falls back to the default base', async () => {
    const calls: FetchCall[] = [];
    const impl = async (url: string, bearerKey: string) => {
      calls.push({ url, bearerKey });
      return { status: 200, body: MINIMAX_OK_BODY };
    };
    const cnBlob = JSON.stringify({ t: 'sk-cn', r: 'rt', e: 4102444800000, u: 'https://api.minimaxi.com/anthropic/v1' });
    const noBlob = JSON.stringify({ t: 'sk-plain', r: 'rt', e: 4102444800000 });
    const svc = new ZaiQuotaService(
      makeRepo([
        minimaxRow({ label: 'CN MM', api_key_encrypted: encrypt(cnBlob, TEST_SECRET) }),
        minimaxRow({ label: 'Plain MM', api_key_encrypted: encrypt(noBlob, TEST_SECRET) }),
      ]),
      impl,
    );
    await svc.tick();
    const urls = calls.map((call) => call.url).sort();
    expect(urls).toEqual([
      'https://api.minimax.io/v1/token_plan/remains', // no blob URL -> default base
      'https://api.minimaxi.com/v1/token_plan/remains', // blob origin honored
    ]);
    expect(svc.snapshot().labels['Plain MM'].subscription_status).toBe('active');
  });

  it('marks an unusable stored blob as key_blob_invalid per label', async () => {
    const { impl } = routingFetchImpl(
      { status: 200, body: ZAI_OK_BODY },
      { status: 200, body: MINIMAX_OK_BODY },
    );
    const svc = new ZaiQuotaService(
      makeRepo([
        minimaxRow({ label: 'BROKEN MM', api_key_encrypted: encrypt('"just-a-string"', TEST_SECRET) }),
        minimaxRow(),
      ]),
      impl,
    );
    await svc.tick();
    const snap = svc.snapshot();
    expect(snap.labels['BROKEN MM'].error).toBe('key_blob_invalid');
    expect(snap.labels['RCR MM'].error).toBeNull();
    expect(snap.poll_errors).toBe(1);
  });

  it('cools a 429ing minimax label down without storming the endpoint', async () => {
    let minimaxStatus = 429;
    const calls: FetchCall[] = [];
    const impl = async (url: string, bearerKey: string) => {
      calls.push({ url, bearerKey });
      if (url === MINIMAX_URL) return { status: minimaxStatus, body: MINIMAX_OK_BODY };
      return { status: 200, body: ZAI_OK_BODY };
    };
    const svc = new ZaiQuotaService(makeRepo([minimaxRow(), zaiRow({ label: 'CCR', api_key_encrypted: encrypt('test-key-ccr', TEST_SECRET) })]), impl);
    await svc.tick();
    expect(svc.snapshot().labels['RCR MM'].error).toBe('http_429');
    minimaxStatus = 200;
    await svc.tick(); // inside the 5-minute cooldown window
    const mmCalls = calls.filter((call) => call.url === MINIMAX_URL);
    expect(mmCalls).toHaveLength(1); // cooled-down label kept its last snapshot instead
    expect(svc.snapshot().labels['RCR MM'].error).toBe('http_429');
    expect(svc.snapshot().labels['CCR'].error).toBeNull(); // other labels keep polling
  });

  it('stamps minimax provenance and marks a window-less 200 as parse_failed_5h', async () => {
    const { impl } = routingFetchImpl(
      { status: 200, body: ZAI_OK_BODY },
      // 200 + ok envelope but the row carries no window fields: shape drift.
      {
        status: 200,
        body: {
          model_remains: [{ model_name: 'general' }],
          base_resp: { status_code: 0, status_msg: 'success' },
        },
      },
    );
    const svc = new ZaiQuotaService(makeRepo([zaiRow(), minimaxRow()]), impl);
    await svc.tick();
    const snap = svc.snapshot();
    expect(snap.labels['RCR MM'].source).toBe('minimax-token-plan');
    expect(snap.labels['RCR MM'].polled_at).not.toBeNull();
    expect(snap.labels['RCR MM'].error).toBe('parse_failed_5h');
    expect(snap.labels['RCR MM'].five_h_pct_left).toBeNull();
    expect(snap.labels['RCR'].source).toBe('zai-coding-plan');
    expect(snap.poll_errors).toBe(1);
  });
});
