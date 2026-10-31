import { ProxyMessageRecorder } from '../proxy-message-recorder';
import { IngestEventBusService } from '../../../common/services/ingest-event-bus.service';
import { ProviderAttemptRef } from '../proxy-types';

/**
 * Abort-burn row contract (D-2026-10-30-11): a client-aborted Provider Attempt
 * that had already been dispatched upstream carries abort_billed=true +
 * abort_est_tokens on its `cancelled` row — burn visibility without touching
 * the glossary rule that cancelled rows keep NO error fields.
 */

function makeRecorder(repo: {
  insert: jest.Mock;
  update: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
}) {
  const pricingCache = { getByModel: jest.fn().mockReturnValue(undefined) };
  return new ProxyMessageRecorder(
    repo as never,
    pricingCache as never,
    { emit: jest.fn() } as unknown as IngestEventBusService,
    {
      canonicalizeAgentMessageKeys: jest
        .fn()
        .mockImplementation(async (_a: string, provider: string | null, model: string | null) => ({
          provider: provider ?? null,
          model: model ?? null,
        })),
    } as never,
    {
      getCostPerRequest: jest.fn().mockReturnValue(null),
      resolveCostPerRequest: jest.fn().mockResolvedValue(null),
    } as never,
  );
}

function attemptRef(dispatch?: ProviderAttemptRef['dispatch']): ProviderAttemptRef {
  return {
    id: 'attempt-' + Math.random().toString(36).slice(2),
    attemptNumber: 1,
    startedAtMs: Date.now() - 100,
    startedAt: new Date(Date.now() - 100).toISOString(),
    pendingWrite: Promise.resolve(true),
    ...(dispatch ? { dispatch } : {}),
  };
}

describe('ProxyMessageRecorder abort-billing (D-2026-10-30-11)', () => {
  const ctx = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    agentName: 'test-agent',
  } as never;

  it('stamps abort_billed + abort_est_tokens on a cancelled attempt that had been dispatched', async () => {
    const repo = {
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    const recorder = makeRecorder(repo);
    // 1234 wire-body chars → ceil(1234 / 4) = 309 estimated input tokens.
    const attempt = attemptRef({
      provider: 'zai',
      wireBodyChars: 1234,
      dispatchedAtMs: Date.now() - 50,
    });

    const cancelled = await recorder.cancelPendingProviderAttempts([attempt]);

    expect(cancelled).toEqual([attempt]);
    expect(repo.update).toHaveBeenCalledWith(
      { id: attempt.id, status: 'pending' },
      expect.objectContaining({
        status: 'cancelled',
        abort_billed: true,
        abort_est_tokens: 309,
      }),
    );
    // The glossary contract holds: cancelled rows keep NO error fields.
    const payload = repo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.error_message).toBeNull();
    expect(payload.error_code).toBeNull();
    expect(payload.error_http_status).toBeNull();
  });

  it('does NOT stamp abort fields when the attempt never reached dispatch', async () => {
    const repo = {
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    const recorder = makeRecorder(repo);
    const attempt = attemptRef(); // no dispatch capture

    const cancelled = await recorder.cancelPendingProviderAttempts([attempt]);

    expect(cancelled).toEqual([attempt]);
    const payload = repo.update.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.status).toBe('cancelled');
    expect(payload.abort_billed).toBeUndefined();
    expect(payload.abort_est_tokens).toBeUndefined();
  });

  it('skips attempts whose pending row never landed and returns only what it cancelled', async () => {
    const repo = {
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    const recorder = makeRecorder(repo);
    const landed = attemptRef({
      provider: 'zai',
      wireBodyChars: 400,
      dispatchedAtMs: Date.now() - 10,
    });
    const neverLanded: ProviderAttemptRef = {
      ...attemptRef(),
      id: 'never-landed',
      pendingWrite: Promise.resolve(false),
    };

    const cancelled = await recorder.cancelPendingProviderAttempts([neverLanded, landed]);

    expect(cancelled).toEqual([landed]);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update.mock.calls[0][0]).toEqual({ id: landed.id, status: 'pending' });
  });

  it('recordCancelledRequest carries the abort-bill fields onto the attempt row', async () => {
    const repo = {
      insert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    const recorder = makeRecorder(repo);
    const attempt = attemptRef({
      provider: 'zai',
      wireBodyChars: 800,
      dispatchedAtMs: Date.now() - 20,
    });

    await recorder.recordCancelledRequest(ctx, {
      requestId: 'req-1',
      attempt,
      attemptStart: { provider: 'zai', model: 'glm-4.6', authType: 'api_key' },
      requestDurationMs: 31000,
      apiMode: 'chat_completions',
    });

    // persistRequest is a no-op without a request-table manager (unit repo
    // double); the attempt row update is the contract under test.
    expect(repo.update).toHaveBeenCalledWith(
      { id: attempt.id },
      expect.objectContaining({
        status: 'cancelled',
        abort_billed: true,
        abort_est_tokens: 200,
      }),
    );
  });
});
