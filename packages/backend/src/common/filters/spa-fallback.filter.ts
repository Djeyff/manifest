import { ExceptionFilter, Catch, NotFoundException, ArgumentsHost } from '@nestjs/common';
import { Response, Request } from 'express';
import { join } from 'path';
import { readFileSync } from 'fs';
import { resolveFrontendDir } from '../utils/frontend-path';
import { rewriteOgTags } from '../utils/og-rewrite';
import { isKnownSpaRoute, isServerPath } from '../utils/spa-routes';

const NOT_FOUND_BODY = { error: 'not_found' } as const;

// A deliberately minimal 404 page: no framework signature, no stack traces,
// and no app shell that would need JavaScript to render.
const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>404 — Not found</title>
  </head>
  <body>
    <h1>404</h1>
    <p>That page does not exist.</p>
  </body>
</html>
`;

/**
 * Nest's default "no route matched" 404 carries the framework's own error
 * shape (`{"message":"Cannot GET /x","error":"Not Found","statusCode":404}`),
 * which tells an unauthenticated caller that the backend is NestJS/Express.
 * A 404 the application raises on purpose (for example "wallet not found")
 * must keep its message, so only the framework-generated one is replaced.
 */
function isFrameworkNotFound(response: unknown): boolean {
  if (typeof response !== 'object' || response === null) {
    return false;
  }
  const candidate = response as { message?: unknown; statusCode?: unknown };
  return (
    candidate.statusCode === 404 &&
    typeof candidate.message === 'string' &&
    /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(candidate.message)
  );
}

@Catch(NotFoundException)
export class SpaFallbackFilter implements ExceptionFilter {
  private readonly indexContent: string | null;

  constructor(betterAuthUrl?: string) {
    const frontendDir = resolveFrontendDir();
    const raw = frontendDir ? readFileSync(join(frontendDir, 'index.html'), 'utf-8') : null;
    const baseUrl = betterAuthUrl ?? process.env['BETTER_AUTH_URL'] ?? '';
    this.indexContent = raw ? rewriteOgTags(raw, baseUrl) : null;
  }

  catch(exception: NotFoundException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const pathname = (req.originalUrl || '/').split('?')[0].split('#')[0];

    if (req.method === 'GET' && this.indexContent && !isServerPath(pathname)) {
      if (isKnownSpaRoute(pathname)) {
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-cache');
        res.status(200).send(this.indexContent);
        return;
      }

      // Unknown path: a real 404, not a 200 soft page.
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-cache');
      res.status(404).send(NOT_FOUND_PAGE);
      return;
    }

    const response = exception.getResponse();
    if (isFrameworkNotFound(response)) {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }

    res.status(exception.getStatus()).json(response);
  }
}
