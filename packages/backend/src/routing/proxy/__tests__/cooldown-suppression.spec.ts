import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ProxyFallbackService } from '../proxy-fallback.service';
import { ProviderKeyService } from '../../routing-core/provider-key.service';
import { CustomProvider } from '../../../entities/custom-provider.entity';
import { OpenaiOauthService } from '../../oauth/openai/openai-oauth.service';
import { MinimaxOauthService } from '../../oauth/minimax/minimax-oauth.service';
import { AnthropicOauthService } from '../../oauth/anthropic/anthropic-oauth.service';
import { GeminiOauthService } from '../../oauth/gemini/gemini-oauth.service';
import { KiroOauthService } from '../../oauth/kiro/kiro-oauth.service';
import { XaiOauthService } from '../../oauth/xai/xai-oauth.service';
import { ProviderClient } from '../provider-client';
import { CopilotTokenService } from '../copilot-token.service';
import { ReasoningContentCache } from '../reasoning-content-cache';
import { ModelPricingCacheService } from '../../../model-prices/model-pricing-cache.service';
import { AgentModelParamsService } from '../../routing-core/agent-model-params.service';
import { ProviderParamSpecService } from '../../routing-core/provider-param-spec.service';
import { AutofixService } from '../../autofix/autofix.service';

/**
 * RET-647 scope 2b (D-2026-11-10-13): a transient 429 must never arm the
 * shared-route cooldown when the tier still has funded fallback hops — the
 * chain serves the same request, so a route corpse would only pause the
 * client. Tiers without a chain keep the cooldown (protects a dead tier's
 * provider from retry storms). Quota-class bodies keep the key-scoped halt
 * from the RET-647 core regardless of the chain.
 */
describe('RET-647 scope 2b: transient route-cooldown suppressed when the tier has funded fallback hops', () => {
  let service: ProxyFallbackService;

  const body = { messages: [{ role: 'user', content: 'Hello' }], stream: false };
  const baseOpts = {
    provider: 'openai',
    apiKey: 'sk-test-2b',
    model: 'gpt-4o',
    body,
    stream: false,
    sessionKey: 'sess-2b',
    authType: 'api_key',
    agentId: 'agent-2b',
    tenantId: 'tenant-2b',
    providerKeyLabel: 'Work',
  };
  const chain = [
    { provider: 'deepseek', authType: 'api_key' as const, model: 'deepseek-flash' },
  ];

  function rateLimitedForward() {
    return jest.fn().mockResolvedValue({
      response: new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
      isGoogle: false,
      isAnthropic: false,
      isChatGpt: false,
    });
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

    const providerKeyService = {
      getProviderApiKey: jest.fn().mockResolvedValue('sk-upstream'),
      getProviderKeyId: jest.fn().mockResolvedValue('up-fallback'),
      getDefaultKeyLabel: jest.fn().mockResolvedValue(undefined),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      findProviderForModel: jest.fn().mockResolvedValue(undefined),
      getProviderRegion: jest.fn().mockResolvedValue(null),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      selectProviderKey: jest.fn().mockResolvedValue({
        apiKey: 'sk-upstream',
        id: 'up-fallback',
        region: null,
        label: 'Work',
        priority: 0,
      }),
    } as unknown as jest.Mocked<ProviderKeyService>;

    const customProviderRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<CustomProvider>>;

    const oauth = () =>
      ({ unwrapToken: jest.fn().mockResolvedValue(null) }) as unknown as jest.Mocked<OpenaiOauthService>;

    const providerClient = {
      forward: jest.fn(),
    } as unknown as jest.Mocked<ProviderClient>;

    const copilotToken = {
      getCopilotToken: jest.fn().mockResolvedValue('tid=copilot-session-token'),
    } as unknown as jest.Mocked<CopilotTokenService>;

    const pricingCache = {
      getByModel: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<ModelPricingCacheService>;

    const modelParamsService = {
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      set: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<AgentModelParamsService>;

    const providerParamSpecs = {
      getSpecs: jest.fn().mockResolvedValue([]),
      list: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ProviderParamSpecService>;

    const reasoningCache = {
      prepareRequest: jest.fn(
        async (requestBody: Record<string, unknown>) => requestBody,
      ),
    };

    const autofixService = {
      isRepairable: jest.fn().mockReturnValue(false),
      maybeHeal: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<AutofixService>;

    service = new ProxyFallbackService(
      providerKeyService,
      customProviderRepo,
      oauth(),
      oauth() as unknown as MinimaxOauthService,
      oauth() as unknown as AnthropicOauthService,
      oauth() as unknown as GeminiOauthService,
      oauth() as unknown as KiroOauthService,
      oauth() as unknown as XaiOauthService,
      providerClient,
      copilotToken,
      pricingCache,
      modelParamsService,
      providerParamSpecs,
      reasoningCache as unknown as ReasoningContentCache,
      autofixService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does NOT arm a route cooldown when the tier has fallback hops', async () => {
    (service as unknown as { forwardToProvider: unknown }).forwardToProvider =
      rateLimitedForward();

    await service.tryForwardToProvider({ ...baseOpts, chainFallbacks: chain });

    expect((service as unknown as { rateLimitCooldowns: Map<string, number> }).rateLimitCooldowns.size).toBe(0);
  });

  it('arms the route cooldown as before when the tier has NO fallback hops', async () => {
    (service as unknown as { forwardToProvider: unknown }).forwardToProvider =
      rateLimitedForward();

    await service.tryForwardToProvider({ ...baseOpts });

    expect((service as unknown as { rateLimitCooldowns: Map<string, number> }).rateLimitCooldowns.size).toBe(1);
  });

  it('still key-halts a quota-halt body even when fallback hops exist', async () => {
    const flush = Math.floor(Date.now() / 1000) + 3600;
    (service as unknown as { forwardToProvider: unknown }).forwardToProvider =
      jest.fn().mockResolvedValue({
        response: new Response(
          JSON.stringify({ code: 1310, next_flush_time: flush }),
          { status: 429 },
        ),
        isGoogle: false,
        isAnthropic: false,
        isChatGpt: false,
      });

    await service.tryForwardToProvider({ ...baseOpts, chainFallbacks: chain });

    expect((service as unknown as { rateLimitCooldowns: Map<string, number> }).rateLimitCooldowns.size).toBe(0);
    const halts = (
      service as unknown as {
        keyQuotaHalts: {
          haltedUntil: (ref: Record<string, unknown>) => number | null;
        };
      }
    ).keyQuotaHalts;
    expect(
      halts.haltedUntil({
        tenantId: 'tenant-2b',
        provider: 'openai',
        authType: 'api_key',
        keyLabel: 'Work',
        model: 'gpt-4o',
        secret: 'sk-test-2b',
      }),
    ).toBeTruthy();
  });
});
