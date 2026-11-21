/**
 * RET-720 local-boot receipt server.
 *
 * Boots the REAL wallet-console controller + services (owner gate, audit,
 * decision-ledger mint, fresh quota board, RET-670-V3 daily budgets) on a
 * local port with in-memory repositories, so the endpoints can be exercised
 * with curl without a Postgres instance.
 *
 * Usage: node -r ts-node/register/transpile-only scripts/ret720-wallet-console-receipts.ts [port]
 */
import { Test } from '@nestjs/testing';
import { WalletConsoleController } from '../src/routing/wallet-console/wallet-console.controller';
import { WalletConsoleService } from '../src/routing/wallet-console/wallet-console.service';
import { QuotaBoardService } from '../src/routing/wallet-console/quota-board.service';
import { BudgetDailyService } from '../src/routing/wallet-console/budget-daily.service';
import { DecisionLedgerService } from '../src/routing/wallet-console/decision-ledger.service';
import { Tenant } from '../src/entities/tenant.entity';
import { Wallet, WalletMember } from '../src/entities/wallet.entity';
import { TenantProvider } from '../src/entities/tenant-provider.entity';
import { WalletSettings, WalletSettingsAudit } from '../src/entities/wallet-settings.entity';

const TENANT = 'tenant-1';
const OWNER = 'user-1';

function repo<T extends object>(rows: T[] = []) {
  const state = { rows: [...rows] };
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    state,
    find: async (options?: { where?: Partial<T> }) =>
      state.rows.filter((r) => match(r as Record<string, unknown>, (options?.where ?? {}) as Record<string, unknown>)),
    findOne: async (options?: { where?: Partial<T> }) =>
      state.rows.find((r) => match(r as Record<string, unknown>, (options?.where ?? {}) as Record<string, unknown>)) ?? null,
    save: async (row: T) => {
      const i = state.rows.findIndex(
        (r) =>
          (r as Record<string, unknown>)['wallet_id'] === (row as Record<string, unknown>)['wallet_id'] ||
          (r as Record<string, unknown>)['id'] === (row as Record<string, unknown>)['id'],
      );
      if (i >= 0) state.rows[i] = row;
      else state.rows.push(row);
      return row;
    },
  };
}

async function main(): Promise<void> {
  const tenantRepo = repo<Tenant>([Object.assign(new Tenant(), { id: TENANT, name: 'retena', owner_user_id: OWNER })]);
  const walletRepo = repo<Wallet>([
    Object.assign(new Wallet(), { id: 'wallet-main', tenant_id: TENANT, name: 'MAIN', color: 'indigo' }),
  ]);
  const memberRepo = repo<WalletMember>([
    Object.assign(new WalletMember(), { wallet_id: 'wallet-main', tenant_provider_id: 'tp-rcr', tenant_id: TENANT }),
  ]);
  const providerRepo = repo<TenantProvider>([
    Object.assign(new TenantProvider(), { id: 'tp-rcr', tenant_id: TENANT, label: 'RCR', provider: 'zai' }),
  ]);
  const settingsRepo = repo<WalletSettings>([]);
  const auditRepo = repo<WalletSettingsAudit>([]);

  const ledger = new DecisionLedgerService(
    process.env.MANIFEST_DECISION_LEDGER_FILE ?? '/tmp/ret720-ledger.jsonl',
  );
  const consoleService = new WalletConsoleService(
    tenantRepo as never,
    walletRepo as never,
    memberRepo as never,
    providerRepo as never,
    settingsRepo as never,
    auditRepo as never,
    ledger,
  );

  // Fresh provider-own quota feed stand-in (the real one polls api.z.ai).
  const quota = {
    tick: async () => undefined,
    snapshot: () => ({
      labels: {
        RCR: {
          label: 'RCR',
          five_h_pct_left: 42.5,
          weekly_pct_left: 71.2,
          five_h_reset_at: new Date(Date.now() + 3600_000).toISOString(),
          weekly_reset_at: new Date(Date.now() + 5 * 86400_000).toISOString(),
          plan_level: 'max',
          subscription_status: 'active',
          seen_at: new Date().toISOString(),
          error: null,
        },
      },
      polled_at: new Date().toISOString(),
      polls: 1,
      poll_errors: 0,
    }),
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [WalletConsoleController],
    providers: [
      { provide: WalletConsoleService, useValue: consoleService },
      { provide: QuotaBoardService, useValue: new QuotaBoardService(quota as never, consoleService) },
      { provide: BudgetDailyService, useValue: new BudgetDailyService(consoleService) },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use((req: { tenantContext?: unknown }, _res: unknown, next: () => void) => {
    req.tenantContext = { tenantId: TENANT, userId: OWNER };
    next();
  });
  const port = Number.parseInt(process.argv[2] ?? '8099', 10);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`RET-720 receipt server listening on ${port}`);
}

void main();
