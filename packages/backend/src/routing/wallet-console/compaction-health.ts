import { readFileSync } from 'fs';

/**
 * Reader for the RET-500 compaction health state (owner ruling 1574175326328852632).
 *
 * The compaction quality gate (192k judgment / 128k volume / 48k proactive prune)
 * publishes its standing signals as a JSON state file. This module READS that
 * published state — it never re-implements the verdict maths, so the public
 * quota feed can never disagree with the gate about the verdict.
 *
 * Path: MANIFEST_COMPACTION_HEALTH_FILE, default /data/request-recordings/ret500_compaction_health.json.
 */
export const COMPACTION_HEALTH_FILE_DEFAULT =
  '/data/request-recordings/ret500_compaction_health.json';

export interface CompactionHealthSeat {
  /** True when the seat has enough data to be scored by the verdict rule. */
  scorable: boolean;
  /** Detected compaction boundaries in the window. */
  compactions: number | null;
  /** Longest run of consecutive compactions with failure/thin > 2x baseline. */
  max_consecutive_over_2x: number | null;
  /** Re-read tax week-over-week rise (percent); null when not comparable. */
  reread_tax_rise_pct: number | null;
  /** Aux compression calls that did not commit (fallback used). */
  aux_not_committed: number | null;
}

export interface CompactionHealth {
  /** False when the state file is missing/unreadable — the feed stays healthy. */
  available: boolean;
  /** Reason the state is unavailable (null when available). */
  unavailable_reason: string | null;
  /** GREEN / RED verdict from the gate. */
  verdict: string | null;
  /** ISO stamp of the gate's own publication. */
  generated_at: string | null;
  /** Golden-set memory probe recall (percent), when the probe has run. */
  golden_recall_pct: number | null;
  /** Why the verdict is RED (empty when GREEN). */
  reasons: string[];
  /** Per-seat signal summary. */
  seats: Record<string, CompactionHealthSeat>;
}

export function compactionHealthPath(): string {
  return process.env.MANIFEST_COMPACTION_HEALTH_FILE ?? COMPACTION_HEALTH_FILE_DEFAULT;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function seatOf(raw: unknown): CompactionHealthSeat {
  const seat = (raw ?? {}) as Record<string, unknown>;
  return {
    scorable: asBool(seat['scorable']),
    compactions: asNumber(seat['compactions']),
    max_consecutive_over_2x: asNumber(seat['max_consecutive_over_2x']),
    reread_tax_rise_pct: asNumber(seat['reread_tax_rise_pct']),
    aux_not_committed: asNumber(seat['aux_not_committed']),
  };
}

/** Read the published compaction health state. Never throws: a missing file is a state. */
export function readCompactionHealth(path: string = compactionHealthPath()): CompactionHealth {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      unavailable_reason: `compaction health unreadable at ${path}: ${reason}`,
      verdict: null,
      generated_at: null,
      golden_recall_pct: null,
      reasons: [],
      seats: {},
    };
  }
  const rawSeats = (parsed['seats'] ?? {}) as Record<string, unknown>;
  const seats: Record<string, CompactionHealthSeat> = {};
  for (const [name, seat] of Object.entries(rawSeats ?? {})) {
    if (!seat || typeof seat !== 'object') continue;
    seats[name] = seatOf(seat);
  }
  const rawReasons = parsed['reasons'];
  const reasons = Array.isArray(rawReasons)
    ? rawReasons.filter((r): r is string => typeof r === 'string')
    : [];
  const verdictRaw = parsed['verdict'];
  const generatedRaw = parsed['generated_at'];
  return {
    available: true,
    unavailable_reason: null,
    verdict: typeof verdictRaw === 'string' ? verdictRaw : null,
    generated_at: typeof generatedRaw === 'string' ? generatedRaw : null,
    golden_recall_pct: asNumber(parsed['golden_recall_pct']),
    reasons,
    seats,
  };
}
