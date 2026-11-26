import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import {
  UpdateWalletSettingsInput,
  WalletConsoleService,
  WalletStateView,
} from './wallet-console.service';
import { canonicalWalletName, PublicQuotaService } from './public-quota.service';
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
    private readonly publicQuota: PublicQuotaService,
  ) {}

  @Get('api/v1/wallets/:id/settings')
  async getSettings(@TenantCtx() ctx: TenantContext, @Param('id') id: string) {
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
   *
   * NOTE the path: it is NOT `/api/v1/wallets/keys`. The wallets controller
   * (`@Controller('api/v1/wallets')`) owns a `@Get(':id')` route, and Express
   * matches that param route BEFORE this controller's routes — so
   * `/api/v1/wallets/keys` was swallowed by it and answered 404
   * "Wallet not found". The key list lives under its own prefix so no
   * `:id` route can shadow it.
   */
  @Get('api/v1/wallet-console/keys')
  async listKeys(@TenantCtx() ctx: TenantContext) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    return { keys: await this.console.listProviderKeys(ctx.tenantId, ctx.userId) };
  }

  /**
   * Owner pause/resume INTENT (RET-776-B). The intent is a row in
   * wallet_owner_intents which the governor + tick (RET-776-A) act on —
   * this route NEVER flips a key (no tenant_providers write here).
   */
  @Post('api/v1/wallets/:id/intent')
  @HttpCode(200)
  async postIntent(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { action?: unknown; reason?: unknown },
  ) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    const result = await this.console.setOwnerIntent(ctx.tenantId, ctx.userId, id, body ?? {});
    return { ...result, state: await this.mergeQuotaNumbers(result.state) };
  }

  /**
   * Wallet runtime state (RET-776-B): owner pause / governor park / running,
   * plus the provider-own numbers from the public quota feed.
   *
   * NOTE the path: it is NOT `/api/v1/wallets/:id` — that record route is
   * owned by the wallets controller (`@Get(':id')`, RET-692-FU1); appending
   * `/state` keeps this route out of every param shadow.
   */
  @Get('api/v1/wallets/:id/state')
  async getWalletState(@TenantCtx() ctx: TenantContext, @Param('id') id: string) {
    this.assertEnabled();
    if (!ctx.tenantId) throw new NotFoundException('Wallet not found');
    const state = await this.console.getWalletState(ctx.tenantId, ctx.userId, id);
    return { state: await this.mergeQuotaNumbers(state) };
  }

  /**
   * Merge the 4 quota numbers into the state view — ONLY from the public
   * feed (PublicQuotaService, RET-708), never recomputed here. Feed failure
   * or an off-feed wallet name serves nulls + numbers_stale:true.
   */
  private async mergeQuotaNumbers(state: WalletStateView): Promise<WalletStateView> {
    try {
      const key = canonicalWalletName(state.name);
      if (!key) return state;
      const row = (await this.publicQuota.feed()).wallets[key];
      if (!row) return state;
      return {
        ...state,
        daily_left_pct: row.allowed_today_pct,
        weekly_left_pct: row.weekly_pct_left,
        read_at: row.polled_at,
        numbers_stale: row.stale,
      };
    } catch {
      return state;
    }
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
