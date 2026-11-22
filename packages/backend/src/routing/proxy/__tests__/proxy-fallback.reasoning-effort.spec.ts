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
import { getProviderParamSpecs, type ProviderParamSpecCatalog } from 'manifest-shared';

// Keep stalled-stream fallback tests fast; only the fallback chain reads it.
jest.mock('../stream-warmup', () => ({
  ...jest.requireActual('../stream-warmup'),
  STREAM_WARMUP_MS: 50,
}));

// glm-5.3: a model whose catalog DECLARES the reasoning-effort knob.
const specCatalog: ProviderParamSpecCatalog = [
  {
    provider: 'z-ai',
    authType: 'api_key',
    model: 'glm-5.3',
    params: [
      {
        path: 'reasoning_effort',
        type: 'enum',
        label: 'Reasoning effort',
        description: 'How hard the model reasons.',
        values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        group: 'reasoning',
      },
      {
        path: 'temperature',
        type: 'number',
        label: 'Temperature',
        description: 'Sampling temperature.',
        group: 'sampling',
      },
    ],
  },
];

const okForward = () => ({
  response: new Response('{}', { status: 200 }),
  isGoogle: false,
  isAnthropic: false,
  isChatGpt: false,
});

describe('ProxyFallbackService reasoning-effort injection', () => {
  let service: ProxyFallbackService;
  let providerClient: jest.Mocked<ProviderClient>;
  let modelParamsService: jest.Mocked<AgentModelParamsService>;
  let providerParamSpecs: jest.Mocked<ProviderParamSpecService>;

  beforeEach(() => {
    const providerKeyService = {
      getProviderApiKey: jest.fn().mockResolvedValue('sk-test-key'),
      getProviderKeyId: jest.fn().mockResolvedValue('up-fallback'),
      getDefaultKeyLabel: jest.fn().mockResolvedValue(undefined),
      getAuthType: jest.fn().mockResolvedValue('api_key'),
      findProviderForModel: jest.fn().mockResolvedValue(undefined),
      getProviderRegion: jest.fn().mockResolvedValue(null),
      hasActiveProvider: jest.fn().mockResolvedValue(true),
      selectProviderKey: jest.fn().mockResolvedValue({
        apiKey: 'sk-test-key',
        id: 'up-fallback',
        region: null,
        label: 'Default',
        priority: 0,
      }),
    } as unknown as jest.Mocked<ProviderKeyService>;

    const customProviderRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<Repository<CustomProvider>>;

    const oauth = <T>(): jest.Mocked<T> =>
      ({ unwrapToken: jest.fn().mockResolvedValue(null) }) as unknown as jest.Mocked<T>;

    providerClient = {
      forward: jest.fn(),
    } as unknown as jest.Mocked<ProviderClient>;

    const copilotToken = {
      getCopilotToken: jest.fn().mockResolvedValue('tid=copilot-session-token'),
    } as unknown as jest.Mocked<CopilotTokenService>;

    const pricingCache = {
      getByModel: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<ModelPricingCacheService>;

    modelParamsService = {
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      set: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<AgentModelParamsService>;

    providerParamSpecs = {
      getSpecs: jest.fn(async (provider: string, authType: string, model: string) =>
        getProviderParamSpecs(specCatalog, provider, authType as 'api_key' | 'subscription', model),
      ),
      list: jest.fn().mockResolvedValue(specCatalog),
    } as unknown as jest.Mocked<ProviderParamSpecService>;

    const reasoningCache = {
      prepareRequest: jest.fn(
        async (
          requestBody: Record<string, unknown>,
          _sessionKey: string,
          _endpointKey: string | null,
          _model: string,
        ) => requestBody,
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
      oauth(),
      oauth(),
      oauth(),
      oauth(),
      oauth(),
      providerClient,
      copilotToken,
      pricingCache,
      modelParamsService,
      providerParamSpecs,
      reasoningCache as unknown as ReasoningContentCache,
      autofixService,
    );
  });

  const forwardedBody = (): Record<string, unknown> =>
    (providerClient.forward.mock.calls[0][0] as { body: Record<string, unknown> }).body;

  const forward = (overrides: Record<string, unknown> = {}) =>
    service.tryForwardToProvider({
      provider: 'z-ai',
      apiKey: 'sk-test-key',
      model: 'glm-5.3',
      body: {
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      },
      stream: false,
      sessionKey: 'sess-1',
      authType: 'api_key',
      paramMergeContext: { agentId: 'agent-1', scopeKey: 'tier:big' },
      ...overrides,
    });

  it('tier=max reaches upstream even when the client sent high', async () => {
    providerClient.forward.mockResolvedValue(okForward());
    await forward({
      paramMergeContext: {
        agentId: 'agent-1',
        scopeKey: 'tier:big',
        tierReasoningEffort: 'max',
      },
    });
    expect(forwardedBody().reasoning_effort).toBe('max');
  });

  it('hop effort beats the tier effort', async () => {
    providerClient.forward.mockResolvedValue(okForward());
    await forward({
      paramMergeContext: {
        agentId: 'agent-1',
        scopeKey: 'tier:big',
        tierReasoningEffort: 'max',
      },
      hopReasoningEffort: 'xhigh',
    });
    expect(forwardedBody().reasoning_effort).toBe('xhigh');
  });

  it('tier without effort keeps the client value', async () => {
    providerClient.forward.mockResolvedValue(okForward());
    await forward({
      paramMergeContext: {
        agentId: 'agent-1',
        scopeKey: 'tier:big',
        tierReasoningEffort: null,
      },
    });
    expect(forwardedBody().reasoning_effort).toBe('high');
  });

  it('panel value beats the client value when no tier/hop effort is set', async () => {
    providerClient.forward.mockResolvedValue(okForward());
    modelParamsService.get.mockResolvedValue({ reasoning_effort: 'medium' } as never);
    await forward({
      paramMergeContext: {
        agentId: 'agent-1',
        scopeKey: 'tier:big',
        tierReasoningEffort: null,
      },
    });
    expect(forwardedBody().reasoning_effort).toBe('medium');
  });

  it('does not inject or override on a model whose catalog has no reasoning-effort knob', async () => {
    providerClient.forward.mockResolvedValue(okForward());
    await service.tryForwardToProvider({
      provider: 'z-ai',
      apiKey: 'sk-test-key',
      model: 'gpt-4o',
      body: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      },
      stream: false,
      sessionKey: 'sess-1',
      authType: 'api_key',
      paramMergeContext: {
        agentId: 'agent-1',
        scopeKey: 'tier:big',
        tierReasoningEffort: 'max',
      },
    });
    // No injection (catalog has no knob); the client-sent value passes
    // through untouched — provider wire translation owns stripping it.
    expect(forwardedBody().reasoning_effort).toBe('high');
  });
});
