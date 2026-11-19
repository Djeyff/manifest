import {
  callerIsAllowlisted,
  dayWindowStart,
  evaluateWalletBudget,
  inNightWindow,
  isOwnerAnswerTrigger,
  orderCandidates,
  parseWalletBudget,
  resolveWalletBudgetMode,
  triggerHeaderValue,
  walletBudgetMessage,
  weekWindowStart,
  WALLET_NIGHT_WINDOW_DEFAULT,
  type WalletBudgetConfig,
  type WalletGateCallerContext,
} from './wallet-budget';

const NIGHT = { start: '00:30', end: '06:05', offset_minutes: -240 };
/** 06:00Z = 02:00 SDQ — inside the default night window. */
const INSIDE = new Date('2026-11-19T06:00:00.000Z');
/** 14:00Z = 10:00 SDQ — daytime. */
const DAY = new Date('2026-11-19T14:00:00.000Z');

describe('parseWalletBudget', () => {
  it('treats absent/null/empty as ungoverned', () => {
    expect(parseWalletBudget(null).config).toBeNull();
    expect(parseWalletBudget(undefined).config).toBeNull();
    expect(parseWalletBudget('   ').config).toBeNull();
    expect(parseWalletBudget({}).config).toBeNull();
  });

  it('parses a JSON string column value', () => {
    const raw = JSON.stringify({
      daily_usd: 12,
      weekly_usd: 60,
      week_anchor_utc: '04:30',
      night_window: NIGHT,
      allow: ['KaanAssistV2', 'owner-answer'],
    });
    const parsed = parseWalletBudget(raw);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toEqual({
      daily_usd: 12,
      weekly_usd: 60,
      week_anchor_utc: '04:30',
      night_window: NIGHT,
      allow: ['KaanAssistV2', 'owner-answer'],
    });
  });

  it('passes objects straight through', () => {
    expect(parseWalletBudget({ daily_usd: 5 }).config).toEqual({ daily_usd: 5 });
  });

  it('drops malformed pieces with warnings instead of crashing routing', () => {
    const parsed = parseWalletBudget({
      daily_usd: 'twelve',
      weekly_usd: -3,
      week_anchor_utc: '25:99',
      night_window: { start: 'nope', end: '06:05' },
      allow: 'KaanAssistV2',
    });
    // Nothing usable remained → the wallet is ungoverned, never half-governed.
    expect(parsed.config).toBeNull();
    expect(parsed.warnings).toHaveLength(5);
  });

  it('keeps a valid window and defaults its offset to SDQ', () => {
    const parsed = parseWalletBudget({ night_window: { start: '00:30', end: '06:05' } });
    expect(parsed.config?.night_window).toEqual({ start: '00:30', end: '06:05' });
  });

  it('reports invalid JSON as ungoverned, never blocking traffic', () => {
    const parsed = parseWalletBudget('{oops');
    expect(parsed.config).toBeNull();
    expect(parsed.warnings).toEqual(['budget is not valid JSON — wallet ungoverned']);
  });

  it('drops non-string allow entries', () => {
    const parsed = parseWalletBudget({ allow: ['KaanAssistV2', 7, 'owner-answer'] });
    expect(parsed.config?.allow).toEqual(['KaanAssistV2', 'owner-answer']);
    expect(parsed.warnings).toHaveLength(1);
  });
});

describe('resolveWalletBudgetMode', () => {
  it('maps the three postures and falls back to off', () => {
    expect(resolveWalletBudgetMode('shadow')).toBe('shadow');
    expect(resolveWalletBudgetMode(' ENFORCE ')).toBe('enforce');
    expect(resolveWalletBudgetMode('off')).toBe('off');
    expect(resolveWalletBudgetMode(undefined)).toBe('off');
    expect(resolveWalletBudgetMode('shaddow')).toBe('off');
  });
});

describe('inNightWindow', () => {
  it('matches SDQ clock time through the fixed offset', () => {
    expect(inNightWindow(INSIDE, NIGHT)).toBe(true);
    expect(inNightWindow(DAY, NIGHT)).toBe(false);
    expect(inNightWindow(INSIDE, WALLET_NIGHT_WINDOW_DEFAULT)).toBe(true);
  });

  it('supports windows that cross midnight', () => {
    const window = { start: '22:00', end: '06:05', offset_minutes: -240 };
    // 03:30Z = 23:30 SDQ — after the 22:00 start, before the 06:05 end.
    expect(inNightWindow(new Date('2026-11-19T03:30:00.000Z'), window)).toBe(true);
    expect(inNightWindow(DAY, window)).toBe(false);
  });

  it('is never "inside" when start equals end', () => {
    expect(inNightWindow(INSIDE, { start: '00:30', end: '00:30' })).toBe(false);
  });
});

describe('dayWindowStart / weekWindowStart', () => {
  it('opens the day window at SDQ midnight', () => {
    expect(dayWindowStart(INSIDE).toISOString()).toBe('2026-11-19T04:00:00.000Z');
    expect(dayWindowStart(new Date('2026-11-19T03:59:59.000Z')).toISOString()).toBe(
      '2026-11-18T04:00:00.000Z',
    );
  });

  it('anchors the week on Monday at the configured UTC time', () => {
    // 2026-11-19 is a Thursday → week opened Monday 2026-11-16.
    expect(weekWindowStart(INSIDE, '00:00').toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(weekWindowStart(INSIDE, '04:30').toISOString()).toBe('2026-11-16T04:30:00.000Z');
    // Monday 01:00Z with a 02:30 anchor is still the PREVIOUS Monday's week.
    expect(weekWindowStart(new Date('2026-11-16T01:00:00.000Z'), '02:30').toISOString()).toBe(
      '2026-11-09T02:30:00.000Z',
    );
  });
});

describe('owner-answer trigger', () => {
  it('matches only owner- prefixed trigger headers', () => {
    expect(isOwnerAnswerTrigger('owner-1572776073345634304')).toBe(true);
    expect(isOwnerAnswerTrigger('OWNER-9')).toBe(true);
    expect(isOwnerAnswerTrigger(' schedule-sweep ')).toBe(false);
    expect(isOwnerAnswerTrigger('')).toBe(false);
    expect(isOwnerAnswerTrigger(null)).toBe(false);
    expect(isOwnerAnswerTrigger(undefined)).toBe(false);
  });

  it('reads the trigger header case-insensitively off the request headers', () => {
    expect(triggerHeaderValue({ 'x-manifest-trigger': 'owner-42' })).toBe('owner-42');
    expect(triggerHeaderValue({ 'X-Manifest-Trigger': 'owner-42' })).toBe('owner-42');
    expect(triggerHeaderValue({ 'x-manifest-trigger': '  owner-42 ' })).toBe('owner-42');
    expect(triggerHeaderValue({ 'other-header': 'owner-42' })).toBeNull();
    expect(triggerHeaderValue(undefined)).toBeNull();
    expect(triggerHeaderValue({ 'x-manifest-trigger': ['a', 'b'] })).toBeNull();
  });
});

describe('callerIsAllowlisted', () => {
  const allow = ['KaanAssistV2', 'owner-answer'];

  it('matches tier names case-insensitively', () => {
    expect(callerIsAllowlisted(allow, { tierName: 'kaanassistv2' })).toBe(true);
  });

  it('matches agent names', () => {
    expect(callerIsAllowlisted(allow, { agentName: 'KaanAssistV2' })).toBe(true);
  });

  it('admits the owner-answer pseudo-entry only with an owner trigger header', () => {
    expect(
      callerIsAllowlisted(allow, { agentName: 'architect', triggerHeader: 'owner-157' }),
    ).toBe(true);
    expect(callerIsAllowlisted(allow, { agentName: 'architect' })).toBe(false);
    expect(callerIsAllowlisted(allow, { agentName: 'architect', triggerHeader: 'cron-digest' })).toBe(
      false,
    );
  });

  it('never matches unknown callers', () => {
    expect(callerIsAllowlisted(allow, {})).toBe(false);
    expect(callerIsAllowlisted([], { tierName: 'KaanAssistV2' })).toBe(false);
    expect(callerIsAllowlisted(null, { tierName: 'KaanAssistV2' })).toBe(false);
  });
});

describe('evaluateWalletBudget', () => {
  const config: WalletBudgetConfig = {
    daily_usd: 12,
    weekly_usd: 60,
    night_window: NIGHT,
    allow: ['KaanAssistV2', 'owner-answer'],
  };

  it('rejects on the daily cap with a spend-vs-line receipt', () => {
    const decision = evaluateWalletBudget(
      config,
      { day_usd: 12, week_usd: 20 },
      { agentName: 'architect' },
      DAY,
    );
    expect(decision).toEqual({
      allowed: false,
      rule: 'daily_cap',
      detail: 'day spend 12.00 USD >= daily line 12.00 USD',
    });
  });

  it('falls through to the weekly cap when the day is under', () => {
    const decision = evaluateWalletBudget(
      config,
      { day_usd: 3, week_usd: 60 },
      { agentName: 'architect' },
      DAY,
    );
    expect(decision).toEqual({
      allowed: false,
      rule: 'weekly_cap',
      detail: 'week spend 60.00 USD >= weekly line 60.00 USD',
    });
  });

  it('rejects non-allowlisted callers inside the night window', () => {
    const decision = evaluateWalletBudget(
      config,
      { day_usd: 1, week_usd: 2 },
      { agentName: 'autonomous-sweeper' },
      INSIDE,
    );
    expect(decision).toEqual({
      allowed: false,
      rule: 'night_window',
      detail: 'inside night window 00:30-06:05 (SDQ) and caller is not allowlisted',
    });
  });

  it('admits allowlisted and owner-answer callers inside the night window', () => {
    expect(
      evaluateWalletBudget(config, { day_usd: 1, week_usd: 2 }, { tierName: 'KaanAssistV2' }, INSIDE)
        .allowed,
    ).toBe(true);
    expect(
      evaluateWalletBudget(
        config,
        { day_usd: 1, week_usd: 2 },
        { agentName: 'architect', triggerHeader: 'owner-1' },
        INSIDE,
      ).allowed,
    ).toBe(true);
  });

  it('never lets the allowlist bypass a hard cap', () => {
    const decision = evaluateWalletBudget(
      config,
      { day_usd: 99, week_usd: 20 },
      { tierName: 'KaanAssistV2' },
      INSIDE,
    );
    expect(decision).toEqual({ allowed: false, rule: 'daily_cap', detail: expect.any(String) });
  });

  it('admits under-line spend outside the window', () => {
    expect(
      evaluateWalletBudget(config, { day_usd: 11.99, week_usd: 20 }, { agentName: 'architect' }, DAY)
        .allowed,
    ).toBe(true);
  });
});

describe('orderCandidates', () => {
  const keys = [
    { label: 'main', id: 'w1' },
    { label: 'reserve', id: 'w2' },
    { label: 'zai-3', id: 'w3' },
  ];

  it('moves the pinned wallet to the front, preserving the rest of the chain', () => {
    expect(orderCandidates(keys, 'reserve')).toEqual([
      { label: 'reserve', id: 'w2' },
      { label: 'main', id: 'w1' },
      { label: 'zai-3', id: 'w3' },
    ]);
    expect(orderCandidates(keys, 'MAIN')).toEqual([
      { label: 'main', id: 'w1' },
      { label: 'reserve', id: 'w2' },
      { label: 'zai-3', id: 'w3' },
    ]);
  });

  it('returns the chain untouched without a pin or with an unknown pin', () => {
    expect(orderCandidates(keys, null)).toEqual(keys);
    expect(orderCandidates(keys, 'ghost')).toEqual(keys);
  });
});

describe('walletBudgetMessage', () => {
  const config: WalletBudgetConfig = {
    daily_usd: 12,
    weekly_usd: 60,
    night_window: NIGHT,
    allow: [],
  };

  it('names the wallet, rule, and spend vs line for the caps', () => {
    expect(
      walletBudgetMessage(
        'main',
        { allowed: false, rule: 'daily_cap', detail: 'x' },
        config,
        { day_usd: 12, week_usd: 20 },
      ),
    ).toEqual({
      metric: 'main wallet daily cap',
      used: '12.00 USD',
      threshold: '12.00 USD',
      period: 'today (SDQ)',
    });
    expect(
      walletBudgetMessage(
        'main',
        { allowed: false, rule: 'weekly_cap', detail: 'x' },
        config,
        { day_usd: 1, week_usd: 60 },
      ),
    ).toEqual({
      metric: 'main wallet weekly cap',
      used: '60.00 USD',
      threshold: '60.00 USD',
      period: 'this week',
    });
  });

  it('names the window for night-window blocks', () => {
    expect(
      walletBudgetMessage(
        'main',
        { allowed: false, rule: 'night_window', detail: 'x' },
        config,
        { day_usd: 1, week_usd: 2 },
      ),
    ).toEqual({
      metric: 'main wallet night window',
      used: 'blocked',
      threshold: '00:30-06:05 SDQ',
      period: 'night; allowlisted callers and owner answers only',
    });
  });
});

describe('WalletGateCallerContext typing smoke', () => {
  it('accepts the shapes the proxy builds', () => {
    const caller: WalletGateCallerContext = {
      agentName: 'architect',
      tierName: 'Architect',
      triggerHeader: 'owner-1',
    };
    expect(callerIsAllowlisted(['architect'], caller)).toBe(true);
  });
});
