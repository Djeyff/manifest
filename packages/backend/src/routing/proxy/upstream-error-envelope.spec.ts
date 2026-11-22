import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { buildOpenAiCompatibleError } from './proxy-response-handler';
import { classifyUpstreamHint } from './proxy-error-sanitizer';

/**
 * RET-590 / D-2026-11-07-03 item2 — stable upstream error envelope.
 *
 * Upstream refusals must carry a stable, per-code classification downstream
 * automation can key on (`error.code` + `error.kind` + `error.hint` +
 * `error.retryable` + `error.retry_after_seconds`). The OpenAI-compatible
 * fields (`message`/`type`/`param`/`code`/`status`/`source`) are untouched —
 * the envelope additions are purely additive.
 */

describe('classifyUpstreamHint', () => {
  it('classifies a wallet 1113 wall as wallet, not retryable, with a funding hint', () => {
    const body = JSON.stringify({
      code: 1113,
      message: 'Insufficient balance or no resource package — please recharge',
    });
    const hint = classifyUpstreamHint(429, body);
    expect(hint?.kind).toBe('wallet');
    expect(hint?.retryable).toBe(false);
    expect(hint?.hint).toMatch(/wallet|balance|plan/i);
  });

  it('parses numeric-string and nested error.code shapes', () => {
    expect(classifyUpstreamHint(429, JSON.stringify({ error: { code: '1113' } }))?.kind).toBe(
      'wallet',
    );
    expect(
      classifyUpstreamHint(
        429,
        JSON.stringify({ code: '1311', message: 'plan does not yet include this model' }),
      )?.kind,
    ).toBe('plan_gate');
  });

  it('classifies 1311 as plan_gate, not retryable', () => {
    const hint = classifyUpstreamHint(429, JSON.stringify({ code: '1311', message: 'x' }));
    expect(hint?.kind).toBe('plan_gate');
    expect(hint?.retryable).toBe(false);
    expect(hint?.hint).toMatch(/plan|model/i);
  });

  it('classifies quota-window halt codes as quota_window, retryable after the window', () => {
    for (const code of [1308, 1310, 1316, 1321]) {
      const hint = classifyUpstreamHint(429, JSON.stringify({ code, next_flush_time: 1893456000 }));
      expect(hint?.kind).toBe('quota_window');
      expect(hint?.retryable).toBe(true);
      expect(hint?.hint).toMatch(/window|Retry-After|retry/i);
    }
  });

  it('classifies concurrency codes 1302/1305 as rate_limit, retryable', () => {
    for (const code of [1302, 1305]) {
      const hint = classifyUpstreamHint(
        429,
        JSON.stringify({ code: String(code), message: 'rate limit' }),
      );
      expect(hint?.kind).toBe('rate_limit');
      expect(hint?.retryable).toBe(true);
    }
  });

  it('derives rate_limit for a plain 429 with no usable code, server for 5xx', () => {
    expect(classifyUpstreamHint(429, 'plain text')?.kind).toBe('rate_limit');
    expect(classifyUpstreamHint(500, '<html>boom</html>')?.kind).toBe('server');
    expect(classifyUpstreamHint(500, '')?.retryable).toBe(true);
    expect(classifyUpstreamHint(401, 'Unauthorized')).toBeNull();
    expect(classifyUpstreamHint(400, '{"x":1}')).toBeNull();
  });

  it('falls back to the status class for unknown numeric codes; null below 400', () => {
    expect(classifyUpstreamHint(429, JSON.stringify({ code: '9999' }))?.kind).toBe('rate_limit');
    expect(classifyUpstreamHint(200, JSON.stringify({ code: 1113 }))).toBeNull();
  });
});

describe('buildOpenAiCompatibleError stable envelope additions', () => {
  const PREV_NODE_ENV = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = PREV_NODE_ENV;
  });

  it('429 wallet body: stable kind/hint/retryable alongside untouched OpenAI fields', () => {
    const body = JSON.stringify({
      code: '1113',
      message: 'Insufficient balance or no resource package — please recharge',
    });
    const err = buildOpenAiCompatibleError(429, body, {
      provider: 'zai',
      model: 'glm-5.3-flash',
    });
    expect(err.code).toBe('1113');
    expect(err.kind).toBe('wallet');
    expect(err.retryable).toBe(false);
    expect(err.hint).toMatch(/wallet|balance|plan/i);
    expect(err.type).toBe('rate_limit_error');
    expect(err.status).toBe(429);
    expect(err.source).toBe('provider');
    expect(err.provider).toBe('zai');
    expect(err.model).toBe('glm-5.3-flash');
    expect(err.message).toMatch(/Insufficient balance/i);
    expect(err.retry_after_seconds).toBeUndefined();
  });

  it('429 quota-window halt: retry_after_seconds rides in the body (header parity)', () => {
    const body = JSON.stringify({ code: 1310, next_flush_time: 1893456000 });
    const err = buildOpenAiCompatibleError(429, body, { retryAfterSeconds: 600 });
    expect(err.kind).toBe('quota_window');
    expect(err.retryable).toBe(true);
    expect(err.retry_after_seconds).toBe(600);
    expect(err.code).toBe('1310');
  });

  it('unstructured 5xx wall: stable server kind + hint, endpoint message kept', () => {
    const err = buildOpenAiCompatibleError(502, '<html>bad gateway</html>', {});
    expect(err.kind).toBe('server');
    expect(err.retryable).toBe(true);
    expect(typeof err.hint).toBe('string');
    expect(err.hint).toMatch(/backoff|back off|retry/i);
    expect(err.message).toBe('Upstream endpoint returned HTTP 502');
  });

  it('plain 429 without a code: rate_limit kind, null-carrying stable shape', () => {
    const err = buildOpenAiCompatibleError(429, 'plain text', {});
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(typeof err.hint).toBe('string');
    expect(err.code).toBeNull();
  });

  it('non-wall 4xx keeps kind/hint null (no invented classes)', () => {
    const body = JSON.stringify({ error: { message: 'Invalid model', code: 'model_not_found' } });
    const err = buildOpenAiCompatibleError(404, body, {});
    expect(err.kind).toBeNull();
    expect(err.hint).toBeNull();
    expect(err.retryable).toBeNull();
    expect(err.code).toBe('model_not_found');
    expect(err.type).toBe('invalid_request_error');
  });
});
