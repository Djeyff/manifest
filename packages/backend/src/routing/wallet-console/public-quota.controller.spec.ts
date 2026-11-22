import { PublicQuotaController } from './public-quota.controller';
import { PublicQuotaService } from './public-quota.service';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

/**
 * Receipts for the always-served HTTP contract: no auth (Public), no-store,
 * and HTTP 200 even when every poll fails.
 */
describe('PublicQuotaController (ret500-nodupe)', () => {
  const service = {
    feed: jest.fn(async () => ({
      wallets: {},
      tick_at: null,
      generated_at: '2026-11-22T18:00:00.000Z',
      stale: true,
      polled_at: null,
      ration_available: false,
      ration_unavailable_reason: 'ration state unreadable',
    })),
  };

  it('is a PUBLIC route — reading quota never hits the login wall', () => {
    const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, PublicQuotaController.prototype.quotaJson);
    expect(isPublic).toBe(true);
  });

  it('always answers 200 with the feed, even when every poll failed', async () => {
    const controller = new PublicQuotaController(service as unknown as PublicQuotaService);
    const res = { status: jest.fn() };
    const body = await controller.quotaJson(res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.stale).toBe(true);
    expect(service.feed).toHaveBeenCalled();
  });
});
