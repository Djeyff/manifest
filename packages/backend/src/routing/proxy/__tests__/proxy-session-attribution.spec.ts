import { HttpException } from '@nestjs/common';
import { ProxyMessageRecorder } from '../proxy-message-recorder';
import { ProxyController } from '../proxy.controller';
import { IngestEventBusService } from '../../../common/services/ingest-event-bus.service';
import { ThoughtSignatureCache } from '../thought-signature-cache';
import { ThinkingBlockCache } from '../thinking-block-cache';
import { ReasoningContentCache } from '../reasoning-content-cache';
import {
  handleProviderError,
  recordFallbackFailures,
  recordSuccess,
} from '../proxy-response-handler';
import type { FailedFallback } from '../proxy-fallback.service';
import type { RoutingMeta } from '../proxy.service';
import type { IngestionContext } from '../../../otlp/interfaces/ingestion-context.interface';
import type { ProviderAttemptRef } from '../proxy-types';
import type { AutofixRecord } from '../../autofix/autofix.types';

/**
 * RET-578-FU-A: gateway attribution persistence. Every record path must carry
 * the caller's `x-session-key` (and never the `default` placeholder) onto the
 * session_key column of both the message row and the request row it derives.
 */

const ctx: IngestionContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  agentName: 'test-agent',
  userId: 'user-1',
};

const SESSION = 'cr-alpha';

const autofixWithRetry: AutofixRecord = {
  groupId: 'grp-1',
  outcome: 'healed',
  original_http_status: 400,
  chain: [
    {
      attempt: 0,
      origin: 'original',
      request: { max_tokens: 5 },
      http_status: 400,
      error: {
        message: 'Unknown parameter',
        type: 'invalid_request_error',
        param: 'max_tokens',
        code: 'unknown_parameter',
      },
      operations: [{ type: 'rename_param', from: 'max_tokens', to: 'max_output_tokens' }],
      heal_attempt_id: 'heal-1',
      patch_worked: true,
    },
    { attempt: 1, origin: 'autofix', request: { max_output_tokens: 5 }, http_status: 200 },
  ],
};

function makeAttempt(id: string): ProviderAttemptRef {
  return {
    id,
    attemptNumber: 1,
    startedAtMs: 1_000,
    startedAt: '1970-01-01T00:00:01.000Z',
    completedAtMs: 1_125,
    pendingWrite: Promise.resolve(false),
  };
}

/**
 * Recorder harness whose TypeORM manager exposes a capture-everything query
 * builder, so `persistRequest` runs for real and the derived requests-table row
 * is observable (the shared spec doubles return `{}` and skip request rows).
 */
function buildRecorderHarness() {
  const messageRows: Array<Record<string, unknown>> = [];
  const requestRows: Array<Record<string, unknown>> = [];
  const updatePayloads: Array<Record<string, unknown>> = [];
  const qb = {
    insert: () => qb,
    into: () => qb,
    values: (row: Record<string, unknown>) => {
      requestRows.push(row);
      return qb;
    },
    orIgnore: () => qb,
    orUpdate: () => qb,
    execute: async () => ({}),
  };
  const repo = {
    insert: jest.fn(async (row: Record<string, unknown>) => {
      messageRows.push(row);
      return {};
    }),
    update: jest.fn(async (_criteria: unknown, payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return {};
    }),
    manager: { getRepository: () => ({ createQueryBuilder: () => qb }) },
  } as never;
  const recorder = new ProxyMessageRecorder(
    repo,
    { getByModel: () => undefined } as never,
    { emit: jest.fn() } as never,
    {
      canonicalizeAgentMessageKeys: async (
        _tenant: string,
        provider: string | null,
        model: string | null,
      ) => ({ provider: provider ?? null, model: model ?? null }),
    } as never,
    {
      getCostPerRequest: jest.fn().mockReturnValue(null),
      resolveCostPerRequest: jest.fn().mockResolvedValue(null),
    } as never,
    { getProviders: jest.fn().mockResolvedValue([]) } as never,
  );
  return { recorder, messageRows, requestRows, updatePayloads, repo };
}

describe('ProxyMessageRecorder session attribution', () => {
  let harness: ReturnType<typeof buildRecorderHarness>;

  beforeEach(() => {
    harness = buildRecorderHarness();
  });

  afterEach(() => {
    harness.recorder.onModuleDestroy();
  });

  it('recordProviderError persists session_key on the message and request rows', async () => {
    await harness.recorder.recordProviderError(ctx, 502, 'upstream exploded', {
      requestId: 'req-pe',
      sessionKey: SESSION,
      traceId: 'trace-1',
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(harness.messageRows[0]).toMatchObject({
      request_id: 'req-pe',
      trace_id: 'trace-1',
      session_key: SESSION,
    });
    expect(harness.requestRows[0]).toMatchObject({ session_key: SESSION });
  });

  it('recordFailedFallbacks persists session_key on every hop row', async () => {
    const failures = [
      { provider: 'openai', model: 'fallback-a', status: 500, errorBody: 'boom', fallbackIndex: 1 },
      { provider: 'groq', model: 'fallback-b', status: 503, errorBody: 'flaky', fallbackIndex: 2 },
    ] as unknown as FailedFallback[];

    await harness.recorder.recordFailedFallbacks(ctx, 'simple', 'primary-m', failures, {
      requestId: 'req-ff',
      firstAttemptNumber: 2,
      sessionKey: SESSION,
      traceId: 'trace-2',
      markHandled: true,
    });

    expect(harness.messageRows).toHaveLength(1);
    const hopRows = harness.messageRows[0] as unknown as Array<Record<string, unknown>>;
    expect(hopRows).toHaveLength(2);
    for (const row of hopRows) {
      expect(row).toMatchObject({ session_key: SESSION });
    }
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: SESSION });
  });

  it('recordPrimaryFailure persists session_key on the message and request rows', async () => {
    await harness.recorder.recordPrimaryFailure(
      ctx,
      'simple',
      'primary-m',
      'exhausted',
      new Date().toISOString(),
      'api_key',
      {
        requestId: 'req-pf',
        sessionKey: SESSION,
        httpStatus: 502,
        terminalHttpStatus: 502,
      },
    );

    expect(harness.messageRows[0]).toMatchObject({ session_key: SESSION });
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: SESSION });
  });

  it('recordFallbackSuccess persists session_key on the message and request rows', async () => {
    await harness.recorder.recordFallbackSuccess(ctx, 'fallback-m', 'simple', {
      requestId: 'req-fs',
      sessionKey: SESSION,
      traceId: 'trace-3',
      provider: 'openai',
      fallbackFromModel: 'primary-m',
      fallbackIndex: 1,
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });

    expect(harness.messageRows[0]).toMatchObject({
      request_id: 'req-fs',
      session_key: SESSION,
      status: 'success',
    });
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: SESSION });
  });

  it('recordAutofixOriginal persists session_key on the original-failure row', async () => {
    await harness.recorder.recordAutofixOriginal(ctx, 'primary-m', 'simple', autofixWithRetry, {
      requestId: 'req-af',
      sessionKey: SESSION,
      traceId: 'trace-4',
    });

    expect(harness.messageRows[0]).toMatchObject({
      request_id: 'req-af',
      session_key: SESSION,
      autofix_role: 'original',
    });
  });

  it('recordCancelledRequest persists session_key on the message and request rows', async () => {
    const attempt = makeAttempt('attempt-cancel');

    await harness.recorder.recordCancelledRequest(ctx, {
      requestId: 'req-cancel',
      attempt,
      sessionKey: SESSION,
      traceId: 'trace-5',
    });

    expect(harness.messageRows[0]).toMatchObject({
      request_id: 'req-cancel',
      session_key: SESSION,
    });
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: SESSION });
  });

  const findMessageRow = (rid: string) =>
    harness.messageRows.find(
      (r) => (r as Record<string, unknown>).request_id === rid,
    ) as Record<string, unknown> | undefined;

  it('normalizes the literal default placeholder to null on every path', async () => {
    await harness.recorder.recordProviderError(ctx, 502, 'boom', {
      requestId: 'req-d1',
      sessionKey: 'default',
    });
    expect(findMessageRow('req-d1')).toMatchObject({ session_key: null });

    await harness.recorder.recordCancelledRequest(ctx, {
      requestId: 'req-d2',
      sessionKey: 'default',
    });
    expect(findMessageRow('req-d2')).toBeUndefined();
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: null });

    await harness.recorder.recordFallbackSuccess(ctx, 'm', 'simple', {
      requestId: 'req-d3',
      sessionKey: 'default',
    });
    expect(findMessageRow('req-d3')).toMatchObject({ session_key: null });

    await harness.recorder.recordManifestBlockedRequest(ctx, {
      requestId: 'req-d4',
      errorMessage: 'blocked',
      reason: 'manifest_internal_error',
      sessionKey: 'default',
    });
    expect(findMessageRow('req-d4')).toMatchObject({ session_key: null });
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: null });

    await harness.recorder.recordPendingRequest(ctx, {
      requestId: 'req-d5',
      timestamp: new Date().toISOString(),
      sessionKey: 'default',
    });
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: null });
  });

  it('leaves session_key null (never default) when no header was sent', async () => {
    await harness.recorder.recordProviderError(ctx, 502, 'boom', { requestId: 'req-n1' });
    expect(findMessageRow('req-n1')).toMatchObject({ session_key: null });

    await harness.recorder.recordCancelledRequest(ctx, { requestId: 'req-n2' });
    expect(findMessageRow('req-n2')).toBeUndefined();
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: null });

    await harness.recorder.recordPendingRequest(ctx, {
      requestId: 'req-n3',
      timestamp: new Date().toISOString(),
    });
    expect(harness.requestRows.at(-1)).toMatchObject({ session_key: null });

    await harness.recorder.recordManifestBlockedRequest(ctx, {
      requestId: 'req-n4',
      errorMessage: 'blocked',
      reason: 'manifest_internal_error',
    });
    expect(findMessageRow('req-n4')).toMatchObject({ session_key: null });
  });
});

describe('proxy-response-handler session threading', () => {
  function metaStub(overrides: Partial<RoutingMeta> = {}): RoutingMeta {
    return {
      tier: 'simple',
      model: 'primary-m',
      provider: 'openai',
      confidence: 0.9,
      reason: 'scored',
      auth_type: 'api_key',
      fallbackFromModel: 'primary-m',
      fallbackIndex: 1,
      providerCallStarted: true,
      ...overrides,
    } as unknown as RoutingMeta;
  }

  function resStub() {
    return {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      json: jest.fn(),
    } as never;
  }

  it('handleProviderError threads sessionKey into the provider-error record', async () => {
    const harness = buildRecorderHarness();
    const spy = jest.spyOn(harness.recorder, 'recordProviderError');

    await handleProviderError(
      resStub(),
      ctx,
      metaStub({ fallbackFromModel: undefined }),
      {},
      502,
      'upstream exploded',
      undefined,
      harness.recorder,
      'trace-1',
      null,
      null,
      undefined,
      'req-pe',
      120,
      'chat_completions',
      SESSION,
    );

    expect(spy).toHaveBeenCalledWith(
      ctx,
      502,
      'upstream exploded',
      expect.objectContaining({ sessionKey: SESSION }),
    );
    harness.recorder.onModuleDestroy();
  });

  it('handleProviderError threads sessionKey into fallback-exhausted records', async () => {
    const harness = buildRecorderHarness();
    const failedSpy = jest.spyOn(harness.recorder, 'recordFailedFallbacks');
    const primarySpy = jest.spyOn(harness.recorder, 'recordPrimaryFailure');
    const failures = [
      { provider: 'openai', model: 'fallback-a', status: 500, errorBody: 'boom', fallbackIndex: 1 },
    ] as unknown as FailedFallback[];

    await handleProviderError(
      resStub(),
      ctx,
      metaStub({ fallbackFromModel: undefined }),
      {},
      502,
      'exhausted',
      failures,
      harness.recorder,
      'trace-2',
      null,
      null,
      undefined,
      'req-ff',
      200,
      'chat_completions',
      SESSION,
    );

    expect(failedSpy).toHaveBeenCalledWith(
      ctx,
      'simple',
      'primary-m',
      failures,
      expect.objectContaining({ sessionKey: SESSION }),
    );
    expect(primarySpy).toHaveBeenCalledWith(
      ctx,
      'simple',
      'primary-m',
      'exhausted',
      expect.any(String),
      'api_key',
      expect.objectContaining({ sessionKey: SESSION }),
    );
    harness.recorder.onModuleDestroy();
  });

  it('recordFallbackFailures threads sessionKey into primary and hop records', () => {
    const harness = buildRecorderHarness();
    const failedSpy = jest.spyOn(harness.recorder, 'recordFailedFallbacks');
    const primarySpy = jest.spyOn(harness.recorder, 'recordPrimaryFailure');
    const failures = [
      { provider: 'openai', model: 'fallback-a', status: 500, errorBody: 'boom', fallbackIndex: 1 },
    ] as unknown as FailedFallback[];

    recordFallbackFailures(
      ctx,
      metaStub(),
      failures,
      harness.recorder,
      null,
      null,
      undefined,
      'req-rff',
      SESSION,
    );

    expect(primarySpy).toHaveBeenCalledWith(
      ctx,
      'simple',
      'primary-m',
      expect.any(String),
      expect.any(String),
      'api_key',
      expect.objectContaining({ sessionKey: SESSION }),
    );
    expect(failedSpy).toHaveBeenCalledWith(
      ctx,
      'simple',
      'primary-m',
      failures,
      expect.objectContaining({ sessionKey: SESSION }),
    );
    harness.recorder.onModuleDestroy();
  });

  it('recordSuccess forwards sessionKey to the fallback-success record', () => {
    const harness = buildRecorderHarness();
    const fallbackSpy = jest.spyOn(harness.recorder, 'recordFallbackSuccess');

    recordSuccess(
      ctx,
      metaStub(),
      { prompt_tokens: 1, completion_tokens: 2 },
      new Date().toISOString(),
      harness.recorder,
      'trace-6',
      SESSION,
      Date.now(),
      null,
      null,
      undefined,
      'req-rs',
    );

    expect(fallbackSpy).toHaveBeenCalledWith(
      ctx,
      'primary-m',
      'simple',
      expect.objectContaining({ sessionKey: SESSION }),
    );
    harness.recorder.onModuleDestroy();
  });

  it('recordSuccess keeps threading sessionKey to the direct-success record', () => {
    const harness = buildRecorderHarness();
    const successSpy = jest.spyOn(harness.recorder, 'recordSuccessMessage');

    recordSuccess(
      ctx,
      metaStub({ fallbackFromModel: undefined }),
      { prompt_tokens: 1, completion_tokens: 2 },
      undefined,
      harness.recorder,
      'trace-7',
      SESSION,
      Date.now(),
      null,
      null,
      undefined,
      'req-rs2',
    );

    expect(successSpy).toHaveBeenCalledWith(
      ctx,
      'primary-m',
      'simple',
      'scored',
      expect.anything(),
      expect.objectContaining({ sessionKey: SESSION }),
    );
    harness.recorder.onModuleDestroy();
  });
});

describe('ProxyController error-path session threading', () => {
  let controller: ProxyController;
  let proxyService: { proxyRequest: jest.Mock };
  let rateLimiter: Record<string, jest.Mock>;
  let providerClient: Record<string, jest.Mock>;
  let recorder: ProxyMessageRecorder;
  let messageRows: Array<Record<string, unknown>>;
  let requestRows: Array<Record<string, unknown>>;
  let planService: { assertWithinRequestLimit: jest.Mock };
  let observationReporter: { report: jest.Mock };
  let recordingConfig: { isRecording: jest.Mock };
  let attemptRecording: { available: boolean; save: jest.Mock };

  function buildControllerHarness() {
    const h = buildRecorderHarness();
    messageRows = h.messageRows;
    requestRows = h.requestRows;
    recorder = h.recorder;
  }

  function mockRequest(
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    return {
      ingestionContext: {
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        agentName: 'test-agent',
        userId: 'user-1',
      },
      body,
      headers,
      ip: '127.0.0.1',
    };
  }

  function mockResponse() {
    return {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
      once: jest.fn(),
      writableEnded: false,
    };
  }

  async function flushRecorderMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    buildControllerHarness();
    proxyService = { proxyRequest: jest.fn() };
    planService = { assertWithinRequestLimit: jest.fn().mockResolvedValue(undefined) };
    rateLimiter = {
      checkLimit: jest.fn(),
      checkIpLimit: jest.fn(),
      acquireSlot: jest.fn(),
      releaseSlot: jest.fn(),
    };
    providerClient = {};
    observationReporter = { report: jest.fn() };
    recordingConfig = { isRecording: jest.fn().mockResolvedValue(false) };
    attemptRecording = { available: true, save: jest.fn().mockResolvedValue(undefined) };
    controller = new ProxyController(
      proxyService as never,
      rateLimiter as never,
      providerClient as never,
      recorder,
      new ThoughtSignatureCache(),
      new ThinkingBlockCache(),
      new ReasoningContentCache(),
      { getModelsForAgent: jest.fn().mockResolvedValue([]) } as never,
      planService as never,
      observationReporter as never,
      { getCapabilities: jest.fn().mockResolvedValue(null) } as never,
      { lookupModelCapabilities: jest.fn().mockReturnValue(null) } as never,
      recordingConfig as never,
      attemptRecording as never,
    );
  });

  afterEach(() => {
    recorder.onModuleDestroy();
  });

  it('persists session_key when a provider error terminates the request', async () => {
    const providerSpy = jest.spyOn(recorder, 'recordProviderError');
    proxyService.proxyRequest.mockRejectedValueOnce(new HttpException('upstream 502', 502));

    const req = mockRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-session-key': SESSION },
    );
    const res = mockResponse();
    await controller.chatCompletions(req as never, res as never);
    await flushRecorderMicrotasks();

    expect(providerSpy).toHaveBeenCalledWith(
      expect.anything(),
      502,
      expect.anything(),
      expect.objectContaining({ sessionKey: SESSION }),
    );
    expect(messageRows[0]).toMatchObject({ session_key: SESSION });
    expect(requestRows.at(-1)).toMatchObject({ session_key: SESSION });
  });

  it('persists session_key when the caller disconnects mid-request', async () => {
    const cancelSpy = jest.spyOn(recorder, 'recordCancelledRequest');
    proxyService.proxyRequest.mockImplementation(async () => {
      const close = (res.once as jest.Mock).mock.calls.find(
        ([event]: [string, unknown]) => event === 'close',
      );
      close?.[1]?.();
      throw new Error('caller gone');
    });

    const req = mockRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-session-key': SESSION },
    );
    const res = mockResponse();
    await controller.chatCompletions(req as never, res as never);
    await flushRecorderMicrotasks();

    expect(cancelSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionKey: SESSION }),
    );
    expect(requestRows.at(-1)).toMatchObject({ session_key: SESSION });
  });

  it('keeps session_key on the plan-limit blocked row', async () => {
    const blockedSpy = jest.spyOn(recorder, 'recordManifestBlockedRequest');
    planService.assertWithinRequestLimit.mockRejectedValueOnce(
      new HttpException('plan limit', 402),
    );

    const req = mockRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-session-key': SESSION },
    );
    const res = mockResponse();
    await expect(controller.chatCompletions(req as never, res as never)).rejects.toBeInstanceOf(
      HttpException,
    );
    await flushRecorderMicrotasks();

    expect(blockedSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionKey: SESSION,
        reason: 'plan_request_limit_exceeded',
      }),
    );
    expect(messageRows[0]).toMatchObject({ session_key: SESSION });
  });

  it('keeps session_key on the M500 blocked row and normalizes a literal default header', async () => {
    const blockedSpy = jest.spyOn(recorder, 'recordManifestBlockedRequest');
    proxyService.proxyRequest.mockRejectedValueOnce(new Error('routing bug'));

    const req = mockRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { 'x-session-key': 'default' },
    );
    const res = mockResponse();
    await controller.chatCompletions(req as never, res as never);
    await flushRecorderMicrotasks();

    expect(blockedSpy).toHaveBeenCalled();
    expect(messageRows[0]).toMatchObject({ session_key: null });
    expect(requestRows.at(-1)).toMatchObject({ session_key: null });
  });
});
