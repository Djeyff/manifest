import {
  MINIMAX_QUOTA_BASE_DEFAULT,
  MINIMAX_QUOTA_PATH,
  parseMinimaxSubscriptionBlob,
  parseMinimaxTokenPlanRemainsPayload,
} from './minimax-quota-monitor';

/** Live shape captured from the crew's own keys (probe 2026-11-12). */
const LIVE_BODY = {
  model_remains: [
    {
      start_time: 1794479705026,
      end_time: 1794497705026,
      remains_time: 6925134,
      current_interval_total_count: 0,
      current_interval_usage_count: 0,
      model_name: 'general',
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1794261570826,
      weekly_end_time: 1794866370826,
      weekly_remains_time: 375590934,
      current_interval_status: 2,
      current_interval_remaining_percent: 0,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 58,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

describe('minimax-quota-monitor (RET-598-FU7-GW)', () => {
  describe('parseMinimaxTokenPlanRemainsPayload', () => {
    it('parses the live payload into the shared feed gauges', () => {
      const parsed = parseMinimaxTokenPlanRemainsPayload(LIVE_BODY);
      expect(parsed.five_h_pct_left).toBe(0);
      expect(parsed.weekly_pct_left).toBe(58);
      expect(parsed.five_h_reset_at).toBe(new Date(1794497705026).toISOString());
      expect(parsed.weekly_reset_at).toBe(new Date(1794866370826).toISOString());
      expect(parsed.plan_level).toBeNull();
      expect(parsed.subscription_status).toBe('active');
      expect(parsed.plan_status_code).toBe(0);
    });

    it('keeps percentages inside 0-100 even when upstream drifts', () => {
      const body = {
        model_remains: [
          { model_name: 'general', current_interval_remaining_percent: 137, current_weekly_remaining_percent: -4 },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      };
      const parsed = parseMinimaxTokenPlanRemainsPayload(body);
      expect(parsed.five_h_pct_left).toBe(100);
      expect(parsed.weekly_pct_left).toBe(0);
    });

    it('prefers the general row when several model rows are present', () => {
      const body = {
        model_remains: [
          { model_name: 'video', current_interval_remaining_percent: 11, current_weekly_remaining_percent: 12 },
          { model_name: 'general', current_interval_remaining_percent: 21, current_weekly_remaining_percent: 22 },
        ],
        base_resp: { status_code: 0, status_msg: 'success' },
      };
      const parsed = parseMinimaxTokenPlanRemainsPayload(body);
      expect(parsed.five_h_pct_left).toBe(21);
      expect(parsed.weekly_pct_left).toBe(22);
    });

    it('reports a rejected key as an envelope failure, not a healthy empty poll', () => {
      const body = { base_resp: { status_code: 2049, status_msg: 'invalid api key' } };
      const parsed = parseMinimaxTokenPlanRemainsPayload(body);
      expect(parsed.five_h_pct_left).toBeNull();
      expect(parsed.weekly_pct_left).toBeNull();
      expect(parsed.subscription_status).toBeNull();
      expect(parsed.plan_status_code).toBe(2049);
      expect(parsed.plan_status_msg).toBe('invalid api key');
    });

    it('never throws on garbage shapes', () => {
      for (const junk of [null, undefined, 42, 'x', [], {}, { model_remains: 'nope' }, { model_remains: [null, 7] }]) {
        const parsed = parseMinimaxTokenPlanRemainsPayload(junk);
        expect(parsed.five_h_pct_left).toBeNull();
        expect(parsed.weekly_pct_left).toBeNull();
        expect(parsed.subscription_status).toBeNull();
      }
    });

    it('exposes the documented path + default base', () => {
      expect(MINIMAX_QUOTA_PATH).toBe('/v1/token_plan/remains');
      expect(MINIMAX_QUOTA_BASE_DEFAULT).toBe('https://api.minimax.io');
    });
  });

  describe('parseMinimaxSubscriptionBlob', () => {
    it('extracts the access token and https resource origin', () => {
      const parts = parseMinimaxSubscriptionBlob(
        JSON.stringify({ t: 'sk-cp-test-token', r: 'rt-123', e: 4102444800000, u: 'https://api.minimax.io/anthropic/v1' }),
      );
      expect(parts).not.toBeNull();
      expect(parts?.accessToken).toBe('sk-cp-test-token');
      expect(parts?.resourceOrigin).toBe('https://api.minimax.io');
    });

    it('returns null for non-JSON, non-objects and tokenless blobs', () => {
      expect(parseMinimaxSubscriptionBlob('not-json')).toBeNull();
      expect(parseMinimaxSubscriptionBlob('"bare-string"')).toBeNull();
      expect(parseMinimaxSubscriptionBlob(JSON.stringify({ r: 'rt', e: 1 }))).toBeNull();
      expect(parseMinimaxSubscriptionBlob(JSON.stringify({ t: '', r: 'rt', e: 1 }))).toBeNull();
    });

    it('falls back to a null origin for http or malformed resource URLs', () => {
      const insecure = parseMinimaxSubscriptionBlob(JSON.stringify({ t: 'tok', u: 'http://api.minimax.io/anthropic/v1' }));
      expect(insecure?.resourceOrigin).toBeNull();
      const malformed = parseMinimaxSubscriptionBlob(JSON.stringify({ t: 'tok', u: '::nope' }));
      expect(malformed?.accessToken).toBe('tok');
      expect(malformed?.resourceOrigin).toBeNull();
    });
  });
});
