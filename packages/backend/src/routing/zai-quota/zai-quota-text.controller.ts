import { Controller, Get, Header, Optional } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ZaiQuotaLabelSnapshot, ZaiQuotaSnapshot } from './zai-quota-monitor';
import { ZaiQuotaService } from './zai-quota.service';

/**
 * Owner-widget text view of live Z.AI coding-plan quota (RET-595).
 *
 * Served at `GET /status/quota.txt` as plain text — exactly one line per
 * label, `--` when a gauge is unknown, the documented backup aliases, and
 * the contract row order (busiest first: RCR, RCR-BKP, CCR, CCR-BKP):
 *
 *   RCR      5h 12% | wk 84%
 *   RCR-BKP  5h 95% | wk 41%
 *   CCR      5h 88% | wk 77%
 *   CCR-BKP  5h 91% | wk 33%
 *
 * RET-617: weekly-reset times are served at `GET /status/quota-resets.txt`,
 * ALONGSIDE quota.txt — identical row prefixes plus a third field
 * ` | ↻ MM-DD HH:MMZ` (weekly reset, UTC; `↻ --` when unknown). The Android
 * quota widget (retena-quota-bar QuotaTextParser) anchors its row regex at
 * end-of-line, so appending a third field to quota.txt itself would make it
 * DROP rows; quota.txt therefore stays byte-identical and resets get their
 * own file (RET-617 sanctioned fallback). The widget's primary feed is the
 * untouched JSON route below (/api/v1/zai-quota).
 *
 * The admission proxy intercepts only exact `/status` and `/livez`; this
 * path passes straight through to the gateway, which is the only place the
 * live poller runs. Telemetry only: no poller wired renders an empty body,
 * never an error.
 */

/** Display aliases for the widget's label column (documented contract). */
const LABEL_ALIASES: Record<string, string> = {
  'RCR Backup': 'RCR-BKP',
  'CCR Backup': 'CCR-BKP',
};

/** Contract row order: busiest label first, then the documented sequence. */
const DISPLAY_ORDER = ['RCR', 'RCR Backup', 'CCR', 'CCR Backup'];

/** Label column width; `RCR-BKP` is the longest documented alias (7 chars). */
const LABEL_COL_WIDTH = 9;

function displayLabel(label: string): string {
  return LABEL_ALIASES[label] ?? label;
}

function pctCell(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}%`;
}

/** Weekly-reset cell: MM-DD HH:MMZ in UTC; `--` when unknown or invalid (RET-617). */
function resetCell(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

/** One quota.txt row prefix: `label 5h X% | wk Y%` (the pinned contract bytes). */
function rowPrefix(label: string, row: ZaiQuotaLabelSnapshot): string {
  const name = displayLabel(label);
  // Long display names must keep a space before the gauges (e.g.
  // "KaanAssistV2 5h 87%", never "KaanAssistV25h").
  const labelCol = name.length < LABEL_COL_WIDTH ? name.padEnd(LABEL_COL_WIDTH) : `${name} `;
  return `${labelCol}5h ${pctCell(row.five_h_pct_left)} | wk ${pctCell(row.weekly_pct_left)}`;
}

@Controller()
export class ZaiQuotaTextController {
  constructor(
    @Optional()
    private readonly zaiQuota?: ZaiQuotaService,
  ) {}

  @Public()
  @Get('status/quota.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getQuotaText(): string {
    const snapshot: ZaiQuotaSnapshot =
      this.zaiQuota?.snapshot() ?? { labels: {}, polled_at: null, polls: 0, poll_errors: 0 };
    const present = Object.keys(snapshot.labels);
    const ordered = [
      ...DISPLAY_ORDER.filter((label) => present.includes(label)),
      ...present.filter((label) => !DISPLAY_ORDER.includes(label)).sort(),
    ];
    const body = ordered
      .map((label) => {
        const row = snapshot.labels[label];
        return rowPrefix(label, row);
      })
      .join('\n');
    return ordered.length > 0 ? `${body}\n` : '';
  }

  /** RET-617: same rows + weekly reset (UTC) as a third field. */
  @Public()
  @Get('status/quota-resets.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  getQuotaResetsText(): string {
    const snapshot: ZaiQuotaSnapshot =
      this.zaiQuota?.snapshot() ?? { labels: {}, polled_at: null, polls: 0, poll_errors: 0 };
    const present = Object.keys(snapshot.labels);
    const ordered = [
      ...DISPLAY_ORDER.filter((label) => present.includes(label)),
      ...present.filter((label) => !DISPLAY_ORDER.includes(label)).sort(),
    ];
    const body = ordered
      .map((label) => {
        const row = snapshot.labels[label];
        return `${rowPrefix(label, row)} | ↻ ${resetCell(row.weekly_reset_at)}`;
      })
      .join('\n');
    return ordered.length > 0 ? `${body}\n` : '';
  }
}
