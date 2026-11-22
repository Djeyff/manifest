import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { WalletConsoleController } from './wallet-console.controller';
import { WalletConsoleService } from './wallet-console.service';
import { QuotaBoardService } from './quota-board.service';
import { BudgetDailyService } from './budget-daily.service';
import { WalletController } from '../wallets/wallet.controller';
import { WalletService } from '../wallets/wallet.service';

/**
 * HTTP receipts for the wallet console surface (RET-720): the three routes
 * the owner console calls, over a real Nest HTTP server.
 */
describe('WalletConsoleController (RET-720)', () => {
  let app: INestApplication;

  const consoleService = {
    getSettings: jest.fn(async () => ({
      wallet_id: 'wallet-1',
      tenant_id: 'tenant-1',
      drain_day_enabled: true,
      priority: 100,
      parked: false,
      kill_switch_fallback: false,
      daily_lines: null,
      updated_at: '2026-11-21T00:00:00.000Z',
      updated_by_user_id: 'user-1',
    })),
    updateSettings: jest.fn(async (_t: string, _u: string, id: string, body: Record<string, unknown>) => ({
      settings: { wallet_id: id, tenant_id: 'tenant-1', ...body },
      changed: true,
      audit_id: 'audit-1',
      ruling: { id: 'D-2026-11-21-01', minted_at: '2026-11-21T18:00:00.000Z', persisted: true },
    })),
    listAudit: jest.fn(async () => []),
    listProviderKeys: jest.fn(async () => [
      {
        id: 'tp-1',
        label: 'RCR',
        provider: 'zai',
        room: 'RCR',
        bound_wallet_id: 'wallet-1',
      },
    ]),
  };
  const quotaBoard = {
    board: jest.fn(async () => ({
      generated_at: '2026-11-21T18:00:00.000Z',
      polled_at: '2026-11-21T18:00:00.000Z',
      stale_feed: false,
      ration: { available: true, updated_at: '2026-11-21T18:00:00.000Z', unavailable_reason: null },
      wallets: [],
    })),
  };
  const budgets = {
    daily: jest.fn(async () => ({
      generated_at: '2026-11-21T18:00:00.000Z',
      available: true,
      unavailable_reason: null,
      ration_updated_at: '2026-11-21T18:00:00.000Z',
      accounts: [],
      wallets: [],
    })),
  };
  /**
   * The REAL wallets controller is mounted on purpose: it owns a `:id` route
   * under `/api/v1/wallets/`, and Express matches a param route before a
   * sibling literal route — that shadowing is what broke the key list.
   */
  const wallets = {
    list: jest.fn(async () => []),
    find: jest.fn(async (_tenantId: string, id: string) => ({ id, shadowed: true })),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      // The wallets controller is registered FIRST — same order as the app
      // modules, so the shadowing regression is actually exercised.
      controllers: [WalletController, WalletConsoleController],
      providers: [
        { provide: WalletService, useValue: wallets },
        { provide: WalletConsoleService, useValue: consoleService },
        { provide: QuotaBoardService, useValue: quotaBoard },
        { provide: BudgetDailyService, useValue: budgets },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // The real SessionGuard attaches the tenant context; the test injects one.
    app.use((req: { tenantContext?: unknown }, _res: unknown, next: () => void) => {
      req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    jest.clearAllMocks();
  });

  it('GET /api/v1/wallets/:id/settings answers the settings view', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/wallets/wallet-1/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.wallet_id).toBe('wallet-1');
  });

  it('PUT /api/v1/wallets/:id/settings answers with the minted ruling', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/wallets/wallet-1/settings')
      .send({ parked: true, priority: 5 });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.ruling.id).toMatch(/^D-\d{4}-\d{2}-\d{2}-\d{2}$/);
  });

  it('GET /api/v1/quota-board answers the board', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/quota-board');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('wallets');
  });

  it('GET /api/v1/budgets/daily answers the daily budgets', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/budgets/daily');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
  });

  it('GET /api/v1/wallet-console/keys answers the registered provider keys', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/wallet-console/keys');
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0].label).toBe('RCR');
  });

  it('keeps the key list off the shadowed /wallets/:id path', async () => {
    // Regression: the key list used to live at `/api/v1/wallets/keys`, where
    // the wallets controller's `:id` route answered it (404 "Wallet not
    // found"). It now lives under its own prefix, so the console's key list
    // is reachable and `/wallets/keys` belongs to the wallets CRUD.
    const shadow = await request(app.getHttpServer()).get('/api/v1/wallets/keys');
    expect(shadow.status).toBe(200);
    expect(wallets.find).toHaveBeenCalledWith('tenant-1', 'keys');
    const keys = await request(app.getHttpServer()).get('/api/v1/wallet-console/keys');
    expect(keys.status).toBe(200);
    expect(keys.body.keys[0].label).toBe('RCR');
  });

  it('404s the whole surface when the console flag is off (rollback lever)', async () => {
    process.env.MANIFEST_WALLET_CONSOLE_ENABLED = 'false';
    try {
      const res = await request(app.getHttpServer()).get('/api/v1/quota-board');
      expect(res.status).toBe(404);
    } finally {
      delete process.env.MANIFEST_WALLET_CONSOLE_ENABLED;
    }
  });
});
