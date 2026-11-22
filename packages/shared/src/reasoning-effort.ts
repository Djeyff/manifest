import {
  applyRequestParamDefaults,
  type JsonValue,
  type RequestParamDefaults,
} from './request-params';
import type { ProviderParamSpec } from './provider-params-spec';

/**
 * Canonical reasoning-effort values, ordered from cheapest to most expensive.
 * Mirrors the MPS catalog enum for the models that accept the knob
 * (e.g. `z-ai` / `glm-5.3`).
 */
export const REASONING_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

/** Storage/param path of the reasoning-effort knob (matches the MPS spec path). */
export const REASONING_EFFORT_PARAM_PATH = 'reasoning_effort';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === 'string' && (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Precedence inputs for the effective reasoning effort of one attempt.
 * Highest priority first:
 *  1. `hop`   — effort carried by the route object used for THIS attempt
 *  2. `tier`  — effort carried by the tier's `override_route`
 *  3. `panel` — the value saved in the Model-parameters panel
 *  4. `client`— the value the client sent in the request body
 */
export interface ReasoningEffortSources {
  hop?: string | null;
  tier?: string | null;
  panel?: string | null;
  client?: string | null;
}

/**
 * Resolve the effective reasoning effort. The first source that carries a
 * known effort value wins; unknown/missing values fall through to the next
 * source. Returns null when no source supplies a usable value.
 */
export function resolveReasoningEffort(sources: ReasoningEffortSources): ReasoningEffort | null {
  const ordered = [sources.hop, sources.tier, sources.panel, sources.client];
  for (const candidate of ordered) {
    if (isReasoningEffort(candidate)) return candidate;
  }
  return null;
}

/**
 * Does this route's param spec list accept the reasoning-effort knob? Only
 * models whose catalog entry declares the knob may receive it on the wire —
 * every other model would reject or silently drop the field.
 */
export function supportsReasoningEffort(specs: readonly ProviderParamSpec[]): boolean {
  return specs.some((spec) => spec.path === REASONING_EFFORT_PARAM_PATH);
}

/**
 * The effective reasoning effort for one attempt given the hop/tier override
 * sources, the panel's saved values and the inbound body. Returns null when
 * the model's spec list has no reasoning-effort knob (nothing may be
 * injected) or when no source supplies a usable value.
 *
 * This is the single resolution used BOTH by the wire merge (see
 * {@link applyRequestParamsWithEffort}) and by the request-params snapshot,
 * so what `agent_messages.request_params` records is exactly what the
 * provider received.
 */
export function resolveEffectiveReasoningEffort(
  body: Record<string, unknown>,
  defaults: RequestParamDefaults | null | undefined,
  specs: readonly ProviderParamSpec[],
  sources: Pick<ReasoningEffortSources, 'hop' | 'tier'>,
): ReasoningEffort | null {
  if (!supportsReasoningEffort(specs)) return null;
  const panelValue = defaults ? getParamValue(defaults, REASONING_EFFORT_PARAM_PATH) : undefined;
  const clientValue = getParamValue(body, REASONING_EFFORT_PARAM_PATH);
  return resolveReasoningEffort({
    hop: sources.hop,
    tier: sources.tier,
    panel: typeof panelValue === 'string' ? panelValue : null,
    client: typeof clientValue === 'string' ? clientValue : null,
  });
}

/**
 * Merge the Model-parameters panel values into the outgoing body and then
 * apply the effective reasoning effort on top.
 *
 * The effort override is applied LAST so a tier/hop value wins over both the
 * panel value and the value the client sent (`Tier=max` must reach upstream
 * even when the client asked for `high`).
 */
export function applyRequestParamsWithEffort<T extends Record<string, unknown>>(
  body: T,
  defaults: RequestParamDefaults | null | undefined,
  specs: readonly ProviderParamSpec[],
  sources: ReasoningEffortSources,
): T {
  const merged = applyRequestParamDefaults(body, defaults, specs);
  const effort = resolveEffectiveReasoningEffort(body, defaults, specs, {
    hop: sources.hop,
    tier: sources.tier,
  });
  if (!effort) return merged;
  return { ...merged, [REASONING_EFFORT_PARAM_PATH]: effort } as T;
}

function getParamValue(values: Record<string, unknown>, path: string): unknown {
  let current: unknown = values;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export type { JsonValue };
