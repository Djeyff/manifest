import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WalletIntentControl from '../../src/components/wallet-console/WalletIntentControl';
import type { WalletAuditRow, WalletState } from '../../src/services/api/wallet-settings';

/**
 * RET-776-C — the owner pause/unpause control (architect decision DC3).
 *
 * The four states the control must render — running, paused by owner,
 * parked by the governor, and a stale read — plus the confirmation dialog
 * and the refusals. Every test mocks the HTTP layer: the live backend does
 * not serve these routes until PR #17 is merged AND rolled.
 */

const EVIDENCE_DIR = join(process.cwd(), 'evidence');

/** Write the rendered DOM of a state as the architect's evidence class. */
function dumpEvidence(name: string, html: string): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, `ret776c-${name}.html`), html, 'utf8');
}

function state(overrides: Partial<WalletState> = {}): WalletState {
  return {
    wallet_id: 'w-main',
    name: 'MAIN',
    state: 'running',
    daily_left_pct: 42,
    weekly_left_pct: 71,
    read_at: '2026-11-26T09:12:00.000Z',
    numbers_stale: false,
    last_intent: null,
    keys_active: true,
    ...overrides,
  };
}

const AUDIT: WalletAuditRow[] = [
  {
    id: 'a1',
    wallet_id: 'w-main',
    tenant_id: 't1',
    actor_user_id: 'owner-1',
    action: 'intent.pause',
    before: null,
    after: null,
    ruling_id: 'r-1',
    created_at: '2026-11-26T09:00:00.000Z',
  },
  {
    id: 'a2',
    wallet_id: 'w-main',
    tenant_id: 't1',
    actor_user_id: 'owner-1',
    action: 'intent.resume',
    before: null,
    after: null,
    ruling_id: 'r-2',
    created_at: '2026-11-25T18:00:00.000Z',
  },
  {
    id: 'a3',
    wallet_id: 'w-main',
    tenant_id: 't1',
    actor_user_id: 'owner-1',
    action: 'settings.update',
    before: null,
    after: null,
    ruling_id: 'r-3',
    created_at: '2026-11-24T18:00:00.000Z',
  },
];

/** The mocked route table: path → responder. */
let routes: Record<string, () => { status: number; body: unknown }> = {};

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(routes).find((path) => url.includes(path));
      if (!key) {
        return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
      }
      const { status, body } = routes[key]!();
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function route(path: string, responder: () => { status: number; body: unknown }) {
  routes[path] = responder;
}

beforeEach(() => {
  routes = {};
  mockFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render the control with the given live state. */
async function renderControl(options: {
  live?: WalletState;
  owner?: boolean;
}) {
  const live = options.live ?? state();
  route('/state', () => ({ status: 200, body: { state: live } }));
  route('/settings/audit', () => ({ status: 200, body: { audit: AUDIT } }));
  const result = render(() => (
    <WalletIntentControl
      walletId="w-main"
      walletName="MAIN (Z.AI Max)"
      access={{ owner: options.owner ?? true, available: true }}
    />
  ));
  await waitFor(() => {
    expect(screen.queryByText('Reading wallet state…')).toBeNull();
  });
  return result;
}

describe('WalletIntentControl — the four states', () => {
  it('running → offers [Pause wallet] and shows the read time', async () => {
    const { container } = await renderControl({ live: state({ state: 'running' }) });

    expect(screen.getByRole('button', { name: 'Pause wallet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unpause wallet' })).toBeNull();
    expect(screen.getByText(/Last read:/)).toBeTruthy();
    dumpEvidence('running', container.innerHTML);
  });

  it('paused by owner → offers [Unpause wallet]', async () => {
    const { container } = await renderControl({
      live: state({ state: 'paused_by_owner' }),
    });

    expect(screen.getByRole('button', { name: 'Unpause wallet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause wallet' })).toBeNull();
    expect(screen.getByText('Paused by owner')).toBeTruthy();
    dumpEvidence('paused', container.innerHTML);
  });

  it('parked by the governor → the control is disabled and says so', async () => {
    const { container } = await renderControl({
      live: state({ state: 'parked_by_governor' }),
    });

    const button = screen.getByRole('button', {
      name: 'Pause / unpause wallet',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      screen.getByText('Parked by the governor — it comes back on its own.'),
    ).toBeTruthy();
    dumpEvidence('parked', container.innerHTML);
  });

  it('a stale read is announced but the control stays usable', async () => {
    const { container } = await renderControl({
      live: state({ state: 'running', numbers_stale: true }),
    });

    expect(
      screen.getByText(/These numbers are older than the server's own freshness window/),
    ).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Pause wallet' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    dumpEvidence('stale', container.innerHTML);
  });

  it('a non-owner never sees the control', async () => {
    route('/state', () => ({ status: 200, body: { state: state() } }));
    const { container } = render(() => (
      <WalletIntentControl
        walletId="w-main"
        walletName="MAIN"
        access={{ owner: false, available: true }}
      />
    ));
    await waitFor(() => {
      expect(container.querySelector('.wc-panel')).toBeNull();
    });
  });
});

describe('WalletIntentControl — the confirmation dialog', () => {
  it('a pause asks for confirmation first, with the owner-facing copy', async () => {
    await renderControl({ live: state({ state: 'running' }) });

    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(
      screen.getByText(
        'Traffic on this wallet moves to the next wallet in the fallback order. The governor still decides when it comes back.',
      ),
    ).toBeTruthy();
    // Nothing is sent until the owner confirms.
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/intent'),
      expect.anything(),
    );
  });

  it('Escape closes the dialog and focus returns to the trigger', async () => {
    await renderControl({ live: state({ state: 'running' }) });

    const trigger = screen.getByRole('button', { name: 'Pause wallet' }) as HTMLButtonElement;
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('confirming sends the intent, re-reads the state and renders the server answer', async () => {
    let posts = 0;
    let reads = 0;
    route('/state', () => {
      reads += 1;
      // The server now reports the wallet as paused.
      const live =
        reads === 1
          ? state({ state: 'running' })
          : state({ state: 'paused_by_owner', read_at: '2026-11-26T09:30:00.000Z' });
      return { status: 200, body: { state: live } };
    });
    route('/intent', () => {
      posts += 1;
      return {
        status: 200,
        body: {
          changed: true,
          action: 'pause',
          accounts: ['acc-1'],
          intent: {
            action: 'pause',
            actor: 'owner-1',
            reason: null,
            at: '2026-11-26T09:30:00.000Z',
          },
          audit_id: 'audit-9',
          ruling: { id: 'r-9', minted_at: '2026-11-26T09:30:00.000Z', persisted: true },
          state: state({ state: 'paused_by_owner' }),
        },
      };
    });
    route('/settings/audit', () => ({ status: 200, body: { audit: AUDIT } }));

    render(() => (
      <WalletIntentControl
        walletId="w-main"
        walletName="MAIN"
        access={{ owner: true, available: true }}
      />
    ));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause wallet' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, pause this wallet' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Unpause wallet' })).toBeTruthy();
    });
    expect(posts).toBe(1);
    // The state was RE-READ after the POST — never an optimistic "Paused".
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Paused by owner')).toBeTruthy();
  });

  it('the last five intent rows are shown with who and when', async () => {
    await renderControl({ live: state({ state: 'running' }) });

    await waitFor(() => {
      expect(screen.getByText(/intent\.pause/)).toBeTruthy();
    });
    expect(screen.getByText(/intent\.resume/)).toBeTruthy();
    // A settings row is not an intent row.
    expect(screen.queryByText(/settings\.update/)).toBeNull();
    expect(screen.getAllByText(/owner-1/).length).toBeGreaterThan(0);
  });
});

describe('WalletIntentControl — refusals', () => {
  it('a 403 says only the workspace owner can pause or unpause', async () => {
    route('/state', () => ({ status: 403, body: { message: 'Forbidden' } }));
    route('/settings/audit', () => ({ status: 200, body: { audit: [] } }));

    render(() => (
      <WalletIntentControl
        walletId="w-main"
        walletName="MAIN"
        access={{ owner: true, available: true }}
      />
    ));

    await waitFor(() => {
      expect(
        screen.getByText('Only the workspace owner can pause or unpause wallets.'),
      ).toBeTruthy();
    });
  });

  it('a 400 shows the server’s own sentence', async () => {
    route('/state', () => ({ status: 200, body: { state: state({ state: 'running' }) } }));
    route('/settings/audit', () => ({ status: 200, body: { audit: [] } }));
    route('/intent', () => ({
      status: 400,
      body: { message: 'Wallet has no governed account.' },
    }));

    render(() => (
      <WalletIntentControl
        walletId="w-main"
        walletName="MAIN"
        access={{ owner: true, available: true }}
      />
    ));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause wallet' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, pause this wallet' }));

    await waitFor(() => {
      expect(screen.getByText('Wallet has no governed account.')).toBeTruthy();
    });
  });

  it('any other failure leaves a retry line', async () => {
    route('/state', () => ({ status: 200, body: { state: state({ state: 'running' }) } }));
    route('/settings/audit', () => ({ status: 200, body: { audit: [] } }));
    route('/intent', () => ({ status: 500, body: { message: 'boom' } }));

    render(() => (
      <WalletIntentControl
        walletId="w-main"
        walletName="MAIN"
        access={{ owner: true, available: true }}
      />
    ));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Pause wallet' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Pause wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, pause this wallet' }));

    await waitFor(() => {
      expect(screen.getByText(/The server refused the request \(500\)/)).toBeTruthy();
    });
  });
});
