/**
 * The set of client-side routes the SPA owns.
 *
 * The backend serves `index.html` for any GET it cannot route, so a typo'd
 * path used to answer 200 with the SPA shell (a soft 404: crawlers and
 * monitors saw a healthy page for a path that does not exist). To answer a
 * real 404 for unknown paths, the server needs to know which paths ARE real
 * app routes — that list lives in the frontend router
 * (`packages/frontend/src/index.tsx`).
 *
 * Keep the two in sync: every `path=` in the frontend router tree needs a
 * matching pattern here, otherwise that page answers 404 instead of loading.
 *
 * Pattern syntax:
 *   - a literal segment matches itself
 *   - `:name` matches exactly one segment (a route param)
 *   - a trailing `*` matches the rest of the path (a splat route)
 */
export const SPA_ROUTE_PATTERNS: readonly string[] = [
  '/',
  '/overview',
  '/messages',
  '/harnesses',
  '/harnesses/:agentName',
  '/harnesses/:agentName/limits',
  '/harnesses/:agentName/messages',
  '/harnesses/:agentName/overview',
  '/harnesses/:agentName/routing',
  '/harnesses/:agentName/providers',
  '/harnesses/:agentName/guardrails',
  '/harnesses/:agentName/settings/*',
  '/harnesses/:agentName/model-prices',
  '/harnesses/:agentName/free-models',
  '/harnesses/:agentName/help',
  '/playground',
  '/providers/subscriptions',
  '/providers/usage-based',
  '/providers/local',
  '/providers/connections/:connectionId',
  '/integrations/mcp',
  '/integrations/cli',
  // Legacy /agents bookmarks redirect to /harnesses.
  '/agents',
  '/agents/:agentName/*',
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
  // Public probe path kept answering the SPA shell before this change; it is
  // listed here so it keeps doing so.
  '/health',
];

/**
 * Paths that belong to the server, not the SPA. A 404 on these must never
 * fall back to the SPA shell, and must never leak the framework's own error
 * shape.
 */
export const SERVER_PATH_PREFIXES: readonly string[] = [
  '/api',
  '/v1',
  '/otlp',
  '/assets',
  '/.well-known',
];

export function isServerPath(pathname: string): boolean {
  return SERVER_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function matchesPattern(pathname: string, pattern: string): boolean {
  if (pattern === pathname) {
    return true;
  }
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);

  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    if (patternSegment === '*') {
      // A splat matches the remaining segments, including none at all.
      return true;
    }
    if (i >= pathSegments.length) {
      return false;
    }
    if (patternSegment.startsWith(':')) {
      // A route param matches any single non-empty segment.
      if (pathSegments[i] === '') {
        return false;
      }
      continue;
    }
    if (patternSegment !== pathSegments[i]) {
      return false;
    }
  }

  return pathSegments.length === patternSegments.length;
}

/**
 * True when the path is one of the SPA's own routes (see
 * {@link SPA_ROUTE_PATTERNS}).
 */
export function isKnownSpaRoute(pathname: string): boolean {
  return SPA_ROUTE_PATTERNS.some((pattern) => matchesPattern(pathname, pattern));
}
