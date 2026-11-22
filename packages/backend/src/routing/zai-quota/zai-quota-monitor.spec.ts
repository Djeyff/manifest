import {
  ZAI_MONITOR_QUOTA_PATH,
  emptyLabelSnapshot,
  parseZaiQuotaLimitPayload,
} from './zai-quota-monitor';

/** Documented live payload shape (monitor envelope + data.limits rows). */
const WINDOWED_PAYLOAD = {
  success: true,
  code: 0,
  msg: 'ok',
  data: {
    level: 'lite',
    limits: [
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        percentage: 40,
        remaining: 1200,
        nextResetTime: 1799990400000,
      },
      {
        type: 'TOKENS_LIMIT',
        unit: 6,
        number: 1,
        percentage: 10,
        remaining: 9000,
        nextResetTime: 1800595200000,
      },
    ],
  },
};

describe('parseZaiQuotaLimitPayload (RET-595)', () => {
  it('keeps the documented monitor path constant', () => {
    expect(ZAI_MONITOR_QUOTA_PATH).toBe('/api/monitor/usage/quota/limit');
  });

  it('routes unit/number pairs to the 5-hour and weekly windows', () => {
    const parsed = parseZaiQuotaLimitPayload(WINDOWED_PAYLOAD);
    expect(parsed.five_h_pct_left).toBe(60);
    expect(parsed.weekly_pct_left).toBe(90);
    expect(parsed.five_h_reset_at).toBe(new Date(1799990400000).toISOString());
    expect(parsed.weekly_reset_at).toBe(new Date(1800595200000).toISOString());
    expect(parsed.plan_level).toBe('lite');
  });

  it('accepts string-typed unit/number/percentage fields', () => {
    const payload = {
      success: true,
      data: {
        limits: [
          { unit: '3', number: '5', percentage: '25', nextResetTime: '1799990400000' },
          { unit: '6', number: '1', percentage: '75', nextResetTime: '1800595200000' },
        ],
      },
    };
    const parsed = parseZaiQuotaLimitPayload(payload);
    expect(parsed.five_h_pct_left).toBe(75);
    expect(parsed.weekly_pct_left).toBe(25);
    expect(parsed.five_h_reset_at).toBe(new Date(1799990400000).toISOString());
  });

  it('computes % left from remaining/limit when percentage is absent', () => {
    const payload = {
      success: true,
      data: {
        limits: [{ unit: 3, number: 5, remaining: 500, limit: 2000 }],
      },
    };
    const parsed = parseZaiQuotaLimitPayload(payload);
    expect(parsed.five_h_pct_left).toBe(25);
    expect(parsed.five_h_reset_at).toBeNull();
  });

  it('reads a legacy TOKENS_LIMIT row without unit/number as the 5-hour window', () => {
    const payload = {
      success: true,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', percentage: 55, remaining: 900, nextResetTime: 1799990400000 },
        ],
      },
    };
    const parsed = parseZaiQuotaLimitPayload(payload);
    expect(parsed.five_h_pct_left).toBe(45);
    expect(parsed.weekly_pct_left).toBeNull();
  });

  it('routes CREDIT_LIMIT rows by the same unit/number pairs', () => {
    const payload = {
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 99 },
          { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 0 },
        ],
      },
    };
    const parsed = parseZaiQuotaLimitPayload(payload);
    expect(parsed.five_h_pct_left).toBe(1);
    expect(parsed.weekly_pct_left).toBe(100);
  });

  it('maps envelope success=false to inactive_or_free with null gauges', () => {
    const parsed = parseZaiQuotaLimitPayload({
      code: 1001,
      msg: 'Authentication parameter not received in Header, unable to authenticate',
      success: false,
    });
    expect(parsed.subscription_status).toBe('inactive_or_free');
    expect(parsed.five_h_pct_left).toBeNull();
    expect(parsed.weekly_pct_left).toBeNull();
    expect(parsed.five_h_reset_at).toBeNull();
    expect(parsed.weekly_reset_at).toBeNull();
  });

  it('clamps impossible percentages into 0-100', () => {
    const payload = {
      success: true,
      data: {
        limits: [
          { unit: 3, number: 5, percentage: -30 },
          { unit: 6, number: 1, percentage: 260 },
        ],
      },
    };
    const parsed = parseZaiQuotaLimitPayload(payload);
    expect(parsed.five_h_pct_left).toBe(100);
    expect(parsed.weekly_pct_left).toBe(0);
  });

  it('ignores unknown unit/number pairs instead of guessing a window', () => {
    const payload = {
      success: true,
      data: {
        limits: [{ unit: 9, number: 9, percentage: 50, nextResetTime: 1799990400000 }],
      },
    };
    const parsed = parseZaiQuotaLimitPayload(payload);
    expect(parsed.five_h_pct_left).toBeNull();
    expect(parsed.weekly_pct_left).toBeNull();
    expect(parsed.five_h_reset_at).toBeNull();
  });

  it('never throws on shape surprises (missing data, junk rows, scalars)', () => {
    expect(parseZaiQuotaLimitPayload(null).five_h_pct_left).toBeNull();
    expect(parseZaiQuotaLimitPayload('nope').weekly_pct_left).toBeNull();
    expect(parseZaiQuotaLimitPayload({ success: true }).plan_level).toBeNull();
    expect(
      parseZaiQuotaLimitPayload({ success: true, data: { limits: [null, 7, 'x'] } })
        .five_h_pct_left,
    ).toBeNull();
    expect(
      parseZaiQuotaLimitPayload({ success: true, data: { limits: [{ unit: 3, number: 5, percentage: 'NaN-ish' }] } })
        .five_h_pct_left,
    ).toBeNull();
  });

  it('surfaces non-finite nextResetTime as a null reset, not garbage', () => {
    const payload = {
      success: true,
      data: { limits: [{ unit: 3, number: 5, percentage: 10, nextResetTime: 0 }] },
    };
    expect(parseZaiQuotaLimitPayload(payload).five_h_reset_at).toBeNull();
  });

  it('emptyLabelSnapshot starts fully unknown with the label pinned', () => {
    expect(emptyLabelSnapshot('RCR')).toEqual({
      label: 'RCR',
      five_h_pct_left: null,
      weekly_pct_left: null,
      five_h_reset_at: null,
      weekly_reset_at: null,
      plan_level: null,
      subscription_status: null,
      seen_at: null,
      error: null,
    });
  });
});
