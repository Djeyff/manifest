import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProviderClient } from '../provider-client';
import { PROVIDER_ENDPOINTS } from '../provider-endpoints';

/**
 * MiniMax M3.x rejects the reasoning tier `none` upstream with error 2013
 * ("requires adaptive thinking; reasoning effort none is not allowed"). The
 * fake upstream below reproduces that contract exactly: any body that still
 * carries the tier `none` (as `reasoning_effort` or as
 * `output_config.effort`) is answered with 400/2013, every other body is
 * answered with 200.
 *
 * The gateway must therefore never let a `none` tier reach a MiniMax leg,
 * whichever protocol that leg speaks.
 */
describe('MiniMax reasoning effort none (2013 guard)', () => {
  let server: Server;
  let baseUrl: string;
  let received: { path: string; body: Record<string, any> }[];
  const previousMode = process.env.MANIFEST_MODE;
  const client = new ProviderClient();
  const endpoints = ['minimax', 'minimax-subscription'];
  const originals = new Map(endpoints.map((key) => [key, PROVIDER_ENDPOINTS[key]]));

  beforeAll(async () => {
    process.env.MANIFEST_MODE = 'selfhosted';
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ path: req.url!, body });
      const tier = body.reasoning_effort ?? body.output_config?.effort;
      if (tier === 'none') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking; reasoning effort none is not allowed (2013)',
            },
          }),
        );
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.url!.endsWith('/messages')
            ? {
                id: 'msg-test',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              }
            : {
                id: 'chat-test',
                object: 'chat.completion',
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const key of endpoints) {
      PROVIDER_ENDPOINTS[key] = {
        ...originals.get(key)!,
        baseUrl: key === 'minimax-subscription' ? `${baseUrl}/anthropic/v1` : baseUrl,
      };
    }
  });
  beforeEach(() => {
    received = [];
  });
  afterAll(async () => {
    for (const key of endpoints) PROVIDER_ENDPOINTS[key] = originals.get(key)!;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (previousMode === undefined) delete process.env.MANIFEST_MODE;
    else process.env.MANIFEST_MODE = previousMode;
  });

  it('answers 200 on the OpenAI-compatible leg when the tier is none', async () => {
    const response = await client.forward({
      provider: 'minimax',
      apiKey: 'test-...et',
      model: 'MiniMax-M3.1-Flash',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 512,
        reasoning_effort: 'none',
      },
      stream: false,
    });
    expect(response.response.ok).toBe(true);
    expect(received[0].body.reasoning_effort).not.toBe('none');
  });

  it('answers 200 on the subscription (Anthropic messages) leg when the tier is none', async () => {
    const response = await client.forward({
      provider: 'minimax',
      authType: 'subscription',
      apiKey: 'test-...et',
      model: 'MiniMax-M3.1-Flash',
      apiMode: 'messages',
      customEndpoint: PROVIDER_ENDPOINTS['minimax-subscription'],
      stream: false,
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 512,
        reasoning_effort: 'none',
      },
    });
    expect(response.response.ok).toBe(true);
    expect(received[0].path).toBe('/anthropic/v1/messages');
    expect(received[0].body.output_config?.effort ?? 'low').not.toBe('none');
    expect(received[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('passes the legal tiers through unchanged', async () => {
    for (const tier of ['low', 'medium', 'high']) {
      received = [];
      const response = await client.forward({
        provider: 'minimax',
        apiKey: 'test-...et',
        model: 'MiniMax-M3.1-Flash',
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 512,
          reasoning_effort: tier,
        },
        stream: false,
      });
      expect(response.response.ok).toBe(true);
      expect(received[0].body.reasoning_effort).toBe(tier);
    }
  });

  it('passes the legal tiers through unchanged on the subscription leg', async () => {
    for (const tier of ['low', 'medium', 'high']) {
      received = [];
      const response = await client.forward({
        provider: 'minimax',
        authType: 'subscription',
        apiKey: 'test-...et',
        model: 'MiniMax-M3.1-Flash',
        apiMode: 'messages',
        customEndpoint: PROVIDER_ENDPOINTS['minimax-subscription'],
        stream: false,
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 512,
          reasoning_effort: tier,
        },
      });
      expect(response.response.ok).toBe(true);
      expect(received[0].body.output_config.effort).toBe(tier);
    }
  });
});
