import { Controller, Get, Header, Optional } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ZaiQuotaSnapshot } from './zai-quota-monitor';
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
        const name = displayLabel(label);
        // Long display names must keep a space before the gauges (e.g.
        // "KaanAssistV2 5h 87%", never "KaanAssistV25h").
        const labelCol = name.length < LABEL_COL_WIDTH ? name.padEnd(LABEL_COL_WIDTH) : `${name} `;
        return `${labelCol}5h ${pctCell(row.five_h_pct_left)} | wk ${pctCell(row.weekly_pct_left)}`;
      })
      .join('\n');
    return ordered.length > 0 ? `${body}\n` : '';
  }
}
