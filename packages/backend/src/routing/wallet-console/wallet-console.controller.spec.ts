import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import request from 'supertest';
import { WalletConsoleController } from './wallet-console.controller';
import {
  WalletConsoleService,
  WalletIntentWriteResult,
  WalletStateView,
} from './wallet-console.service';
import { PublicQuotaService } from './public-quota.service';
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
    updateSettings: jest.fn(
      async (_t: string, _u: string, id: string, body: Record<string, unknown>) => ({
        settings: { wallet_id: id, tenant_id: 'tenant-1', ...body },
        changed: true,
        audit_id: 'audit-1',
        ruling: { id: 'D-2026-11-21-01', minted_at: '2026-11-21T18:00:00.000Z', persisted: true },
      }),
    ),
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
    setOwnerIntent: jest.fn(
      async (
        _tenantId: string,
        userId: string | null,
        walletId: string,
        body: { action?: unknown; reason?: unknown },
      ): Promise<WalletIntentWriteResult> => {
        if (userId !== 'user-1') throw new ForbiddenException('Wallet settings are owner-only');
        if (walletId === 'wallet-nope') throw new NotFoundException('Wallet not found');
        if (body.action !== 'pause' && body.action !== 'resume') {
          throw new BadRequestException("action must be 'pause' or 'resume'");
        }
        const action = body.action;
        return {
          changed: true,
          action,
          accounts: ['zai-max'],
          intent: {
            action,
            actor: userId ?? 'user-1',
            reason: typeof body.reason === 'string' ? body.reason : '',
            at: '2026-11-26T00:00:00.000Z',
          },
          audit_id: 'audit-intent-1',
          ruling: { id: 'D-2026-11-26-01', minted_at: '2026-11-26T00:00:00.000Z', persisted: true },
          state: {
            wallet_id: walletId,
            name: 'MAIN',
            state: action === 'pause' ? 'paused_by_owner' : 'running',
            daily_left_pct: null,
            weekly_left_pct: null,
            read_at: null,
            numbers_stale: true,
            last_intent: null,
            keys_active: true,
          },
        };
      },
    ),
    getWalletState: jest.fn(
      async (
        _tenantId: string,
        userId: string | null,
        walletId: string,
      ): Promise<WalletStateView> => {
        if (userId !== 'user-1') throw new ForbiddenException('Wallet settings are owner-only');
        if (walletId === 'wallet-nope') throw new NotFoundException('Wallet not found');
        return {
          wallet_id: walletId,
          name: 'MAIN',
          state: 'running',
          daily_left_pct: null,
          weekly_left_pct: null,
          read_at: null,
          numbers_stale: true,
          last_intent: null,
          keys_active: true,
        };
      },
    ),
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
  /** Stand-in for the public quota feed; tests override feed() per case. */
  const publicQuota = {
    feed: jest.fn(async () => ({
      wallets: {} as Record<
        string,
        {
          allowed_today_pct: number | null;
          weekly_pct_left: number | null;
          polled_at: string | null;
          stale: boolean;
        }
      >,
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

  /** SessionGuard stand-in: each test mutates this to impersonate a caller. */
  let currentCtx: { tenantId: string | null; userId: string | null } = {
    tenantId: 'tenant-1',
    userId: 'user-1',
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
        { provide: PublicQuotaService, useValue: publicQuota },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // The real SessionGuard attaches the tenant context; the test injects one.
    app.use((req: { tenantContext?: unknown }, _res: unknown, next: () => void) => {
      req.tenantContext = currentCtx;
      next();
    });
    await app.init();
  });

  afterEach(async () => {
    currentCtx = { tenantId: 'tenant-1', userId: 'user-1' };
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

  it('POST /api/v1/wallets/:id/intent records a pause intent (200)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/wallets/wallet-1/intent')
      .send({ action: 'pause', reason: 'hold the line' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.action).toBe('pause');
    expect(res.body.accounts).toEqual(['zai-max']);
    expect(res.body.intent.reason).toBe('hold the line');
    expect(res.body.ruling.id).toMatch(/^D-\d{4}-\d{2}-\d{2}-\d{2}$/);
    expect(res.body.state.state).toBe('paused_by_owner');
  });

  it('repeating the same intent answers the current state without a new write', async () => {
    consoleService.setOwnerIntent.mockImplementationOnce(
      async (): Promise<WalletIntentWriteResult> => ({
        changed: false,
        action: 'pause',
        accounts: ['zai-max'],
        intent: {
          action: 'pause',
          actor: 'user-1',
          reason: 'hold the line',
          at: '2026-11-26T00:00:00.000Z',
        },
        audit_id: null,
        ruling: null,
        state: {
          wallet_id: 'wallet-1',
          name: 'MAIN',
          state: 'paused_by_owner',
          daily_left_pct: null,
          weekly_left_pct: null,
          read_at: null,
          numbers_stale: true,
          last_intent: { action: 'pause', actor: 'user-1', at: '2026-11-26T00:00:00.000Z' },
          keys_active: true,
        },
      }),
    );
    const res = await request(app.getHttpServer())
      .post('/api/v1/wallets/wallet-1/intent')
      .send({ action: 'pause' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.audit_id).toBeNull();
    expect(res.body.ruling).toBeNull();
    expect(res.body.intent.action).toBe('pause');
    expect(res.body.state.state).toBe('paused_by_owner');
  });

  it('answers 400 on a bad action', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/wallets/wallet-1/intent')
      .send({ action: 'halt' });
    expect(res.status).toBe(400);
  });

  it('answers 403 for a non-owner caller', async () => {
    currentCtx = { tenantId: 'tenant-1', userId: 'user-2' };
    const res = await request(app.getHttpServer())
      .post('/api/v1/wallets/wallet-1/intent')
      .send({ action: 'pause' });
    expect(res.status).toBe(403);
  });

  it('answers 404 without a tenant context and for an unknown wallet', async () => {
    currentCtx = { tenantId: null, userId: 'user-1' };
    const noTenantPost = await request(app.getHttpServer())
      .post('/api/v1/wallets/wallet-1/intent')
      .send({ action: 'pause' });
    const noTenantState = await request(app.getHttpServer()).get('/api/v1/wallets/wallet-1/state');
    currentCtx = { tenantId: 'tenant-1', userId: 'user-1' };
    const unknownPost = await request(app.getHttpServer())
      .post('/api/v1/wallets/wallet-nope/intent')
      .send({ action: 'pause' });
    const unknownState = await request(app.getHttpServer()).get(
      '/api/v1/wallets/wallet-nope/state',
    );
    expect(noTenantPost.status).toBe(404);
    expect(noTenantState.status).toBe(404);
    expect(unknownPost.status).toBe(404);
    expect(unknownState.status).toBe(404);
  });

  it('GET /api/v1/wallets/:id/state reports running and merges the public-feed numbers', async () => {
    publicQuota.feed.mockImplementationOnce(async () => ({
      wallets: {
        MAIN: {
          allowed_today_pct: 12.5,
          weekly_pct_left: 66.2,
          polled_at: '2026-11-26T05:00:00.000Z',
          stale: false,
        },
      },
    }));
    const res = await request(app.getHttpServer()).get('/api/v1/wallets/wallet-1/state');
    expect(res.status).toBe(200);
    expect(res.body.state.state).toBe('running');
    expect(res.body.state.keys_active).toBe(true);
    expect(res.body.state.daily_left_pct).toBe(12.5);
    expect(res.body.state.weekly_left_pct).toBe(66.2);
    expect(res.body.state.read_at).toBe('2026-11-26T05:00:00.000Z');
    expect(res.body.state.numbers_stale).toBe(false);
  });

  it('GET state reports paused_by_owner with the last intent echoed', async () => {
    consoleService.getWalletState.mockImplementationOnce(async (): Promise<WalletStateView> => ({
      wallet_id: 'wallet-1',
      name: 'MAIN',
      state: 'paused_by_owner',
      daily_left_pct: null,
      weekly_left_pct: null,
      read_at: null,
      numbers_stale: true,
      last_intent: { action: 'pause', actor: 'user-1', at: '2026-11-26T00:00:00.000Z' },
      keys_active: true,
    }));
    const res = await request(app.getHttpServer()).get('/api/v1/wallets/wallet-1/state');
    expect(res.status).toBe(200);
    expect(res.body.state.state).toBe('paused_by_owner');
    expect(res.body.state.last_intent.action).toBe('pause');
    // No feed row served -> the view keeps the service's nulls + stale.
    expect(res.body.state.daily_left_pct).toBeNull();
    expect(res.body.state.numbers_stale).toBe(true);
  });

  it('GET state reports parked_by_governor with keys_active false', async () => {
    consoleService.getWalletState.mockImplementationOnce(async (): Promise<WalletStateView> => ({
      wallet_id: 'wallet-1',
      name: 'MAIN',
      state: 'parked_by_governor',
      daily_left_pct: null,
      weekly_left_pct: null,
      read_at: null,
      numbers_stale: true,
      last_intent: null,
      keys_active: false,
    }));
    const res = await request(app.getHttpServer()).get('/api/v1/wallets/wallet-1/state');
    expect(res.status).toBe(200);
    expect(res.body.state.state).toBe('parked_by_governor');
    expect(res.body.state.keys_active).toBe(false);
  });
});
