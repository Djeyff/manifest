import 'reflect-metadata';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ZaiQuotaSnapshot } from './zai-quota-monitor';
import { ZaiQuotaController } from './zai-quota.controller';

describe('ZaiQuotaController — GET /api/v1/zai-quota', () => {
  const snapshot: ZaiQuotaSnapshot = {
    labels: {
      RCR: {
        label: 'RCR',
        five_h_pct_left: 60,
        weekly_pct_left: 90,
        five_h_reset_at: '2026-11-07T12:00:00.000Z',
        weekly_reset_at: '2026-11-14T12:00:00.000Z',
        plan_level: 'lite',
        subscription_status: null,
        seen_at: '2026-11-07T21:00:00.000Z',
        polled_at: '2026-11-07T21:00:00.000Z',
        source: 'zai-coding-plan',
        error: null,
      },
    },
    polled_at: '2026-11-07T21:00:00.000Z',
    polls: 41,
    poll_errors: 0,
  };

  it('serves the poller snapshot verbatim', () => {
    const controller = new ZaiQuotaController({ snapshot: () => snapshot } as never);
    expect(controller.getZaiQuota()).toEqual(snapshot);
    expect(controller.getZaiQuota().labels['RCR'].five_h_pct_left).toBe(60);
  });

  it('returns an empty label map when the poller is absent (optional-injected)', () => {
    const controller = new ZaiQuotaController();
    expect(controller.getZaiQuota()).toEqual({ labels: {}, polled_at: null, polls: 0, poll_errors: 0 });
  });

  it('is @Public — the admission mirror reads it without an agent key', () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, ZaiQuotaController.prototype.getZaiQuota),
    ).toBe(true);
  });
});
