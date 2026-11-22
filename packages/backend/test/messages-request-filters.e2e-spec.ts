import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import request from 'supertest';
import { createTestApp, TEST_API_KEY, TEST_TENANT_ID } from './helpers';
import { encrypt, getEncryptionSecret } from '../src/common/utils/crypto.util';

/**
 * Filters on the request-first Requests log, end to end.
 *
 * Attempt lookups are bounded by the parent's tenant and time window, the
 * harness is resolved to its id before the query, and "no recovery attempt" is
 * two anti-joins. Those are planner hints: every filter and combination here
 * must return exactly the requests it returned before, with a matching total.
 */

const HARNESS = 'request-filters-probe';
const OTHER_HARNESS = 'request-filters-other';
const HARNESS_ID = 'request-filters-probe-id';
const OTHER_HARNESS_ID = 'request-filters-other-id';

type Attempt = {
  provider: string;
  model: string;
  status: string;
  fallbackFrom?: string;
  autofix?: boolean;
  /** The tenant_providers row that served this hop (the Wallet filter's join key). */
  keyId?: string;
};

let app: INestApplication;
const seeded: Record<string, string> = {};

// RET-697 wallet fixtures: two provider keys — one owned by the MAIN wallet,
// one belonging to no wallet — so the Wallet filter can be exercised on top of
// the shared request pool without touching any other case's expected arrays
// (the wallet predicate only runs when `wallet=` is on the query).
const KEY_MAIN_ID = 'up-wallet-main-key';
const KEY_SOLO_ID = 'up-wallet-solo-key';
const WALLET_MAIN_ID = 'wallet-filter-main';
const WALLET_SPARE_ID = 'wallet-filter-spare';

/**
 * Local wall-clock, the way the gateway writes `timestamp` columns and computes
 * range cutoffs. A UTC string would shift the range-edge row by the offset.
 */
function sqlTime(msAgo: number): string {
  const d = new Date(Date.now() - msAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function seedRequest(
  ds: DataSource,
  key: string,
  opts: {
    agentId?: string;
    agentName?: string;
    msAgo?: number;
    status?: string;
    origin?: string;
    requestedModel?: string;
    attempts: Attempt[];
  },
): Promise<void> {
  const id = uuid();
  seeded[key] = id;
  const msAgo = opts.msAgo ?? HOUR;
  await ds.query(
    `INSERT INTO requests (id, tenant_id, agent_id, agent_name, user_id, timestamp, status, error_origin, requested_model, api_mode)
     VALUES ($1, $2, $3, $4, 'test-user-001', $5, $6, $7, $8, 'chat_completions')`,
    [
      id,
      TEST_TENANT_ID,
      opts.agentId ?? HARNESS_ID,
      opts.agentName ?? HARNESS,
      sqlTime(msAgo),
      opts.status ?? 'success',
      opts.origin ?? null,
      opts.requestedModel ?? 'auto',
    ],
  );
  for (const [index, attempt] of opts.attempts.entries()) {
    await ds.query(
      `INSERT INTO agent_messages (id, request_id, attempt_number, tenant_id, agent_id, agent_name, user_id, timestamp, status, provider, model, fallback_from_model, autofix_applied, input_tokens, output_tokens, service_type, tenant_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'test-user-001', $7, $8, $9, $10, $11, $12, 10, 5, 'agent', $13)`,
      [
        uuid(),
        id,
        index + 1,
        TEST_TENANT_ID,
        opts.agentId ?? HARNESS_ID,
        opts.agentName ?? HARNESS,
        // Each hop starts a few seconds after its parent request.
        sqlTime(msAgo - (index + 1) * 2_000),
        attempt.status,
        attempt.provider,
        attempt.model,
        attempt.fallbackFrom ?? null,
        attempt.autofix ?? false,
        attempt.keyId ?? null,
      ],
    );
  }
}

beforeAll(async () => {
  app = await createTestApp();
  const ds = app.get(DataSource);
  for (const [id, name] of [
    [HARNESS_ID, HARNESS],
    [OTHER_HARNESS_ID, OTHER_HARNESS],
  ]) {
    await ds.query(
      `INSERT INTO agents (id, name, display_name, description, is_active, complexity_routing_enabled, tenant_id, created_at, updated_at)
       VALUES ($1, $2, $2, 'request filter probe', true, true, $3, NOW(), NOW())`,
      [id, name, TEST_TENANT_ID],
    );
  }

  await seedRequest(ds, 'plain', {
    attempts: [{ provider: 'openai', model: 'probe-a', status: 'success' }],
  });
  await seedRequest(ds, 'fallback', {
    msAgo: 2 * HOUR,
    attempts: [
      { provider: 'anthropic', model: 'probe-b', status: 'fallback_error' },
      { provider: 'openai', model: 'probe-a', status: 'success', fallbackFrom: 'probe-b' },
    ],
  });
  await seedRequest(ds, 'autofix', {
    msAgo: 3 * HOUR,
    attempts: [
      { provider: 'openai', model: 'probe-a', status: 'error' },
      { provider: 'openai', model: 'probe-a', status: 'success', autofix: true },
    ],
  });
  await seedRequest(ds, 'failed', {
    msAgo: 4 * HOUR,
    status: 'failed',
    origin: 'provider',
    attempts: [{ provider: 'anthropic', model: 'probe-b', status: 'error' }],
  });
  // Rejected by Manifest before any provider call: no attempt at all.
  await seedRequest(ds, 'blocked', {
    msAgo: 5 * HOUR,
    status: 'failed',
    origin: 'config',
    requestedModel: 'probe-blocked',
    attempts: [],
  });
  // Near the far edge of a 7-day range: its attempts run after the cutoff too.
  await seedRequest(ds, 'edge', {
    msAgo: 7 * DAY - HOUR,
    attempts: [
      { provider: 'anthropic', model: 'probe-b', status: 'fallback_error' },
      { provider: 'openai', model: 'probe-a', status: 'success', fallbackFrom: 'probe-b' },
    ],
  });
  // Outside 7 days, inside 30.
  await seedRequest(ds, 'old', {
    msAgo: 10 * DAY,
    attempts: [
      { provider: 'anthropic', model: 'probe-b', status: 'fallback_error' },
      { provider: 'openai', model: 'probe-a', status: 'success', fallbackFrom: 'probe-b' },
    ],
  });
  await seedRequest(ds, 'otherHarness', {
    agentId: OTHER_HARNESS_ID,
    agentName: OTHER_HARNESS,
    attempts: [
      { provider: 'anthropic', model: 'probe-b', status: 'fallback_error' },
      { provider: 'openai', model: 'probe-a', status: 'success', fallbackFrom: 'probe-b' },
    ],
  });

  // RET-697: provider keys + the MAIN wallet that owns the main key. `failed`
  // and `blocked` stay walletless so the filter's negative cases are real rows.
  const secret = getEncryptionSecret();
  const enc = (s: string) => encrypt(s, secret);
  for (const [id, prefix] of [
    [KEY_MAIN_ID, 'sk-main'],
    [KEY_SOLO_ID, 'sk-solo'],
  ]) {
    await ds.query(
      `INSERT INTO tenant_providers
         (id, tenant_id, created_by_user_id, agent_id, provider, auth_type, api_key_encrypted, is_active, connected_at, updated_at, key_prefix, cached_models)
       VALUES ($1,$2,'test-user-001',$3,'openai','api_key',$4,true,NOW(),NOW(),$5,'[]')`,
      [id, TEST_TENANT_ID, HARNESS_ID, enc(`${prefix}-secret`), prefix],
    );
  }
  await ds.query(
    `INSERT INTO wallets (id, tenant_id, name, color, created_at, updated_at)
     VALUES ($1,$2,'MAIN','emerald',NOW(),NOW()), ($3,$2,'SPARE','#123abc',NOW(),NOW())`,
    [WALLET_MAIN_ID, TEST_TENANT_ID, WALLET_SPARE_ID],
  );
  await ds.query(
    `INSERT INTO wallet_members (wallet_id, tenant_provider_id, tenant_id, created_at)
     VALUES ($1,$2,$3,NOW())`,
    [WALLET_MAIN_ID, KEY_MAIN_ID, TEST_TENANT_ID],
  );
  // Stamp the shared pool: plain + fallback's first hop were served by the MAIN
  // key; fallback's second hop and `failed` by the walletless key.
  for (const [requestKey, attemptNumber, keyId] of [
    ['plain', 1, KEY_MAIN_ID],
    ['fallback', 1, KEY_MAIN_ID],
    ['fallback', 2, KEY_SOLO_ID],
    ['failed', 1, KEY_SOLO_ID],
  ] as const) {
    await ds.query(
      'UPDATE agent_messages SET tenant_provider_id = $1 WHERE request_id = $2 AND attempt_number = $3',
      [keyId, seeded[requestKey], attemptNumber],
    );
  }
});

afterAll(async () => {
  const ds = app.get(DataSource);
  for (const id of Object.values(seeded)) {
    await ds.query('DELETE FROM agent_messages WHERE request_id = $1', [id]);
    await ds.query('DELETE FROM requests WHERE id = $1', [id]);
  }
  await ds.query('DELETE FROM agents WHERE id IN ($1, $2)', [HARNESS_ID, OTHER_HARNESS_ID]);
  // Wallet fixtures, members first (FK cascade makes the order optional but
  // explicit keeps the teardown readable).
  await ds.query('DELETE FROM wallet_members WHERE wallet_id IN ($1, $2)', [
    WALLET_MAIN_ID,
    WALLET_SPARE_ID,
  ]);
  await ds.query('DELETE FROM wallets WHERE id IN ($1, $2)', [WALLET_MAIN_ID, WALLET_SPARE_ID]);
  await ds.query('DELETE FROM tenant_providers WHERE id IN ($1, $2)', [KEY_MAIN_ID, KEY_SOLO_ID]);
  await app.close();
});

type LogBody = { items: { id: string }[]; total_count: number; next_cursor: string | null };

async function log(query: string): Promise<LogBody> {
  const res = await request(app.getHttpServer())
    .get(`/api/v1/messages?${query}`)
    .set('x-api-key', TEST_API_KEY)
    .expect(200);
  return res.body as LogBody;
}

/** Seeded keys the response returned, in log order. */
function keysOf(body: LogBody): string[] {
  const byId = Object.fromEntries(Object.entries(seeded).map(([key, id]) => [id, key]));
  return body.items.map((item) => byId[item.id]).filter(Boolean);
}

/** One harness, one week: the exact rows and an exact total. */
async function expectHarnessWeek(filters: string, expected: string[]): Promise<void> {
  const body = await log(`range=7d&agent_name=${HARNESS}&${filters}`);
  expect(keysOf(body)).toEqual(expected);
  expect(body.total_count).toBe(expected.length);
}

describe('GET /api/v1/messages request filters', () => {
  it('lists the harness week with no other filter', async () => {
    await expectHarnessWeek('', ['plain', 'fallback', 'autofix', 'failed', 'blocked', 'edge']);
  });

  it.each([
    ['trigger=fallback', ['fallback', 'edge']],
    ['trigger=autofix', ['autofix']],
    ['trigger=none', ['plain', 'failed', 'blocked']],
    ['trigger=fallback,none', ['plain', 'fallback', 'failed', 'blocked', 'edge']],
    ['trigger=autofix,fallback', ['fallback', 'autofix', 'edge']],
    ['status=failed', ['failed', 'blocked']],
    ['status=ok', ['plain', 'fallback', 'autofix', 'edge']],
    ['status=ok&trigger=autofix', ['autofix']],
    ['status=failed&trigger=none', ['failed', 'blocked']],
    ['origin=provider', ['failed']],
    ['origin=manifest', ['blocked']],
    ['provider=anthropic', ['fallback', 'failed', 'edge']],
    ['provider=anthropic&trigger=none', ['failed']],
    ['model=probe-b', ['fallback', 'failed', 'edge']],
    ['model=probe-blocked', ['blocked']],
    ['model=probe-a&trigger=autofix', ['autofix']],
    ['attempts=has_failed', ['fallback', 'autofix', 'failed', 'edge']],
    ['attempts=has_failed,has_succeeded', ['fallback', 'autofix', 'edge']],
  ])('%s', async (filters, expected) => {
    await expectHarnessWeek(filters, expected);
  });

  it('keeps requests older than the range out and lets a wider range in', async () => {
    const month = await log(`range=30d&agent_name=${HARNESS}&trigger=fallback`);
    expect(keysOf(month)).toEqual(['fallback', 'edge', 'old']);
    expect(month.total_count).toBe(3);
  });

  it('scopes to the chosen harness and spans harnesses without one', async () => {
    const other = await log(`range=7d&agent_name=${OTHER_HARNESS}&trigger=fallback`);
    expect(keysOf(other)).toEqual(['otherHarness']);
    expect(other.total_count).toBe(1);

    const all = await log('range=7d&trigger=fallback');
    expect(keysOf(all)).toEqual(['otherHarness', 'fallback', 'edge']);
  });

  it('pages a filtered view with a stable total', async () => {
    const first = await log(`range=7d&agent_name=${HARNESS}&trigger=fallback,none&limit=2`);
    expect(keysOf(first)).toEqual(['plain', 'fallback']);
    expect(first.total_count).toBe(5);

    const cursor = encodeURIComponent(first.next_cursor ?? '');
    const second = await log(
      `range=7d&agent_name=${HARNESS}&trigger=fallback,none&limit=2&cursor=${cursor}`,
    );
    expect(keysOf(second)).toEqual(['failed', 'blocked']);

    const third = await log(
      `range=7d&agent_name=${HARNESS}&trigger=fallback,none&limit=2&cursor=${encodeURIComponent(second.next_cursor ?? '')}`,
    );
    expect(keysOf(third)).toEqual(['edge']);
    expect(third.next_cursor).toBeNull();
  });

  it("offers a blocked request's model in the harness filter options", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/messages/filter-options?range=7d&agent_name=${HARNESS}`)
      .set('x-api-key', TEST_API_KEY)
      .expect(200);
    expect(res.body.models).toEqual(
      expect.arrayContaining(['probe-a', 'probe-b', 'probe-blocked']),
    );
  });

  describe('wallet filter (RET-697)', () => {
    // plain + fallback's first hop carry the MAIN wallet's key; fallback's
    // second hop and `failed` carry a walletless key, so every expectation
    // below exercises both sides of the wallet_members join.
    it('matches requests an attempt of which was served by a wallet key', async () => {
      await expectHarnessWeek(`wallet=${WALLET_MAIN_ID}`, ['plain', 'fallback']);
    });

    it('composes with the other attempt facets', async () => {
      await expectHarnessWeek(`wallet=${WALLET_MAIN_ID}&trigger=none`, ['plain']);
      await expectHarnessWeek(`wallet=${WALLET_MAIN_ID}&trigger=fallback`, ['fallback']);
      // `failed` was served by the walletless key: its status facet matches,
      // but the wallet predicate must still exclude it.
      await expectHarnessWeek(`wallet=${WALLET_MAIN_ID}&status=failed`, []);
    });

    it('does not match an empty wallet or an unknown id', async () => {
      await expectHarnessWeek(`wallet=${WALLET_SPARE_ID}`, []);
      await expectHarnessWeek('wallet=00000000-0000-4000-8000-000000000000', []);
    });

    it('keeps a walletless attempt out of a wallet match (the "—"-chip rule)', async () => {
      // A csv of ids ORs together: SPARE has no member keys, so this equals
      // the MAIN-only query — the walletless second hop of `fallback` must
      // not smuggle the request into a SPARE-only view either.
      await expectHarnessWeek(`wallet=${WALLET_MAIN_ID},${WALLET_SPARE_ID}`, ['plain', 'fallback']);
    });
  });
});
