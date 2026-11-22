import type { ProviderParamSpec } from '../src/provider-params-spec';
import type { RequestParamDefaults } from '../src/request-params';
import {
  REASONING_EFFORT_PARAM_PATH,
  applyRequestParamsWithEffort,
  resolveEffectiveReasoningEffort,
  resolveReasoningEffort,
  supportsReasoningEffort,
} from '../src/reasoning-effort';
import { snapshotRequestParams } from '../src/request-params-snapshot';

const EFFORT_SPEC: ProviderParamSpec = {
  provider: 'z-ai',
  authType: 'api_key',
  model: 'glm-5.3',
  path: REASONING_EFFORT_PARAM_PATH,
  type: 'enum',
  label: 'Reasoning effort',
  description: 'How hard the model reasons.',
  values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  group: 'reasoning',
};

const TEMP_SPEC: ProviderParamSpec = {
  provider: 'z-ai',
  authType: 'api_key',
  model: 'glm-5.3',
  path: 'temperature',
  type: 'number',
  label: 'Temperature',
  description: 'Sampling temperature.',
  group: 'sampling',
};

/** Specs for a model that accepts the knob (e.g. glm-5.3 family). */
const specs: readonly ProviderParamSpec[] = [TEMP_SPEC, EFFORT_SPEC];

/** Specs for a model whose catalog has no reasoning-effort knob. */
const noEffortSpecs: readonly ProviderParamSpec[] = [TEMP_SPEC];

describe('resolveReasoningEffort', () => {
  it('applies precedence hop > tier > panel > client', () => {
    expect(
      resolveReasoningEffort({ hop: 'xhigh', tier: 'max', panel: 'low', client: 'high' }),
    ).toBe('xhigh');
    expect(resolveReasoningEffort({ tier: 'max', panel: 'low', client: 'high' })).toBe('max');
    expect(resolveReasoningEffort({ panel: 'low', client: 'high' })).toBe('low');
    expect(resolveReasoningEffort({ client: 'high' })).toBe('high');
  });

  it('falls through unknown values to the next source', () => {
    expect(resolveReasoningEffort({ hop: 'ultra', tier: 'max', client: 'high' })).toBe('max');
    expect(resolveReasoningEffort({ hop: 'ultra', tier: 'ultra' })).toBeNull();
  });
});

describe('supportsReasoningEffort', () => {
  it('is true only when the catalog declares the knob', () => {
    expect(supportsReasoningEffort(specs)).toBe(true);
    expect(supportsReasoningEffort(noEffortSpecs)).toBe(false);
  });
});

describe('applyRequestParamsWithEffort', () => {
  const body = (effort?: string) => ({
    model: 'z-ai/glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    ...(effort ? { [REASONING_EFFORT_PARAM_PATH]: effort } : {}),
  });

  it('tier=max reaches upstream even when the client sent high', () => {
    const out = applyRequestParamsWithEffort(body('high'), null, specs, { tier: 'max' });
    expect(out[REASONING_EFFORT_PARAM_PATH]).toBe('max');
  });

  it('hop effort beats the tier effort', () => {
    const out = applyRequestParamsWithEffort(body('high'), null, specs, {
      hop: 'xhigh',
      tier: 'max',
    });
    expect(out[REASONING_EFFORT_PARAM_PATH]).toBe('xhigh');
  });

  it('tier without effort keeps the client value', () => {
    const out = applyRequestParamsWithEffort(body('high'), null, specs, { tier: null });
    expect(out[REASONING_EFFORT_PARAM_PATH]).toBe('high');
  });

  it('tier without effort and no client value injects nothing', () => {
    const out = applyRequestParamsWithEffort(body(), null, specs, { tier: null });
    expect(REASONING_EFFORT_PARAM_PATH in out).toBe(false);
  });

  it('panel value is used when neither tier nor hop sets one (and beats the client)', () => {
    const panel = { [REASONING_EFFORT_PARAM_PATH]: 'medium' } as RequestParamDefaults;
    const out = applyRequestParamsWithEffort(body('high'), panel, specs, {});
    expect(out[REASONING_EFFORT_PARAM_PATH]).toBe('medium');
  });

  it('does not inject or override on a model whose catalog has no reasoning-effort knob', () => {
    const out = applyRequestParamsWithEffort(body('high'), null, noEffortSpecs, { tier: 'max' });
    // The tier effort must NOT be injected for knob-less models; the
    // client-sent value passes through untouched (provider wire translation
    // owns stripping it for providers that reject the field).
    expect(out[REASONING_EFFORT_PARAM_PATH]).toBe('high');
  });
});

describe('resolveEffectiveReasoningEffort', () => {
  it('returns null when the model has no knob', () => {
    expect(
      resolveEffectiveReasoningEffort({}, null, noEffortSpecs, { hop: 'max', tier: 'max' }),
    ).toBeNull();
  });

  it('resolves the same value the wire merge injects', () => {
    const body = { [REASONING_EFFORT_PARAM_PATH]: 'high' };
    expect(
      resolveEffectiveReasoningEffort(body, null, specs, { hop: null, tier: 'max' }),
    ).toBe('max');
  });
});

describe('snapshotRequestParams reasoning-effort recording', () => {
  it('records the injected effort even when the catalog would drop it', () => {
    const snapshot = snapshotRequestParams({
      body: { model: 'm', messages: [] },
      modelParams: null,
      specs: noEffortSpecs,
      reasoningEffort: 'max',
    });
    expect(snapshot).toEqual({ [REASONING_EFFORT_PARAM_PATH]: 'max' });
  });

  it('records the effective effort over the client-sent value', () => {
    const snapshot = snapshotRequestParams({
      body: { model: 'm', messages: [], [REASONING_EFFORT_PARAM_PATH]: 'high' },
      modelParams: null,
      specs,
      reasoningEffort: 'max',
    });
    expect(snapshot?.[REASONING_EFFORT_PARAM_PATH]).toBe('max');
  });

  it('still records the client-sent value when nothing was injected', () => {
    const snapshot = snapshotRequestParams({
      body: { model: 'm', messages: [], [REASONING_EFFORT_PARAM_PATH]: 'high' },
      modelParams: null,
      specs,
    });
    expect(snapshot?.[REASONING_EFFORT_PARAM_PATH]).toBe('high');
  });
});
