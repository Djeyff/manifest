/**
 * RET-776-B real-boot receipts.
 *
 * Boots the REAL wallet-console controller + services (owner gate,
 * wallet_owner_intents row, wallet_settings_audit row, decisions-ledger
 * mint, public quota feed) on a local port with in-memory repositories, then
 * exercises the DoD matrix over real HTTP:
 *
 *   POST /api/v1/wallets/wallet-main/intent {action: pause}  -> 200
 *   GET  /api/v1/wallets/wallet-main/state                   -> 200 paused_by_owner
 *   POST /api/v1/wallets/wallet-main/intent {action: resume} -> 200
 *
 * It then prints the final intent rows — the RET-776-A read contract with
 * literal column names — and exits non-zero if any step missed.
 *
 * Usage: node -r ts-node/register/transpile-only scripts/ret776b-wallet-intent-receipts.ts [port]
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { WalletConsoleController } from '../src/routing/wallet-console/wallet-console.controller';
import { WalletConsoleService } from '../src/routing/wallet-console/wallet-console.service';
import { QuotaBoardService } from '../src/routing/wallet-console/quota-board.service';
import { BudgetDailyService } from '../src/routing/wallet-console/budget-daily.service';
import { PublicQuotaService } from '../src/routing/wallet-console/public-quota.service';
import { DecisionLedgerService } from '../src/routing/wallet-console/decision-ledger.service';
import { Tenant } from '../src/entities/tenant.entity';
import { Wallet, WalletMember } from '../src/entities/wallet.entity';
import { TenantProvider } from '../src/entities/tenant-provider.entity';
import { WalletSettings, WalletSettingsAudit } from '../src/entities/wallet-settings.entity';
import { WalletOwnerIntent } from '../src/entities/wallet-owner-intent.entity';

const TENANT = 'tenant-1';
const OWNER = 'user-1';

/** A published RET-670-V3 governor state: key label RCR -> account zai-max. */
const RATION_STATE = {
  updated_at: 1795286724.017969,
  last_status: {
    at: '2026-11-21T18:45:24Z',
    accounts: {
      'zai-max': {
        acct_keys: ['RCR', 'CCR'],
        denomination: 'credits',
        weekly_pool: 140000,
        spent_week_pct: 73.23,
        spent_today_pct: 4.0922,
        decision: {
          account: 'zai-max',
          allow: true,
          halt: false,
          usable_pct: 99.5,
          spent_today_pct: 4.0922,
          remaining_today_pct: 6.651842,
          base_pct: 10,
          rollover_pool_pct: 0.74409,
          floor_pct: 4,
          drain_day: false,
          drain_window: false,
          day_index: 0,
          day_number: 1,
          ration_model: 'owner-v3',
        },
      },
    },
  },
};

function repo<T extends object>(rows: T[] = []) {
  const state = { rows: [...rows] };
  const match = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const order = (list: T[], o?: Record<string, string>): T[] =>
    o?.created_at === 'DESC'
      ? [...list].sort((a, b) =>
          String((b as Record<string, unknown>).created_at ?? '').localeCompare(
            String((a as Record<string, unknown>).created_at ?? ''),
          ),
        )
      : list;
  return {
    state,
    find: async (options?: { where?: Partial<T>; order?: Record<string, string>; take?: number }) => {
      const list = state.rows.filter((r) =>
        match(r as Record<string, unknown>, (options?.where ?? {}) as Record<string, unknown>),
      );
      const ordered = order(list, options?.order);
      return typeof options?.take === 'number' ? ordered.slice(0, options.take) : ordered;
    },
    findOne: async (options?: { where?: Partial<T>; order?: Record<string, string> }) =>
      order(
        state.rows.filter((r) =>
          match(r as Record<string, unknown>, (options?.where ?? {}) as Record<string, unknown>),
        ),
        options?.order,
      )[0] ?? null,
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
    insert: async (row: T) => {
      state.rows.push(row);
      return row;
    },
  };
}

async function main(): Promise<void> {
  // Governor state + public-feed last-known file live in a throwaway dir so
  // the boot never touches real state.
  const dir = mkdtempSync(join(tmpdir(), 'ret776b-boot-'));
  const rationFile = join(dir, 'ration.json');
  writeFileSync(rationFile, JSON.stringify(RATION_STATE), 'utf8');
  process.env.MANIFEST_RET670_RATION_FILE = rationFile;
  process.env.MANIFEST_PUBLIC_QUOTA_FILE = join(dir, 'public-quota-last-known.json');

  const tenantRepo = repo<Tenant>([
    Object.assign(new Tenant(), { id: TENANT, name: 'retena', owner_user_id: OWNER }),
  ]);
  const walletRepo = repo<Wallet>([
    Object.assign(new Wallet(), {
      id: 'wallet-main',
      tenant_id: TENANT,
      name: 'MAIN',
      color: 'indigo',
    }),
  ]);
  const memberRepo = repo<WalletMember>([
    Object.assign(new WalletMember(), {
      wallet_id: 'wallet-main',
      tenant_provider_id: 'tp-rcr',
      tenant_id: TENANT,
    }),
  ]);
  const providerRepo = repo<TenantProvider>([
    Object.assign(new TenantProvider(), {
      id: 'tp-rcr',
      tenant_id: TENANT,
      label: 'RCR',
      provider: 'zai',
      is_active: true,
    }),
  ]);
  const settingsRepo = repo<WalletSettings>([]);
  const auditRepo = repo<WalletSettingsAudit>([]);
  const intentRepo = repo<WalletOwnerIntent>([]);

  const ledger = new DecisionLedgerService(join(dir, 'decisions.jsonl'));
  const consoleService = new WalletConsoleService(
    tenantRepo as never,
    walletRepo as never,
    memberRepo as never,
    providerRepo as never,
    settingsRepo as never,
    auditRepo as never,
    ledger,
    intentRepo as never,
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
      {
        provide: PublicQuotaService,
        useValue: new PublicQuotaService(
          quota as never,
          walletRepo as never,
          memberRepo as never,
          providerRepo as never,
          settingsRepo as never,
        ),
      },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.use((req: { tenantContext?: unknown }, _res: unknown, next: () => void) => {
    req.tenantContext = { tenantId: TENANT, userId: OWNER };
    next();
  });
  const port = Number.parseInt(process.argv[2] ?? '8099', 10);
  await app.listen(port);
  const base = `http://127.0.0.1:${port}`;
  // eslint-disable-next-line no-console
  const log = (...parts: unknown[]) => console.log(...parts);
  log(`RET-776-B receipt server listening on ${port}`);

  const post = async (body: Record<string, unknown>) =>
    fetch(`${base}/api/v1/wallets/wallet-main/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const pause = await post({ action: 'pause', reason: 'owner pause from the console' });
  const pauseBody = await pause.json();
  log('1) POST intent pause  ->', pause.status, JSON.stringify(pauseBody));

  const state = await fetch(`${base}/api/v1/wallets/wallet-main/state`);
  const stateBody = await state.json();
  log('2) GET  state         ->', state.status, JSON.stringify(stateBody));

  const resume = await post({ action: 'resume', reason: 'owner resume' });
  const resumeBody = await resume.json();
  log('3) POST intent resume ->', resume.status, JSON.stringify(resumeBody));

  log('intent rows (RET-776-A read contract, columns literal):');
  for (const row of intentRepo.state.rows) log('    ', JSON.stringify(row));
  log(
    'audit rows:',
    JSON.stringify(
      auditRepo.state.rows.map((r) => ({
        action: (r as WalletSettingsAudit).action,
        ruling_id: (r as WalletSettingsAudit).ruling_id,
      })),
    ),
  );

  const stateView = (stateBody as { state?: { state?: string } }).state?.state;
  const ok =
    pause.status === 200 &&
    state.status === 200 &&
    stateView === 'paused_by_owner' &&
    resume.status === 200;
  log(ok ? 'RET-776-B boot smoke: PASS' : 'RET-776-B boot smoke: FAIL');
  await app.close();
  if (!ok) process.exit(1);
}

void main();
