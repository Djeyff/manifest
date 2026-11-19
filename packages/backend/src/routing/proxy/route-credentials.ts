/**
 * Shared route-credential resolution and local credential-failure attempts.
 *
 * Primary proxy and mid-chain fallbacks must agree on:
 *  - how a route becomes a usable apiKey (or why it cannot)
 *  - which Manifest code/message that maps to (M100 vs M102)
 *  - how that failure appears as a recorded attempt on the Manifest request
 *
 * Keep new credential failure kinds here — callers should not re-implement
 * selectProviderKey → resolveApiKey or invent parallel error text.
 */
import type { AuthType } from 'manifest-shared';
import {
  ProviderKeyService,
  SYNTHETIC_OLLAMA_PROVIDER_ID,
} from '../routing-core/provider-key.service';
import { formatManifestError, type ManifestErrorCode } from '../../common/errors/error-codes';
import type { ManifestBlockedRequestReason } from '../../common/errors/manifest-error';
import {
  isRefreshableOAuthCredential,
  resolveApiKey,
  type OAuthServiceSet,
} from './oauth-credentials';
import type { ForwardResult } from './provider-client';
import type { ProviderAttemptRef, StartProviderAttempt } from './proxy-types';
import {
  orderCandidates,
  walletBudgetMessage,
  WALLET_BUDGET_HTTP_STATUS,
  type WalletBudgetConfig,
  type WalletBudgetDecision,
  type WalletBudgetGate,
  type WalletGateCallerContext,
  type WalletSpend,
} from './wallet-budget';

/** Why a route could not produce a usable provider apiKey. */
export type CredentialFailureReason = Extract<
  ManifestBlockedRequestReason,
  'no_provider_key' | 'subscription_credentials_unusable' | 'limit_exceeded'
>;

const CREDENTIAL_FAILURE_CODE: Record<
  CredentialFailureReason,
  Extract<ManifestErrorCode, 'M100' | 'M102' | 'M200'>
> = {
  no_provider_key: 'M100',
  subscription_credentials_unusable: 'M102',
  limit_exceeded: 'M200',
};

/** HTTP status for local credential failures so shouldTriggerFallback still fires. */
export const CREDENTIAL_FAILURE_HTTP_STATUS = 401;

export type ResolvedRouteCredentials =
  | {
      ok: true;
      apiKey: string;
      rawApiKey: string;
      resourceUrl?: string;
      providerRegion?: string | null;
      tenantProviderId: string | null;
      /**
       * Label of the `tenant_providers` row that was actually selected — the
       * same row `tenantProviderId` points at, never the requested pin. A pin
       * that matched nothing falls back to the default key, and the recorded
       * label has to name the connection that really served the call.
       */
      keyLabel: string;
    }
  | {
      ok: false;
      reason: CredentialFailureReason;
      tenantProviderId: string | null;
      /**
       * Pre-built presentation for reasons that carry their own variables
       * (wallet-budget M200s name the wallet, rule, and spend vs line).
       * Callers fall back to presentCredentialFailure(reason, …) when absent.
       */
      presentation?: CredentialFailurePresentation;
    };

export interface CredentialFailurePresentation {
  code: Extract<ManifestErrorCode, 'M100' | 'M102' | 'M200'>;
  reason: CredentialFailureReason;
  message: string;
  status: number;
  errorBody: string;
  /**
   * The wallet row the receipt names (the blocked wallet), when the
   * wallet-budget gate produced the failure — recorded attempt stamping
   * uses it so per-wallet spend decks can count rejections per wallet.
   */
  tenantProviderId?: string | null;
}

export interface RouteCredentialDeps {
  providerKeyService: Pick<ProviderKeyService, 'selectProviderKey' | 'getProviderApiKey'>;
  oauth: OAuthServiceSet;
  /**
   * Wallet budgets (RET-692). Optional so upstream self-hosted installs
   * without the module are untouched: when absent (or mode off), selection
   * is exactly the legacy single selectProviderKey path.
   */
  walletBudget?: WalletBudgetGate;
}

export function credentialFailureCode(
  reason: CredentialFailureReason,
): Extract<ManifestErrorCode, 'M100' | 'M102' | 'M200'> {
  return CREDENTIAL_FAILURE_CODE[reason];
}

/**
 * User-facing Manifest error for a credential miss.
 * `dashboardUrl` should be a real agent routing URL when available.
 */
export function presentCredentialFailure(
  reason: CredentialFailureReason,
  provider: string,
  dashboardUrl: string,
): CredentialFailurePresentation {
  const code = credentialFailureCode(reason);
  const message = formatManifestError(code, { provider, dashboardUrl });
  return {
    code,
    reason,
    message,
    status: CREDENTIAL_FAILURE_HTTP_STATUS,
    errorBody: JSON.stringify({ error: { message } }),
  };
}

/** Start + complete a local provider attempt for a credential failure. */
export function startCredentialFailureAttempt(
  startProviderAttempt: StartProviderAttempt | undefined,
  start: {
    provider: string;
    model: string;
    authType?: string;
    tenantProviderId?: string | null;
    keyLabel?: string;
  },
): ProviderAttemptRef | undefined {
  const attempt = startProviderAttempt?.(start);
  if (attempt) attempt.completedAtMs = Date.now();
  return attempt;
}

/**
 * Synthetic primary forward when credentials never reached provider transport.
 * `providerCallStarted: true` so the attempt is persisted (unlike rate-limit cooldowns).
 */
export function buildCredentialFailureForward(opts: {
  provider: string;
  model: string;
  authType?: AuthType;
  tenantProviderId: string | null;
  /** Pinned connection label, so the failed attempt row still names a connection. */
  keyLabel?: string;
  presentation: CredentialFailurePresentation;
  startProviderAttempt?: StartProviderAttempt;
}): ForwardResult {
  const attempt = startCredentialFailureAttempt(opts.startProviderAttempt, {
    provider: opts.provider,
    model: opts.model,
    authType: opts.authType,
    tenantProviderId: opts.tenantProviderId,
    keyLabel: opts.keyLabel,
  });
  return {
    response: new Response(opts.presentation.errorBody, {
      status: opts.presentation.status,
      headers: { 'content-type': 'application/json' },
    }),
    providerCallStarted: true,
    attempt,
    isGoogle: false,
    isAnthropic: false,
    isChatGpt: false,
  };
}

/**
 * Mid-chain credential failure entry for `FailedFallback[]`.
 * Shape matches FailedFallback so the fallback service can push it directly.
 */
export function buildCredentialFailureFallback(opts: {
  model: string;
  provider: string;
  fallbackIndex: number;
  authType?: AuthType;
  tenantProviderId: string | null;
  /** Pinned connection label, so the failed hop row still names a connection. */
  keyLabel?: string;
  presentation: CredentialFailurePresentation;
  startProviderAttempt?: StartProviderAttempt;
}): {
  model: string;
  provider: string;
  fallbackIndex: number;
  status: number;
  errorBody: string;
  authType?: AuthType;
  tenantProviderId: string | null;
  keyLabel?: string;
  attempt?: ProviderAttemptRef;
  providerCallStarted: true;
} {
  const attempt = startCredentialFailureAttempt(opts.startProviderAttempt, {
    provider: opts.provider,
    model: opts.model,
    authType: opts.authType,
    tenantProviderId: opts.tenantProviderId,
    keyLabel: opts.keyLabel,
  });
  return {
    model: opts.model,
    provider: opts.provider,
    fallbackIndex: opts.fallbackIndex,
    status: opts.presentation.status,
    errorBody: opts.presentation.errorBody,
    authType: opts.authType,
    tenantProviderId: opts.tenantProviderId,
    keyLabel: opts.keyLabel,
    attempt,
    providerCallStarted: true,
  };
}

/**
 * Wallet-budget-aware key selection for one route hop (RET-692).
 *
 * With the gate governing, walk the provider's key chain (the owner chain)
 * in pin-aware priority order and serve the FIRST wallet that admits the
 * caller — budget-aware failover lives in the router, one code path for
 * primary and fallback hops. A wallet with no `budget` config is ungoverned
 * and serves as before. Caps are hard; the night window rejects only
 * non-allowlisted callers. When every wallet refuses and mode is `enforce`,
 * the request is rejected at the door with a wallet receipt (M200 naming
 * wallet, rule, and spend vs line, stamped with the blocked wallet's
 * tenant_provider_id); in `shadow` traffic still flows — the first wallet
 * that admits serves, every would-be block is logged with a WALLET-BUDGET
 * line for the shadow-day deck, and a chain where nothing admits falls back
 * to the top-priority wallet.
 */
async function selectServingKey(
  deps: RouteCredentialDeps,
  args: {
    agentId: string;
    tenantId: string;
    provider: string;
    authType?: AuthType;
    providerKeyLabel?: string;
    walletCaller?: WalletGateCallerContext;
    dashboardUrl?: string;
  },
): Promise<
  | {
      key: { id: string; label: string; apiKey: string | null; region?: string | null } | null;
      presentation?: CredentialFailurePresentation;
      /** True when the wallet gate (not legacy selection) chose the row. */
      selectedByGate?: boolean;
    }
  | null> {
  const gate = deps.walletBudget;
  const governing = gate && gate.mode() !== 'off';
  if (!gate || !governing) {
    // Legacy path: single selection, unchanged for installs without the gate.
    const key = await deps.providerKeyService.selectProviderKey(
      args.tenantId,
      args.provider,
      args.authType,
      args.providerKeyLabel,
      args.agentId,
    );
    return { key };
  }

  const candidates = await gate.listProviderKeys(
    args.tenantId,
    args.provider,
    args.authType,
    args.agentId,
  );
  if (candidates.length === 0) return { key: null };
  const ordered = orderCandidates(candidates, args.providerKeyLabel);
  const caller = args.walletCaller ?? {};
  const now = new Date();

  let firstBlocked: {
    id: string;
    label: string;
    decision: Extract<WalletBudgetDecision, { allowed: false }>;
    config: WalletBudgetConfig;
    spend: WalletSpend;
  } | null = null;

  for (const candidate of ordered) {
    if (candidate.apiKey === null) continue;
    const parsed = await gate.configFor(candidate.id);
    if (!parsed.config) {
      // Ungoverned wallet: no lines set, serves as before.
      return { key: candidate, selectedByGate: true };
    }
    const { spend, decision } = await gate.decide(parsed.config, candidate.id, caller, now);
    if (decision.allowed) return { key: candidate, selectedByGate: true };
    if (!firstBlocked) {
      firstBlocked = { id: candidate.id, label: candidate.label, decision, config: parsed.config, spend };
    }
    gate.noteBlocked(candidate.label, decision, parsed.config, spend, caller);
  }

  if (firstBlocked && gate.mode() === 'enforce') {
    // Every wallet in the chain refused, and we are enforcing: reject at the
    // door with a receipt instead of silently billing a spent wallet.
    const vars = walletBudgetMessage(firstBlocked.label, firstBlocked.decision, firstBlocked.config, firstBlocked.spend);
    const message = formatManifestError('M200', {
      ...vars,
      dashboardUrl: args.dashboardUrl ?? 'the dashboard',
    });
    return {
      key: null,
      presentation: {
        code: 'M200',
        reason: 'limit_exceeded',
        message,
        status: WALLET_BUDGET_HTTP_STATUS,
        errorBody: JSON.stringify({ error: { message } }),
        tenantProviderId: firstBlocked.id,
      },
    };
  }

  // Shadow mode (or a chain where nothing was even blocked): serve the
  // legacy choice — the top-priority wallet — and keep the traffic flowing.
  return { key: ordered[0], selectedByGate: true };
}

/**
 * Single key selection + OAuth unwrap for one route hop.
 * Used by primary proxy and mid-chain fallbacks.
 */
export async function resolveRouteCredentials(
  deps: RouteCredentialDeps,
  args: {
    agentId: string;
    tenantId: string;
    provider: string;
    authType?: AuthType;
    providerKeyLabel?: string;
    /** Caller context for the night-window allowlist / owner-answer trigger. */
    walletCaller?: WalletGateCallerContext;
    /** Dashboard deep link for the wallet-block receipt message. */
    dashboardUrl?: string;
  },
): Promise<ResolvedRouteCredentials> {
  const { providerKeyService, oauth } = deps;
  const { agentId, tenantId, provider, authType } = args;
  let providerKeyLabel = args.providerKeyLabel;

  // Single key selection per hop: apiKey, tenant_provider_id, region, and
  // label all come from this one row so they can never diverge.
  const selected = await selectServingKey(deps, args);
  const key = selected?.key;
  if (!key || key.apiKey === null) {
    if (selected?.presentation) {
      return {
        ok: false,
        reason: selected.presentation.reason,
        tenantProviderId: selected.presentation.tenantProviderId ?? null,
        presentation: selected.presentation,
      };
    }
    return { ok: false, reason: 'no_provider_key', tenantProviderId: null };
  }
  // Budget failover (gate-selected only) may have picked a row other than
  // the pin's. Subscription OAuth refresh must target the row actually
  // serving the call. Legacy selection keeps today's stale-pin behavior.
  if (
    selected?.selectedByGate &&
    providerKeyLabel &&
    authType === 'subscription' &&
    key.label.toLowerCase() !== providerKeyLabel.toLowerCase()
  ) {
    providerKeyLabel = key.label;
  }

  const apiKey = key.apiKey;
  // NULL for synthetic Ollama — no persisted row to stamp (FK).
  const tenantProviderId = key.id === SYNTHETIC_OLLAMA_PROVIDER_ID ? null : key.id;

  // Unpinned subscription: pin to the selected row so OAuth refresh updates
  // the same connection getProviderApiKey / unwrap used.
  if (!providerKeyLabel && authType === 'subscription') {
    providerKeyLabel = key.label;
  }

  const unwrapped = await resolveApiKey(
    provider,
    apiKey,
    authType,
    agentId,
    tenantId,
    oauth.openaiOauth,
    oauth.minimaxOauth,
    oauth.anthropicOauth,
    oauth.geminiOauth,
    oauth.kiroOauth,
    oauth.xaiOauth,
    providerKeyLabel,
  );

  // resolveApiKey only returns null when a subscription OAuth blob exists
  // but cannot be unwrapped / refreshed.
  if (unwrapped.apiKey === null) {
    return {
      ok: false,
      reason: 'subscription_credentials_unusable',
      tenantProviderId,
    };
  }

  let rawApiKey = apiKey;
  if (authType === 'subscription' && isRefreshableOAuthCredential(apiKey)) {
    // Deliberate re-read: resolveApiKey may have refreshed + persisted a
    // rotated OAuth blob (which also invalidates the key cache).
    rawApiKey =
      (await providerKeyService.getProviderApiKey(
        tenantId,
        provider,
        authType,
        providerKeyLabel,
        agentId,
      )) ?? apiKey;
  }

  return {
    ok: true,
    apiKey: unwrapped.apiKey,
    rawApiKey,
    resourceUrl: unwrapped.resourceUrl,
    providerRegion: key.region,
    tenantProviderId,
    // The selected row's own label, not `args.providerKeyLabel`: selection may
    // have fallen back to the default key when the pin matched nothing.
    keyLabel: key.label,
  };
}
