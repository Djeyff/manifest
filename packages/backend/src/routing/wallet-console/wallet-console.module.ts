import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from '../../entities/tenant.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import { WalletSettings, WalletSettingsAudit } from '../../entities/wallet-settings.entity';
import { WalletOwnerIntent } from '../../entities/wallet-owner-intent.entity';
import { ProxyModule } from '../proxy/proxy.module';
import { WalletConsoleController } from './wallet-console.controller';
import { WalletConsoleService } from './wallet-console.service';
import { DecisionLedgerService } from './decision-ledger.service';
import { QuotaBoardService } from './quota-board.service';
import { BudgetDailyService } from './budget-daily.service';
import { PublicQuotaController } from './public-quota.controller';
import { PublicQuotaService } from './public-quota.service';

/**
 * Wallet console module (RET-720): owner-only settings + quota board +
 * daily budgets. Nothing here sits on the gateway hot path — the quota board
 * only READS the live quota feed the poller already maintains.
 *
 * Also hosts the PUBLIC always-served quota surface (ret500-nodupe):
 * `GET /quota.json` + the `/quota` page's feed — read-only, no auth, the
 * console's own numbers mirrored for parked wallets too.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantProvider,
      Wallet,
      WalletMember,
      WalletSettings,
      WalletSettingsAudit,
      WalletOwnerIntent,
    ]),
    ProxyModule,
  ],
  controllers: [WalletConsoleController, PublicQuotaController],
  providers: [
    WalletConsoleService,
    DecisionLedgerService,
    QuotaBoardService,
    BudgetDailyService,
    PublicQuotaService,
  ],
  exports: [WalletConsoleService],
})
export class WalletConsoleModule {}
