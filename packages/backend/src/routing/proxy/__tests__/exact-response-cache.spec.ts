import {
  EXACT_CACHE_ENV_FLAG,
  ExactResponseCache,
  ExactResponseCacheService,
  buildExactCacheKey,
  canonicalizeRequest,
  envFlagEnabled,
  isCacheableRequest,
} from './exact-response-cache';

describe('RET-548 WP3 exact-response cache', () => {
  describe('envFlagEnabled', () => {
    it('is off unless explicitly truthy', () => {
      expect(envFlagEnabled(undefined)).toBe(false);
      expect(envFlagEnabled('')).toBe(false);
      expect(envFlagEnabled('0')).toBe(false);
      expect(envFlagEnabled('false')).toBe(false);
      expect(envFlagEnabled('off')).toBe(false);
      expect(envFlagEnabled('maybe')).toBe(false);
    });

    it('accepts the explicit truthy set', () => {
      expect(envFlagEnabled('1')).toBe(true);
      expect(envFlagEnabled('true')).toBe(true);
      expect(envFlagEnabled('TRUE')).toBe(true);
      expect(envFlagEnabled('yes')).toBe(true);
      expect(envFlagEnabled('on')).toBe(true);
    });

    it('uses a dedicated env flag name', () => {
      expect(EXACT_CACHE_ENV_FLAG).toBe('MANIFEST_EXACT_CACHE_ENABLED');
    });
  });

  describe('canonicalizeRequest', () => {
    it('is key-order independent', () => {
      expect(canonicalizeRequest({ a: 1, b: { d: 2, c: 3 } })).toBe(
        canonicalizeRequest({ b: { c: 3, d: 2 }, a: 1 }),
      );
    });

    it('is value sensitive', () => {
      expect(canonicalizeRequest({ a: 1 })).not.toBe(canonicalizeRequest({ a: '1' }));
    });

    it('preserves array order', () => {
      expect(canonicalizeRequest({ m: [1, 2] })).not.toBe(canonicalizeRequest({ m: [2, 1] }));
    });
  });

  describe('buildExactCacheKey', () => {
    it('is stable for identical requests', () => {
      const a = buildExactCacheKey({ model: 'm', body: { x: 1, y: 2 }, agentId: 'a', tenantId: 't' });
      const b = buildExactCacheKey({ model: 'm', body: { y: 2, x: 1 }, agentId: 'a', tenantId: 't' });
      expect(a).toBe(b);
    });

    it('differs across model, agent and tenant', () => {
      const base = { body: { x: 1 }, agentId: 'a', tenantId: 't' };
      const key = buildExactCacheKey({ ...base, model: 'm1' });
      expect(buildExactCacheKey({ ...base, model: 'm2' })).not.toBe(key);
      expect(buildExactCacheKey({ ...base, model: 'm1', agentId: 'b' })).not.toBe(key);
      expect(buildExactCacheKey({ ...base, model: 'm1', tenantId: 'z' })).not.toBe(key);
    });

    it('differs for different bodies', () => {
      expect(
        buildExactCacheKey({ model: 'm', body: { x: 1 } }),
      ).not.toBe(buildExactCacheKey({ model: 'm', body: { x: 2 } }));
    });
  });

  describe('isCacheableRequest', () => {
    it('refuses streaming, tools and non-zero temperature', () => {
      expect(isCacheableRequest({ stream: true, 'x_manifest_exact_cache': true })).toBe(false);
      expect(isCacheableRequest({ tools: [{ a: 1 }], 'x_manifest_exact_cache': true })).toBe(false);
      expect(isCacheableRequest({ temperature: 0.7, 'x_manifest_exact_cache': true })).toBe(false);
    });

    it('requires an explicit opt-in marker', () => {
      expect(isCacheableRequest({})).toBe(false);
      expect(isCacheableRequest({ temperature: 0 })).toBe(false);
      expect(isCacheableRequest({ 'x_manifest_exact_cache': true })).toBe(true);
      expect(isCacheableRequest({ 'x_manifest_exact_cache': 'true' })).toBe(true);
    });
  });

  describe('ExactResponseCache', () => {
    it('expires entries', () => {
      let now = 1000;
      const cache = new ExactResponseCache({ ttlMs: 100, now: () => now });
      cache.set('k', { ok: true });
      expect(cache.get('k')).toBeDefined();
      now = 1200;
      expect(cache.get('k')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('bounds the entry count, evicting the oldest first', () => {
      const cache = new ExactResponseCache({ maxEntries: 2, ttlMs: 10_000 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size).toBe(2);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('c')).toBeDefined();
    });

    it('prunes expired entries', () => {
      let now = 0;
      const cache = new ExactResponseCache({ ttlMs: 10, now: () => now });
      cache.set('a', 1);
      now = 50;
      expect(cache.prune()).toBe(1);
      expect(cache.size).toBe(0);
    });
  });

  describe('ExactResponseCacheService', () => {
    it('never hits or stores when disabled', () => {
      const svc = new ExactResponseCacheService(false);
      const req = { model: 'm', body: { 'x_manifest_exact_cache': true }, agentId: 'a' };
      svc.store(req, { answer: 1 });
      expect(svc.lookup(req).hit).toBe(false);
      expect(svc.isEnabled()).toBe(false);
    });

    it('serves an exact replay when enabled', () => {
      const svc = new ExactResponseCacheService(true);
      const req = { model: 'm', body: { 'x_manifest_exact_cache': true }, agentId: 'a' };
      svc.store(req, { answer: 42 });
      const hit = svc.lookup(req);
      expect(hit.hit).toBe(true);
      expect(hit.entry?.response).toEqual({ answer: 42 });
    });

    it('does not serve a near miss', () => {
      const svc = new ExactResponseCacheService(true);
      svc.store({ model: 'm', body: { 'x_manifest_exact_cache': true, x: 1 } }, { answer: 1 });
      expect(
        svc.lookup({ model: 'm', body: { 'x_manifest_exact_cache': true, x: 2 } }).hit,
      ).toBe(false);
    });

    it('does not store non-cacheable requests', () => {
      const svc = new ExactResponseCacheService(true);
      const req = { model: 'm', body: { stream: true } };
      svc.store(req, { answer: 1 });
      expect(svc.lookup(req).hit).toBe(false);
    });
  });
});
