import { NotFoundException } from '@nestjs/common';

jest.mock('../utils/frontend-path', () => ({
  resolveFrontendDir: jest.fn(),
}));

const SAMPLE_HTML =
  '<html><head><meta property="og:url" content="https://app.manifest.build" />' +
  '<meta property="og:image" content="https://app.manifest.build/og-image.png" /></head>' +
  '<body>SPA</body></html>';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue(SAMPLE_HTML),
}));

import { resolveFrontendDir } from '../utils/frontend-path';

const mockResolveFrontendDir = resolveFrontendDir as jest.MockedFunction<typeof resolveFrontendDir>;

function createMockHost(method: string, url: string) {
  const json = jest.fn();
  const send = jest.fn();
  const setHeader = jest.fn();
  const status = jest.fn().mockReturnValue({ json, send });
  const res = { status, json, send, setHeader };
  const req = { method, originalUrl: url };

  return {
    host: {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    req,
    res,
  };
}

describe('SpaFallbackFilter', () => {
  const exception = new NotFoundException();

  // Must re-import after mock setup to pick up the mocked module
  function loadFilter(betterAuthUrl?: string) {
    jest.resetModules();
    jest.mock('../utils/frontend-path', () => ({
      resolveFrontendDir: mockResolveFrontendDir,
    }));
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: jest.fn().mockReturnValue(SAMPLE_HTML),
    }));
    const { SpaFallbackFilter } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./spa-fallback.filter') as typeof import('./spa-fallback.filter');
    return new SpaFallbackFilter(betterAuthUrl);
  }

  describe('when index.html exists', () => {
    let filter: ReturnType<typeof loadFilter>;

    beforeEach(() => {
      mockResolveFrontendDir.mockReturnValue('/mock/frontend');
      filter = loadFilter();
    });

    it('serves cached index.html content for GET to a deep SPA route', () => {
      const { host, res } = createMockHost('GET', '/agents/foo/routing');
      filter.catch(exception, host);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(SAMPLE_HTML);
    });

    it('returns a real 404 for an unknown SPA route instead of the 200 shell', () => {
      const { host, res } = createMockHost('GET', '/nonexistent-spa-route');
      filter.catch(exception, host);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
      const sent = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(sent).not.toBe(SAMPLE_HTML);
      expect(sent).toContain('404');
    });

    it('replaces the framework 404 body for GET to /api/ routes', () => {
      const frameworkNotFound = new NotFoundException('Cannot GET /api/v1/nonexistent');
      const { host, res } = createMockHost('GET', '/api/v1/nonexistent');
      filter.catch(frameworkNotFound, host);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'not_found' });
    });

    it('keeps an application-raised 404 message intact', () => {
      const appNotFound = new NotFoundException('wallet not found');
      const { host, res } = createMockHost('GET', '/api/v1/wallets/nope');
      filter.catch(appNotFound, host);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'wallet not found' }),
      );
    });

    it('returns JSON 404 for GET to /api/ routes', () => {
      const { host, res } = createMockHost('GET', '/api/v1/nonexistent');
      filter.catch(exception, host);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns JSON 404 for GET to /otlp/ routes', () => {
      const { host, res } = createMockHost('GET', '/otlp/v1/unknown');
      filter.catch(exception, host);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns JSON 404 for GET to /v1/ routes', () => {
      const { host, res } = createMockHost('GET', '/v1/something');
      filter.catch(exception, host);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns JSON 404 for GET to /assets/ routes (stale chunks)', () => {
      const { host, res } = createMockHost('GET', '/assets/MessageLog-vvlBBwmB.js');
      filter.catch(exception, host);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns JSON 404 for non-GET requests', () => {
      const { host, res } = createMockHost('POST', '/agents/foo');
      filter.catch(exception, host);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('og tag rewriting', () => {
    beforeEach(() => {
      mockResolveFrontendDir.mockReturnValue('/mock/frontend');
    });

    it('rewrites og: tags when BETTER_AUTH_URL is provided', () => {
      const filter = loadFilter('https://manifest.example.com');
      const { host, res } = createMockHost('GET', '/');
      filter.catch(exception, host);
      const sent = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(sent).toContain('content="https://manifest.example.com"');
      expect(sent).toContain('content="https://manifest.example.com/og-image.png"');
      expect(sent).not.toContain('https://app.manifest.build');
    });

    it('leaves og: tags alone when BETTER_AUTH_URL is empty', () => {
      const filter = loadFilter('');
      const { host, res } = createMockHost('GET', '/');
      filter.catch(exception, host);
      const sent = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(sent).toContain('content="https://app.manifest.build"');
    });

    it('falls back to process.env when no constructor arg is provided', () => {
      process.env['BETTER_AUTH_URL'] = 'https://from-env.example';
      const filter = loadFilter();
      const { host, res } = createMockHost('GET', '/');
      filter.catch(exception, host);
      const sent = (res.send as jest.Mock).mock.calls[0][0] as string;
      expect(sent).toContain('content="https://from-env.example"');
      delete process.env['BETTER_AUTH_URL'];
    });
  });

  describe('when index.html does not exist', () => {
    let filter: ReturnType<typeof loadFilter>;

    beforeEach(() => {
      mockResolveFrontendDir.mockReturnValue(null);
      filter = loadFilter();
    });

    it('returns JSON 404 even for GET to a deep SPA route', () => {
      const { host, res } = createMockHost('GET', '/agents/foo/routing');
      filter.catch(exception, host);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
