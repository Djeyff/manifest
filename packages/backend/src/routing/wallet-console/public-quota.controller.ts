import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PublicQuotaFeed, PublicQuotaService } from './public-quota.service';

/**
 * Public quota surface (ret500-nodupe) — the always-served half of the
 * wallet console's maths. Owner order 2026-11-22: the quota app must ALWAYS
 * be served, no matter if a wallet is parked.
 *
 * `GET /quota.json` — unauthenticated, read-only, no secrets: percentages
 * and wallet names only. Root-level path (NOT under /api/v1) so the owner's
 * local quota app and the public `/quota` page hit one stable URL; this
 * follows the `status/quota.txt` precedent. A real route here also keeps the
 * SPA fallback filter from swallowing the path into index.html.
 */
@Controller()
export class PublicQuotaController {
  constructor(private readonly publicQuota: PublicQuotaService) {}

  @Public()
  @Get('quota.json')
  @Header('Cache-Control', 'no-store')
  async quotaJson(@Res({ passthrough: true }) res: Response): Promise<PublicQuotaFeed> {
    // Always HTTP 200 with the last-known values — a poll failure is data
    // (`stale: true`), never an error status.
    res.status(HttpStatus.OK);
    return this.publicQuota.feed();
  }
}
