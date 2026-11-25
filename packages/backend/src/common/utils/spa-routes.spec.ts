import { isKnownSpaRoute, isServerPath } from './spa-routes';

describe('isServerPath', () => {
  it('treats API paths as server paths', () => {
    expect(isServerPath('/api')).toBe(true);
    expect(isServerPath('/api/v1/providers')).toBe(true);
    expect(isServerPath('/v1/chat/completions')).toBe(true);
    expect(isServerPath('/otlp/v1/traces')).toBe(true);
    expect(isServerPath('/assets/index.js')).toBe(true);
  });

  it('does not treat SPA paths as server paths', () => {
    expect(isServerPath('/')).toBe(false);
    expect(isServerPath('/overview')).toBe(false);
    expect(isServerPath('/apixyz')).toBe(false);
  });
});

describe('isKnownSpaRoute', () => {
  it('matches the static SPA routes', () => {
    for (const path of [
      '/',
      '/overview',
      '/messages',
      '/harnesses',
      '/playground',
      '/providers/subscriptions',
      '/providers/usage-based',
      '/providers/local',
      '/integrations/mcp',
      '/integrations/cli',
      '/connect-provider',
      '/account',
      '/wallets',
      '/wallets/settings',
      '/wallets/balancer',
      '/wallets/progress',
      '/upgrade',
      '/cli/auth',
      '/consent',
      '/oauth-error',
      '/login',
      '/register',
      '/reset-password',
      '/setup',
      '/discovery',
      '/welcome',
      '/quota',
    ]) {
      expect(isKnownSpaRoute(path)).toBe(true);
    }
  });

  it('matches parameterised SPA routes', () => {
    expect(isKnownSpaRoute('/providers/connections/abc-123')).toBe(true);
    expect(isKnownSpaRoute('/harnesses/my-agent')).toBe(true);
    expect(isKnownSpaRoute('/harnesses/my-agent/routing')).toBe(true);
    expect(isKnownSpaRoute('/harnesses/my-agent/settings')).toBe(true);
    expect(isKnownSpaRoute('/harnesses/my-agent/settings/api-keys')).toBe(true);
    expect(isKnownSpaRoute('/agents/my-agent')).toBe(true);
    expect(isKnownSpaRoute('/agents/my-agent/anything')).toBe(true);
  });

  it('rejects unknown paths', () => {
    expect(isKnownSpaRoute('/nonexistent-spa-route')).toBe(false);
    expect(isKnownSpaRoute('/overviews')).toBe(false);
    expect(isKnownSpaRoute('/harnesses/my-agent/nope')).toBe(false);
    expect(isKnownSpaRoute('/api/v1/does-not-exist-xyz')).toBe(false);
  });
});
