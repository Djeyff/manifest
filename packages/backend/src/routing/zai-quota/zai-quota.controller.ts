import { Controller, Get, Optional } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ZaiQuotaSnapshot } from './zai-quota-monitor';
import { ZaiQuotaService } from './zai-quota.service';

/**
 * Public read model of live Z.AI coding-plan quota (RET-595). The admission
 * proxy mirrors this route into its `/status` `quota_labels` contract for the
 * owner widget. Telemetry only: the service is optional-injected so a missing
 * poller module can never 500 the endpoint.
 */
@Controller('api/v1/zai-quota')
export class ZaiQuotaController {
  constructor(
    @Optional()
    private readonly zaiQuota?: ZaiQuotaService,
  ) {}

  @Public()
  @Get()
  getZaiQuota(): ZaiQuotaSnapshot {
    return (
      this.zaiQuota?.snapshot() ?? { labels: {}, polled_at: null, polls: 0, poll_errors: 0 }
    );
  }
}
