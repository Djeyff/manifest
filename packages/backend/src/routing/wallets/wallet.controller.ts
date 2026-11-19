import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';
import { AddWalletMemberDto, CreateWalletDto, UpdateWalletDto } from '../dto/wallet.dto';
import { WalletService } from './wallet.service';

/**
 * Wallets CRUD (RET-692-FU1). Tenant-scoped: every wallet belongs to the
 * caller's tenant, and the owner edits name, color, member keys and budget.
 */
@Controller('api/v1/wallets')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  async list(@TenantCtx() ctx: TenantContext) {
    if (!ctx.tenantId) return { wallets: [] };
    return { wallets: await this.wallets.list(ctx.tenantId) };
  }

  @Get(':id')
  async get(@TenantCtx() ctx: TenantContext, @Param('id') id: string) {
    if (!ctx.tenantId) return null;
    return this.wallets.find(ctx.tenantId, id);
  }

  @Post()
  async create(@TenantCtx() ctx: TenantContext, @Body() body: CreateWalletDto) {
    if (!ctx.tenantId) throw new Error('No tenant context');
    return this.wallets.create(ctx.tenantId, body);
  }

  @Patch(':id')
  async update(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateWalletDto,
  ) {
    if (!ctx.tenantId) throw new Error('No tenant context');
    return this.wallets.update(ctx.tenantId, id, body);
  }

  @Post(':id/members')
  async addMember(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: AddWalletMemberDto,
  ) {
    if (!ctx.tenantId) throw new Error('No tenant context');
    return this.wallets.addMember(ctx.tenantId, id, body.tenant_provider_id);
  }

  @Delete(':id/members/:tenantProviderId')
  async removeMember(
    @TenantCtx() ctx: TenantContext,
    @Param('id') id: string,
    @Param('tenantProviderId') tenantProviderId: string,
  ) {
    if (!ctx.tenantId) throw new Error('No tenant context');
    return this.wallets.removeMember(ctx.tenantId, id, tenantProviderId);
  }

  @Delete(':id')
  async remove(@TenantCtx() ctx: TenantContext, @Param('id') id: string) {
    if (!ctx.tenantId) throw new Error('No tenant context');
    await this.wallets.remove(ctx.tenantId, id);
    return { removed: true };
  }
}
