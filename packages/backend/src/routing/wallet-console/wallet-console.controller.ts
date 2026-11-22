import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { WalletConsoleService, UpdateWalletSettingsInput } from './wallet-console.service';
import { QuotaBoardService } from './quota-board.service';
import { BudgetDailyService } from './budget-daily.service';

/**
 * Wallet console read/write API (RET-720).
 *
 * Owner-only surface. Every route is behind the console feature flag: set
 * MANIFEST_WALLET_CONSOLE_ENABLED=false and the whole surface answers 404 —
 * that is the rollback for this money-surface change (no redeploy of the
 * governor, no data migration to undo).
 */
@Controller()
export class WalletConsoleController {
  constructor(
    private readonly console: WalletConsoleService,
    private readonly quotaBoard: QuotaBoardService,
    private readonly budgets: BudgetDailyService,
  ) {}

  @Get('api/v1/wallets/:id/settings')
  async getSettings(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    return { settings: await this.console.getSettings(ctx.tenantId, ctx.userId, id) };
  }

  @Put('api/v1/wallets/:id/settings')
  async putSettings(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateWalletSettingsInput,
  ) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    return this.console.updateSettings(ctx.tenantId, ctx.userId, id, body ?? {});
  }

  @Get('api/v1/wallets/:id/settings/audit')
  async getAudit(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    const parsed = Number.parseInt(limit ?? '', 10);
    const rows = await this.console.listAudit(
      ctx.tenantId,
      ctx.userId,
      id,
      Number.isFinite(parsed) ? parsed : 50,
    );
    return { audit: rows };
  }

  /**
   * The registered provider keys a wallet can be bound to (D-2026-11-22-13).
   * The console's key-binding editor reads this list; the bindings themselves
   * are written through PUT /wallets/:id/settings.
   */
  @Get('api/v1/wallets/keys')
  async listKeys(@TenantCtx() ctx: TenantContext) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    return { keys: await this.console.listProviderKeys(ctx.tenantId, ctx.userId) };
  }

  @Get('api/v1/quota-board')
  async getQuotaBoard(@TenantCtx() ctx: TenantContext) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    return this.quotaBoard.board(ctx.tenantId, ctx.userId);
  }

  @Get('api/v1/budgets/daily')
  async getDailyBudgets(@TenantCtx() ctx: TenantContext) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    return this.budgets.daily(ctx.tenantId, ctx.userId);
  }

  /** The console rollback lever: flag off = the surface does not exist. */
  private assertEnabled(): void {
    const flag = process.env.MANIFEST_WALLET_CONSOLE_ENABLED;
    if (flag !== undefined && flag.toLowerCase() === 'false') {
      throw new NotFoundException('Wallet console is disabled');
    }
  }
}
