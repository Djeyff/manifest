import 'reflect-metadata';
import { ZaiQuotaLabelSnapshot } from './zai-quota-monitor';
import { ZaiQuotaService } from './zai-quota.service';
import { ZaiQuotaTextController } from './zai-quota-text.controller';

function labelRow(overrides: Partial<ZaiQuotaLabelSnapshot> = {}): ZaiQuotaLabelSnapshot {
  return {
    label: '',
    five_h_pct_left: null,
    weekly_pct_left: null,
    five_h_reset_at: null,
    weekly_reset_at: null,
    plan_level: null,
    subscription_status: null,
    seen_at: null,
    polled_at: null,
    source: null,
    error: null,
    ...overrides,
  };
}

function svcWith(labels: Record<string, ZaiQuotaLabelSnapshot>): ZaiQuotaService {
  return {
    snapshot: () => ({ labels, polled_at: '2026-11-07T22:00:00Z', polls: 1, poll_errors: 0 }),
  } as unknown as ZaiQuotaService;
}

describe('ZaiQuotaTextController (RET-595 /status/quota.txt)', () => {
  it('renders the documented four-line widget text for the four contract labels', () => {
    const ctrl = new ZaiQuotaTextController(
      svcWith({
        RCR: labelRow({ label: 'RCR', five_h_pct_left: 12.4, weekly_pct_left: 84 }),
        'RCR Backup': labelRow({ label: 'RCR Backup', five_h_pct_left: 95, weekly_pct_left: 41 }),
        CCR: labelRow({ label: 'CCR', five_h_pct_left: 88, weekly_pct_left: 77 }),
        'CCR Backup': labelRow({ label: 'CCR Backup', five_h_pct_left: 91, weekly_pct_left: 33 }),
      }),
    );
    expect(ctrl.getQuotaText()).toBe(
      'RCR      5h 12% | wk 84%\n' +
        'RCR-BKP  5h 95% | wk 41%\n' +
        'CCR      5h 88% | wk 77%\n' +
        'CCR-BKP  5h 91% | wk 33%\n',
    );
  });

  it('renders -- for unknown gauges, aliases Backup labels, appends other labels sorted', () => {
    const ctrl = new ZaiQuotaTextController(
      svcWith({
        'CCR Backup': labelRow({ label: 'CCR Backup' }),
        KaanAssistV2: labelRow({ label: 'KaanAssistV2', five_h_pct_left: 87, weekly_pct_left: 79 }),
        Spare: labelRow({ label: 'Spare', five_h_pct_left: 7.6 }),
        CCR: labelRow({ label: 'CCR', five_h_pct_left: 0, weekly_pct_left: 0 }),
      }),
    );
    expect(ctrl.getQuotaText()).toBe(
      'CCR      5h 0% | wk 0%\n' +
        'CCR-BKP  5h -- | wk --\n' +
        'KaanAssistV2 5h 87% | wk 79%\n' +
        'Spare    5h 8% | wk --\n',
    );
  });

  it('renders an empty body when no poller is wired (never 500s the widget)', () => {
    const ctrl = new ZaiQuotaTextController(undefined);
    expect(ctrl.getQuotaText()).toBe('');
  });
});

describe('ZaiQuotaTextController (RET-617 /status/quota-resets.txt)', () => {
  it('renders identical row prefixes plus the weekly reset in UTC MM-DD HH:MMZ, same row order', () => {
    const ctrl = new ZaiQuotaTextController(
      svcWith({
        RCR: labelRow({
          label: 'RCR',
          five_h_pct_left: 12.4,
          weekly_pct_left: 84,
          five_h_reset_at: '2026-11-09T17:30:45.432Z',
          weekly_reset_at: '2026-11-13T23:13:10.997Z',
        }),
        // Contract-order label present but reset unknown -> still ordered before non-contract labels.
        'RCR Backup': labelRow({
          label: 'RCR Backup',
          five_h_pct_left: 100,
          weekly_pct_left: 0,
          weekly_reset_at: '2026-11-10T22:44:13.997Z',
        }),
        KaanAssistV2: labelRow({
          label: 'KaanAssistV2',
          five_h_pct_left: 87,
          weekly_pct_left: 79,
          weekly_reset_at: '2026-12-01T05:07:00Z',
        }),
      }),
    );
    expect(ctrl.getQuotaResetsText()).toBe(
      'RCR      5h 12% | wk 84% | ↻ 11-13 23:13Z\n' +
        'RCR-BKP  5h 100% | wk 0% | ↻ 11-10 22:44Z\n' +
        'KaanAssistV2 5h 87% | wk 79% | ↻ 12-01 05:07Z\n',
    );
  });

  it('renders ↻ -- for null or invalid resets, with each line byte-identical to quota.txt plus the suffix', () => {
    const ctrl = new ZaiQuotaTextController(
      svcWith({
        RCR: labelRow({ label: 'RCR', five_h_pct_left: 95, weekly_pct_left: 34 }),
        Spare: labelRow({ label: 'Spare', five_h_pct_left: 7.6, weekly_reset_at: 'not-a-date' }),
      }),
    );
    const plain = ctrl.getQuotaText();
    const resets = ctrl.getQuotaResetsText();
    expect(resets).toBe('RCR      5h 95% | wk 34% | ↻ --\n' + 'Spare    5h 8% | wk -- | ↻ --\n');
    const plainLines = plain.split('\n').filter(Boolean);
    const resetLines = resets.split('\n').filter(Boolean);
    expect(resetLines).toHaveLength(plainLines.length);
    resetLines.forEach((line, i) => {
      expect(line.startsWith(plainLines[i])).toBe(true);
      expect(line.slice(plainLines[i].length)).toMatch(/^ \| ↻ (?:--|\d{2}-\d{2} \d{2}:\d{2}Z)$/);
    });
    // quota.txt itself must never gain the reset field (additive-only contract).
    expect(plain).not.toContain('↻');
  });

  it('renders an empty body when no poller is wired (never 500s the widget)', () => {
    const ctrl = new ZaiQuotaTextController(undefined);
    expect(ctrl.getQuotaResetsText()).toBe('');
  });
});
