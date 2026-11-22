import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Tenant } from '../../entities/tenant.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import { WalletSettings, WalletSettingsAudit } from '../../entities/wallet-settings.entity';
import { ProxyModule } from '../proxy/proxy.module';
import { WalletConsoleController } from './wallet-console.controller';
import { WalletConsoleService } from './wallet-console.service';
import { DecisionLedgerService } from './decision-ledger.service';
import { QuotaBoardService } from './quota-board.service';
import { BudgetDailyService } from './budget-daily.service';

/**
 * Wallet console module (RET-720): owner-only settings + quota board +
 * daily budgets. Nothing here sits on the gateway hot path — the quota board
 * only READS the live quota feed the poller already maintains.
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
    ]),
    ProxyModule,
  ],
  controllers: [WalletConsoleController],
  providers: [WalletConsoleService, DecisionLedgerService, QuotaBoardService, BudgetDailyService],
  exports: [WalletConsoleService],
})
export class WalletConsoleModule {}
