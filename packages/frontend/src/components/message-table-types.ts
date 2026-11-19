export interface MessageRow {
  id: string;
  timestamp: string;
  agent_name: string | null;
  model: string | null;
  provider?: string | null;
  custom_provider_name?: string | null;
  display_name?: string | null;
  routing_tier?: string;
  routing_reason?: string;
  specificity_category?: string;
  header_tier_id?: string;
  header_tier_name?: string;
  header_tier_color?: string;
  /** Wallet that owns the key which served this request. Null when the key belongs to no wallet. */
  wallet_name?: string | null;
  /** Wallet chip color: a palette token ('indigo') or a hex color ('#4f46e5'). */
  wallet_color?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  status: string;
  error_message?: string | null;
  error_http_status?: number | null;
  /** Documented Manifest error code ('M100', 'M300', …). Null for provider failures. */
  error_code?: string | null;
  /** WHO caused a failure: provider | transport | config | policy | internal | request. */
  error_origin?: string | null;
  /** WHAT kind of failure it was (rate_limit, auth, billing, no_provider_key, timeout, …). */
  error_class?: string | null;
  auth_type?: string | null;
  fallback_from_model?: string | null;
  fallback_index?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  duration_ms?: number | null;
  feedback_rating?: string | null;
  autofix_applied?: boolean;
  autofix_role?: string | null;
  attempt_count?: number;
}

export function routingTierLabel(tier: string | null | undefined): string | undefined {
  if (!tier) return undefined;
  return tier === 'direct' ? 'DIRECT' : tier;
}

export type MessageColumnKey =
  | 'date'
  | 'message'
  | 'cost'
  | 'totalTokens'
  | 'input'
  | 'output'
  | 'model'
  | 'cache'
  | 'duration'
  | 'status'
  | 'attempts'
  | 'selfheal'
  | 'agent'
  | 'wallet';

// Reading order: identity first (status, when, who, what), THEN the
// mechanics (attempts, recovery attempts), then payload and usage. The global
// Requests page inserts the harness column before 'model'.
export const COMPACT_COLUMNS: MessageColumnKey[] = [
  'status',
  'date',
  'model',
  'attempts',
  'selfheal',
  'message',
  'cost',
  'totalTokens',
  'cache',
  'duration',
];

export const DETAILED_COLUMNS: MessageColumnKey[] = [
  'status',
  'date',
  'model',
  'attempts',
  'selfheal',
  'message',
  'cost',
  'totalTokens',
  'input',
  'output',
  'cache',
  'duration',
];

/**
 * Columns for the Requests page.
 *
 * Global mode spans every harness, so the Harness column is inserted and the
 * Wallet column follows it immediately: `... 'agent', 'wallet', 'model' ...`.
 * Per-harness mode has no Harness column, so the Wallet column sits right
 * after 'model' to keep the identity columns together.
 */
export function buildRequestColumns(global: boolean): MessageColumnKey[] {
  const base = DETAILED_COLUMNS;
  const at = base.indexOf('model');
  if (global) {
    return [...base.slice(0, at), 'agent' as const, 'wallet' as const, ...base.slice(at)];
  }
  return [...base.slice(0, at + 1), 'wallet' as const, ...base.slice(at + 1)];
}
