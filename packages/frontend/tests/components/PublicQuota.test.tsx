import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@solidjs/testing-library';
import { MetaProvider } from '@solidjs/meta';
import Quota from '../../src/pages/Quota';
import type { PublicQuotaFeed } from '../../src/services/api/public-quota';

/**
 * The public /quota page always shows three wallet rows — parked wallets keep
 * their numbers, a stale feed shows the STALE badge, and the mobile-width
 * layout is a single column (one .pq-page grid, no sidebar dependency).
 */

const FEED: PublicQuotaFeed = {
  wallets: {
    MAIN: {
      name: 'MAIN',
      display_name: 'MAIN',
      source: 'zai-coding-plan',
      parked: false,
      halted: false,
      used_today_pct: 14.4,
      allowed_today_pct: 14.4,
      weekly_pct_left: 71.6,
      weekly_reset_at: null,
      five_h_pct_left: 60,
      five_h_reset_at: null,
      weekly_spent_pct: 28.4,
      day_number: 2,
      day_index: 1,
      day_start_utc: '10:05',
      week_reset_at: '2026-11-27T23:13:10.000Z',
      ration_model: 'owner-v3',
      pace: 'ON_PACE',
      pace_pct_per_h: 0.8,
      projected_end_pct: 28.8,
      working_hours_left: 1.5,
      projection: 'at this pace: 14.0% left at curfew',
      formula: {
        label: 'allowed today',
        base_pct: 10,
        reserve_pct: 0.4,
        rollover_pool_pct: 4,
        floor_pct: 71.6,
        allowed_today_pct: 14.4,
      },
      stale: false,
      polled_at: '2026-11-22T14:00:00.000Z',
      published: true,
      note: null,
      color: 'indigo',
    },
    MM: {
      name: 'MM',
      display_name: 'MM',
      source: 'minimax-token-plan',
      parked: true,
      halted: false,
      used_today_pct: 5.1,
      allowed_today_pct: 11.5,
      weekly_pct_left: 91,
      weekly_reset_at: null,
      five_h_pct_left: null,
      five_h_reset_at: null,
      weekly_spent_pct: 9,
      pace: 'SLOW',
      pace_pct_per_h: 0.31,
      projected_end_pct: 9.8,
      working_hours_left: 1.5,
      projection: 'at this pace: 5.9% left at curfew',
      formula: {
        label: 'allowed today',
        base_pct: 10,
        reserve_pct: 0.5,
        rollover_pool_pct: 1,
        floor_pct: 91,
        allowed_today_pct: 11.5,
      },
      stale: true,
      polled_at: '2026-11-22T13:00:00.000Z',
      published: true,
      note: null,
      color: 'amber',
    },
    BACKUP: {
      name: 'BACKUP',
      display_name: 'BACKUP',
      source: 'zai-coding-plan',
      parked: false,
      halted: false,
      used_today_pct: 6.9,
      allowed_today_pct: 14.2,
      weekly_pct_left: 17,
      weekly_reset_at: null,
      five_h_pct_left: 40,
      five_h_reset_at: null,
      weekly_spent_pct: 83,
      pace: 'FAST',
      pace_pct_per_h: 2.1,
      projected_end_pct: 95.1,
      working_hours_left: 1.5,
      projection: 'at this pace: line reached in ~0.6h',
      formula: {
        label: 'allowed today',
        base_pct: 10,
        reserve_pct: 0.2,
        rollover_pool_pct: 4,
        floor_pct: 17,
        allowed_today_pct: 14.2,
      },
      stale: false,
      polled_at: '2026-11-22T14:00:00.000Z',
      published: true,
      note: null,
      color: 'sky',
    },
  },
  tick_at: '2026-11-22T18:00:00.000Z',
  generated_at: '2026-11-22T14:00:05.000Z',
  stale: true,
  polled_at: '2026-11-22T14:00:00.000Z',
  ration_available: true,
  ration_unavailable_reason: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Quota (ret500-nodupe public page)', () => {
  it('renders all three wallet rows with the day maths and pace — parked MM stays visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => FEED,
    })));

    render(() => (
      <MetaProvider>
        <Quota />
      </MetaProvider>
    ));

    // The feed loads async — wait for the rows, not the shell.
    await waitFor(() => expect(screen.getByText('MAIN')).toBeTruthy());

    // Every wallet row is present — parked ≠ hidden.
    expect(screen.getByText('MM')).toBeTruthy();
    expect(screen.getByText('BACKUP')).toBeTruthy();

    // Parked badge on MM, never blanking its numbers.
    expect(screen.getByText('PARKED')).toBeTruthy();
    expect(screen.getByText('5.1%')).toBeTruthy();
    expect(screen.getByText('11.5%')).toBeTruthy();

    // Formula strip is the interface: 10 + 0.4 + 4 = 14.4 on MAIN.
    const mainStrip = document.querySelector('section[data-wallet="MAIN"] .pq-formula');
    expect(mainStrip?.textContent).toBe(
      '10.0% base + 0.4% reserve + 4.0% rollover = 14.4% allowed today',
    );

    // Pace statuses render for all three wallets (badge + pace panel each).
    expect(screen.getAllByText('ON PACE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SLOW').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FAST').length).toBeGreaterThan(0);

    // Stale drill visible at the page level (feed.stale) and on the MM row.
    expect(screen.getAllByText('STALE').length).toBeGreaterThan(0);

    // Accessible meter per wallet with the full reading.
    const mmMeter = screen.getByLabelText(/MM: 5.1% used of 11.5% allowed today/);
    expect(mmMeter.getAttribute('aria-label')).toContain('pace SLOW');
    expect(mmMeter.getAttribute('aria-label')).toContain('parked');

    // The mmfs-progress mirror: bar + week left + used + allowed + pace per row.
    const rows = document.querySelectorAll('section[data-wallet]');
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.querySelector('.wc-meter')).toBeTruthy();
      expect(row.querySelector('.wc-pace')).toBeTruthy();
      expect(row.textContent).toContain('week left');
      expect(row.textContent).toContain('used today');
      expect(row.textContent).toContain('allowed today');
    }
  });

  it('shows a HALTED badge for a governor-halted wallet (MM) with numbers still visible', async () => {
    const haltedFeed: PublicQuotaFeed = {
      ...FEED,
      wallets: {
        ...FEED.wallets,
        MM: {
          ...FEED.wallets.MM,
          // MM has no wallet_settings row -> parked is false; the governor
          // halts it (allow=false / halt=true) -> halted is true.
          parked: false,
          halted: true,
          used_today_pct: 17.8,
          allowed_today_pct: 10,
          weekly_pct_left: 87,
          five_h_pct_left: 99,
          stale: false,
          published: true,
          note: null,
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => haltedFeed,
    })));

    render(() => (
      <MetaProvider>
        <Quota />
      </MetaProvider>
    ));

    await waitFor(() => expect(screen.getByText('MM')).toBeTruthy());

    // Halted badge, not the PARKED one.
    expect(screen.getByText('HALTED')).toBeTruthy();
    expect(screen.queryByText('PARKED')).toBeNull();

    // Numbers stay visible while the line is dry.
    expect(screen.getByText('17.8%')).toBeTruthy();
    expect(screen.getByText('87.0%')).toBeTruthy();
    const mmRow = document.querySelector('section[data-wallet="MM"]');
    expect(mmRow?.textContent).toContain('used today');
    expect(mmRow?.textContent).toContain('allowed today');
    expect(mmRow?.textContent).toContain('week left');
  });

  it('shows each wallet on its OWN day clock (day number + own week reset)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => FEED,
    })));

    render(() => (
      <MetaProvider>
        <Quota />
      </MetaProvider>
    ));

    await waitFor(() => expect(screen.getByText('MAIN')).toBeTruthy());

    // The wallet's own ration day + the daily reset clock.
    const mainRow = document.querySelector('section[data-wallet="MAIN"]');
    expect(mainRow?.textContent).toContain('Own day');
    expect(mainRow?.textContent).toContain('day 2/7');
    expect(mainRow?.textContent).toContain('day starts 10:05Z');
    // Its own provider-own week reset anchor.
    expect(mainRow?.textContent).toContain('Own week reset');
  });

  it('keeps serving the page shell when the feed fetch fails — never blanks, offers retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    render(() => (
      <MetaProvider>
        <Quota />
      </MetaProvider>
    ));

    await waitFor(() =>
      expect(screen.getByText(/The quota feed could not be read/)).toBeTruthy(),
    );
    expect(screen.getByText('Quota')).toBeTruthy();
  });
});
