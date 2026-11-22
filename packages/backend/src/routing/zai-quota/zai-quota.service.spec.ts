import 'reflect-metadata';
import { Repository } from 'typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { encrypt } from '../../common/utils/crypto.util';
import { ZaiQuotaService } from './zai-quota.service';

const TEST_SECRET = 'ret595-test-secret-0123456789abcdef'; // exactly 32 chars
const MONITOR_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

const OK_BODY = {
  success: true,
  data: {
    level: 'lite',
    limits: [
      { unit: 3, number: 5, percentage: 40, nextResetTime: 1799990400000 },
      { unit: 6, number: 1, percentage: 10, nextResetTime: 1800595200000 },
    ],
  },
};

interface FetchCall {
  url: string;
  bearerKey: string;
  timeoutMs: number;
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

describe('ZaiQuotaService (RET-595)', () => {
  beforeAll(() => {
    process.env['MANIFEST_ENCRYPTION_KEY'] = TEST_SECRET;
  });
  afterAll(() => {
    delete process.env['MANIFEST_ENCRYPTION_KEY'];
  });

  it('polls every active zai subscription connection and exposes per-label gauges', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = async (url: string, bearerKey: string, timeoutMs: number) => {
      calls.push({ url, bearerKey, timeoutMs });
      return { status: 200, body: OK_BODY };
    };
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow(), zaiRow({ label: 'CCR', api_key_encrypted: encrypt('test-key-ccr', TEST_SECRET) })]),
      fetchImpl,
    );
    await svc.tick();
    const snap = svc.snapshot();
    expect(Object.keys(snap.labels).sort()).toEqual(['CCR', 'RCR']);
    expect(snap.labels['RCR'].five_h_pct_left).toBe(60);
    expect(snap.labels['RCR'].weekly_pct_left).toBe(90);
    expect(snap.labels['RCR'].error).toBeNull();
    expect(snap.labels['RCR'].seen_at).not.toBeNull();
    expect(snap.labels['RCR'].plan_level).toBe('lite');
    // RET-500-nodupe provenance: every label names its feed + last attempt.
    expect(snap.labels['RCR'].source).toBe('zai-coding-plan');
    expect(snap.labels['RCR'].polled_at).not.toBeNull();
    expect(snap.polled_at).not.toBeNull();
    expect(snap.polls).toBe(1);
    expect(snap.poll_errors).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(MONITOR_URL);
    expect(calls[0].timeoutMs).toBe(10_000);
    // Labels are polled in sorted order: CCR first, RCR second.
    expect(calls.map((call) => call.bearerKey)).toEqual(['test-key-ccr', 'test-key-rcr']);
    // Snapshot must be a copy — mutating it never corrupts live state.
    snap.labels['RCR'].five_h_pct_left = 0;
    expect(svc.snapshot().labels['RCR'].five_h_pct_left).toBe(60);
  });

  it('sends the bearer key only via the Authorization header and never in snapshot fields', async () => {
    const bearer = encrypt('super-secret-key-value', TEST_SECRET);
    const fetchImpl = async (url: string, bearerKey: string) => {
      expect(bearerKey).toBe('super-secret-key-value');
      return { status: 200, body: OK_BODY };
    };
    const svc = new ZaiQuotaService(makeRepo([zaiRow({ api_key_encrypted: bearer })]), fetchImpl);
    await svc.tick();
    const serialized = JSON.stringify(svc.snapshot());
    expect(serialized).not.toContain('super-secret-key-value');
    expect(serialized).not.toContain(bearer);
  });

  it('filters non-zai, non-subscription and keyless connections out', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200, body: OK_BODY }));
    const svc = new ZaiQuotaService(
      makeRepo([
        zaiRow(),
        zaiRow({ provider: 'openai' }),
        zaiRow({ auth_type: 'api_key' }),
        zaiRow({ api_key_encrypted: null as unknown as string }),
        // RET-500-nodupe: a PARKED (is_active=false) seat still polls —
        // is_active gates routing, not telemetry, so its label stays fed.
        zaiRow({ label: 'RCR Parked', is_active: false }),
        zaiRow({ label: '  CCR  ', api_key_encrypted: encrypt('test-key-ccr', TEST_SECRET) }),
      ]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await svc.tick();
    // RCR + trimmed CCR + the parked row poll; unknown-provider/other-auth rows never fetch.
    expect(Object.keys(svc.snapshot().labels).sort()).toEqual(['CCR', 'RCR', 'RCR Parked']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('classifies monitor failures per label without failing the cycle', async () => {
    // Labels are polled in sorted order: CCR, CCR Backup, RCR, RCR Backup.
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError'; // what AbortSignal.timeout throws (DOMException name)
    const responses: Array<{ status: number; body: unknown } | Error> = [
      { status: 401, body: { success: false } }, // CCR
      timeoutErr, // CCR Backup
      { status: 500, body: null }, // RCR
      // RCR Backup: fetchJson's contract is parsed-JSON-or-null, so junk text arrives as null.
      { status: 200, body: null },
    ];
    let index = 0;
    const fetchImpl = async () => {
      const value = responses[index++];
      if (value instanceof Error) throw value;
      return value;
    };
    const svc = new ZaiQuotaService(
      makeRepo([
        zaiRow({ label: 'RCR' }),
        zaiRow({ label: 'RCR Backup', api_key_encrypted: encrypt('test-key-rcrb', TEST_SECRET) }),
        zaiRow({ label: 'CCR', api_key_encrypted: encrypt('test-key-ccr', TEST_SECRET) }),
        zaiRow({ label: 'CCR Backup', api_key_encrypted: encrypt('test-key-ccrb', TEST_SECRET) }),
      ]),
      fetchImpl,
    );
    await svc.tick();
    const snap = svc.snapshot();
    expect(snap.labels['CCR'].error).toBe('http_401');
    expect(snap.labels['CCR'].five_h_pct_left).toBeNull();
    expect(snap.labels['CCR Backup'].error).toBe('timeout');
    expect(snap.labels['RCR'].error).toBe('http_500');
    expect(snap.labels['RCR Backup'].error).toBe('bad_json'); // 200 with junk JSON is a shape failure, diagnosable
    expect(snap.poll_errors).toBe(4);
    expect(snap.polled_at).not.toBeNull();
  });

  it('carries last-known readings forward when a poll errors after a good one', async () => {
    let status = 200;
    const fetchImpl = jest.fn(async () => ({ status, body: OK_BODY }));
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow()]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await svc.tick();
    const firstSeenAt = svc.snapshot().labels['RCR'].seen_at;
    status = 503;
    await svc.tick();
    const errored = svc.snapshot().labels['RCR'];
    expect(errored.error).toBe('http_503');
    expect(errored.five_h_pct_left).toBe(60); // stale-but-labeled, not wiped
    expect(errored.seen_at).toBe(firstSeenAt); // old seen_at says exactly how stale
    expect(errored.source).toBe('zai-coding-plan'); // provenance stays stamped on errors
    expect(errored.polled_at).not.toBeNull(); // attempt time fresh even when readings carried
  });

  it('classifies key decryption failure as key_decrypt_failed', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200, body: OK_BODY }));
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow({ api_key_encrypted: 'garbage-not-ciphertext' })]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await svc.tick();
    expect(svc.snapshot().labels['RCR'].error).toBe('key_decrypt_failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cooldowns a label after a monitor 429 and retains its last good reading', async () => {
    let status = 200;
    const fetchImpl = jest.fn(async () => ({
      status,
      body: status === 429 ? { success: true } : OK_BODY,
    }));
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow()]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await svc.tick();
    expect(svc.snapshot().labels['RCR'].five_h_pct_left).toBe(60);
    status = 429;
    await svc.tick();
    const after429 = svc.snapshot().labels['RCR'];
    expect(after429.error).toBe('http_429');
    expect(after429.five_h_pct_left).toBe(60); // carried forward, labeled stale
    const callsAfter429 = (fetchImpl as jest.Mock).mock.calls.length;
    await svc.tick(); // inside the 5-minute cooldown -> no fetch, reading retained
    expect((fetchImpl as jest.Mock).mock.calls.length).toBe(callsAfter429);
    expect(svc.snapshot().labels['RCR'].five_h_pct_left).toBe(60);
    expect(svc.snapshot().labels['RCR'].error).toBe('http_429');
  });

  it('keeps the previous snapshot when the connection read fails', async () => {
    const failingRepo: Repository<TenantProvider> = {
      find: async () => {
        throw new Error('db down');
      },
    } as unknown as Repository<TenantProvider>;
    const svc = new ZaiQuotaService(failingRepo, async () => ({ status: 200, body: OK_BODY }));
    // Seed a good reading by stubbing the repo for one cycle.
    const goodRepo = makeRepo([zaiRow()]);
    (svc as unknown as { providerRepo: Repository<TenantProvider> }).providerRepo = goodRepo;
    await svc.tick();
    expect(svc.snapshot().labels['RCR'].five_h_pct_left).toBe(60);
    (svc as unknown as { providerRepo: Repository<TenantProvider> }).providerRepo = failingRepo;
    const errorsBefore = svc.snapshot().poll_errors;
    await svc.tick();
    expect(svc.snapshot().labels['RCR'].five_h_pct_left).toBe(60);
    expect(svc.snapshot().poll_errors).toBeGreaterThan(errorsBefore);
  });

  it('collapses overlapping ticks into one poll cycle (single-flight)', async () => {
    const resolvers: Array<(value: { status: number; body: unknown }) => void> = [];
    const fetchImpl = jest.fn(
      () =>
        new Promise<{ status: number; body: unknown }>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow(), zaiRow({ label: 'CCR', api_key_encrypted: encrypt('k2', TEST_SECRET) })]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    const first = svc.tick();
    // Labels poll sequentially: wait for the first fetch to go in-flight.
    for (let i = 0; i < 50 && resolvers.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = svc.tick(); // in-flight -> no-op
    resolvers[0]({ status: 200, body: OK_BODY }); // release CCR
    await new Promise((r) => setTimeout(r, 10)); // let the same cycle start RCR's fetch
    // Exactly one cycle's worth of fetches (2 labels) are pending; release them.
    expect(resolvers).toHaveLength(2);
    for (const resolve of resolvers.slice(1)) resolve({ status: 200, body: OK_BODY });
    await Promise.all([first, second]);
    expect((fetchImpl as jest.Mock).mock.calls.length).toBe(2); // one cycle x two labels
    expect(svc.snapshot().polls).toBe(1);
  });

  it('idles safely with no zai connections and with a broken repository', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200, body: OK_BODY }));
    const emptySvc = new ZaiQuotaService(
      makeRepo([]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await emptySvc.tick();
    expect(emptySvc.snapshot().labels).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(emptySvc.snapshot().polled_at).not.toBeNull();

    const brokenSvc = new ZaiQuotaService(
      {
        find: async () => {
          throw new Error('db down');
        },
      } as unknown as Repository<TenantProvider>,
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await expect(brokenSvc.tick()).resolves.not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors env overrides for monitor base and stays on the documented path', async () => {
    const calls: FetchCall[] = [];
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow()]),
      async (url: string, bearerKey: string, timeoutMs: number) => {
        calls.push({ url, bearerKey, timeoutMs });
        return { status: 200, body: OK_BODY };
      },
      { ZAI_QUOTA_MONITOR_BASE: 'https://monitor.example.com/' },
    );
    await svc.tick();
    expect(calls[0].url).toBe('https://monitor.example.com/api/monitor/usage/quota/limit');
  });

  it('idle-inits without a repository and never schedules a loop that throws', async () => {
    const svc = new ZaiQuotaService(null as unknown as Repository<TenantProvider>);
    expect(() => svc.onModuleInit()).not.toThrow();
    svc.onModuleDestroy();
  });

  it('marks a 200-without-a-5h-window payload as parse_failed_5h, keeping previous readings', async () => {
    // Weekly-only envelope: the shape drift that froze the Nov-14 anchors.
    const noFiveH = {
      success: true,
      data: { level: 'lite', limits: [{ unit: 6, number: 1, percentage: 10, nextResetTime: 1800595200000 }] },
    };
    let body: unknown = OK_BODY;
    const fetchImpl = jest.fn(async () => ({ status: 200, body }));
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow()]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await svc.tick();
    expect(svc.snapshot().labels['RCR'].error).toBeNull();
    body = noFiveH;
    await svc.tick();
    const drifted = svc.snapshot().labels['RCR'];
    expect(drifted.error).toBe('parse_failed_5h');
    expect(drifted.five_h_pct_left).toBe(60); // previous readings kept, honestly labeled
    expect(drifted.weekly_pct_left).toBe(90);
    expect(drifted.source).toBe('zai-coding-plan');
    expect(drifted.polled_at).not.toBeNull();
    expect(svc.snapshot().poll_errors).toBe(1);
  });

  it('keeps a healthy inactive_or_free answer error-free even with null gauges', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 200, body: { success: false } }));
    const svc = new ZaiQuotaService(
      makeRepo([zaiRow()]),
      fetchImpl as unknown as () => Promise<{ status: number; body: unknown }>,
    );
    await svc.tick();
    const label = svc.snapshot().labels['RCR'];
    expect(label.subscription_status).toBe('inactive_or_free');
    expect(label.error).toBeNull();
    expect(label.source).toBe('zai-coding-plan');
    expect(label.polled_at).not.toBeNull();
  });
});
