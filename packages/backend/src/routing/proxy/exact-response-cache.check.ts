// Standalone verification for RET-548 WP3 exact-response cache.
// Runs with node's native TS type-stripping (no build step needed):
//   node --test exact-response-cache.check.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExactResponseCache,
  ExactResponseCacheService,
  buildExactCacheKey,
  canonicalizeRequest,
  envFlagEnabled,
  isCacheableRequest,
} from './exact-response-cache';

test('flag parsing is fail-closed', () => {
  assert.equal(envFlagEnabled(undefined), false);
  assert.equal(envFlagEnabled('0'), false);
  assert.equal(envFlagEnabled('false'), false);
  assert.equal(envFlagEnabled('true'), true);
  assert.equal(envFlagEnabled('ON'), true);
});

test('canonicalization is key-order independent and value sensitive', () => {
  assert.equal(
    canonicalizeRequest({ a: 1, b: { d: 2, c: 3 } }),
    canonicalizeRequest({ b: { c: 3, d: 2 }, a: 1 }),
  );
  assert.notEqual(canonicalizeRequest({ a: 1 }), canonicalizeRequest({ a: '1' }));
  assert.notEqual(canonicalizeRequest({ m: [1, 2] }), canonicalizeRequest({ m: [2, 1] }));
});

test('keys differ across model/agent/tenant/body', () => {
  const base = { body: { x: 1 }, agentId: 'a', tenantId: 't' };
  const key = buildExactCacheKey({ ...base, model: 'm1' });
  assert.equal(buildExactCacheKey({ ...base, model: 'm1' }), key);
  assert.notEqual(buildExactCacheKey({ ...base, model: 'm2' }), key);
  assert.notEqual(buildExactCacheKey({ ...base, model: 'm1', agentId: 'b' }), key);
  assert.notEqual(buildExactCacheKey({ ...base, model: 'm1', tenantId: 'z' }), key);
  assert.notEqual(
    buildExactCacheKey({ model: 'm1', body: { x: 2 }, agentId: 'a', tenantId: 't' }),
    key,
  );
});

test('cacheability rules', () => {
  assert.equal(isCacheableRequest({ stream: true, x_manifest_exact_cache: true }), false);
  assert.equal(isCacheableRequest({ tools: [{}], x_manifest_exact_cache: true }), false);
  assert.equal(isCacheableRequest({ temperature: 0.7, x_manifest_exact_cache: true }), false);
  assert.equal(isCacheableRequest({}), false);
  assert.equal(isCacheableRequest({ x_manifest_exact_cache: true }), true);
});

test('TTL + bounded eviction', () => {
  let now = 1000;
  const cache = new ExactResponseCache({ ttlMs: 100, now: () => now });
  cache.set('k', { ok: true });
  assert.ok(cache.get('k'));
  now = 1200;
  assert.equal(cache.get('k'), undefined);
  const c2 = new ExactResponseCache({ maxEntries: 2, ttlMs: 10000 });
  c2.set('a', 1);
  c2.set('b', 2);
  c2.set('c', 3);
  assert.equal(c2.size, 2);
  assert.equal(c2.get('a'), undefined);
  assert.ok(c2.get('c'));
});

test('service is inert when disabled', () => {
  const svc = new ExactResponseCacheService(false);
  const req = { model: 'm', body: { x_manifest_exact_cache: true }, agentId: 'a' };
  svc.store(req, { answer: 1 });
  assert.equal(svc.lookup(req).hit, false);
});

test('service replays exact hits and refuses near misses', () => {
  const svc = new ExactResponseCacheService(true);
  const req = { model: 'm', body: { x_manifest_exact_cache: true, x: 1 }, agentId: 'a' };
  svc.store(req, { answer: 42 });
  const hit = svc.lookup(req);
  assert.equal(hit.hit, true);
  assert.deepEqual(hit.entry?.response, { answer: 42 });
  assert.equal(svc.lookup({ ...req, body: { x_manifest_exact_cache: true, x: 2 } }).hit, false);
});
