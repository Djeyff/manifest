import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Wallet, WalletMember } from '../../entities/wallet.entity';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet, WalletMember, TenantProvider])],
  providers: [WalletService],
  controllers: [WalletController],
  exports: [WalletService],
})
export class WalletsModule {}
