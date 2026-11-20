import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import { CustomProvider } from '../../entities/custom-provider.entity';
import { ReasoningContentCacheEntry } from '../../entities/reasoning-content-cache-entry.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { RoutingCoreModule } from '../routing-core/routing-core.module';
import { ModelPricesModule } from '../../model-prices/model-prices.module';
import { ModelDiscoveryModule } from '../../model-discovery/model-discovery.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { OtlpModule } from '../../otlp/otlp.module';
import { OAuthModule } from '../oauth/oauth.module';
import { ResolveModule } from '../resolve/resolve.module';
import { CustomProviderModule } from '../custom-provider/custom-provider.module';
import { HeaderTiersModule } from '../header-tiers/header-tiers.module';
import { BillingModule } from '../../billing/billing.module';
import { AutofixModule } from '../autofix/autofix.module';
import { ZaiQuotaController } from '../zai-quota/zai-quota.controller';
import { ZaiQuotaTextController } from '../zai-quota/zai-quota-text.controller';
import { ZaiQuotaService } from '../zai-quota/zai-quota.service';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProxyFallbackService } from './proxy-fallback.service';
import { ProviderClient } from './provider-client';
import { ProxyRateLimiter } from './proxy-rate-limiter';
import { ProxyMessageRecorder } from './proxy-message-recorder';
import { SessionMomentumService } from './session-momentum.service';
import { CopilotTokenService } from './copilot-token.service';
import { ThoughtSignatureCache } from './thought-signature-cache';
import { ThinkingBlockCache } from './thinking-block-cache';
import { ReasoningContentCache } from './reasoning-content-cache';
import { ModelsDevReasoningCatalog } from './reasoning-model-catalog';
import { CodexSessionAffinity } from './codex-session-affinity';
import { ProxyExceptionFilter } from './proxy-exception.filter';
import { AttemptRecordingService } from './attempt-recording.service';
import { WalletBudgetService } from './wallet-budget.service';
import { QuotaAccountingService } from './quota-accounting.service';
import { QuotaAccountingController } from './quota-accounting.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AgentMessage,
      CustomProvider,
      ReasoningContentCacheEntry,
      TenantProvider,
    ]),
    RoutingCoreModule,
    ModelPricesModule,
    ModelDiscoveryModule,
    NotificationsModule,
    OtlpModule,
    OAuthModule,
    ResolveModule,
    CustomProviderModule,
    HeaderTiersModule,
    BillingModule,
    AutofixModule,
  ],
  controllers: [ProxyController, QuotaAccountingController, ZaiQuotaController, ZaiQuotaTextController],
  providers: [
    ProxyService,
    ProxyFallbackService,
    ProviderClient,
    ProxyRateLimiter,
    ProxyMessageRecorder,
    SessionMomentumService,
    CopilotTokenService,
    ThoughtSignatureCache,
    ThinkingBlockCache,
    ReasoningContentCache,
    ModelsDevReasoningCatalog,
    CodexSessionAffinity,
    ProxyExceptionFilter,
    AttemptRecordingService,
    WalletBudgetService,
    QuotaAccountingService,
    ZaiQuotaService,
  ],
  exports: [ProviderClient],
})
export class ProxyModule {}
