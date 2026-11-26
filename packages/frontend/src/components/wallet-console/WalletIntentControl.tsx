import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import {
  fetchWalletAudit,
  fetchWalletState,
  intentRowsFromAudit,
  postWalletIntent,
  WalletApiError,
  type WalletAuditRow,
  type WalletState,
} from '../../services/api/wallet-settings.js';
import { Callout, Pill } from './Console.js';
import './wallet-console.css';

/**
 * Owner pause / unpause control for one wallet (RET-776-C).
 *
 * The control lives on `/wallets/settings`, one block per wallet. The
 * tier-builder dropdowns show a READ-ONLY state pill only (architect
 * decision DC1): an action inside a tier form control would read as
 * "editing the tier".
 *
 * Rules the component keeps (architect decision DC3):
 *
 *   - the button reflects the state the SERVER last reported — never an
 *     optimistic guess; after a click the state is RE-READ before anything
 *     is shown;
 *   - a pause is confirmed first, and the dialog is a real accessible
 *     dialog (focus moves in, Escape closes, focus returns to the trigger);
 *   - a parked wallet's control is disabled with the governor's own words;
 *   - the numbers carry their read time, and a stale read is announced but
 *     leaves the control usable.
 */

/** The copy the owner asked for, verbatim. */
const CONFIRM_COPY =
  'Traffic on this wallet moves to the next wallet in the fallback order. The governor still decides when it comes back.';

/** The refusal shown when the server says "not the owner". */
const OWNER_ONLY = 'Only the workspace owner can pause or unpause wallets.';

export interface WalletIntentControlProps {
  walletId: string;
  /** Display name of the wallet (e.g. `MAIN (Z.AI Max)`). */
  walletName: string;
  /** Owner gate verdict — the same gate the settings surface uses. */
  access?: { owner: boolean; available?: boolean } | null;
}

/** The tone of the state pill for one wallet state. */
function pillTone(state: WalletState['state']): 'ok' | 'warn' | 'neutral' {
  if (state === 'running') return 'ok';
  if (state === 'paused_by_owner') return 'warn';
  return 'neutral';
}

/** The label of the state pill. */
function pillLabel(state: WalletState['state']): string {
  if (state === 'running') return 'Running';
  if (state === 'paused_by_owner') return 'Paused by owner';
  return 'Parked by governor';
}

/** Read time in the owner's own timezone. */
function formatReadAt(readAt: string | null): string {
  if (!readAt) return 'never';
  const parsed = new Date(readAt);
  if (Number.isNaN(parsed.getTime())) return readAt;
  return parsed.toLocaleString();
}

/** The refusal sentence for a failed read. */
function readErrorMessage(err: unknown): string {
  if (err instanceof WalletApiError) {
    if (err.status === 403) return OWNER_ONLY;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Could not read the wallet state.';
}

export default function WalletIntentControl(props: WalletIntentControlProps): JSX.Element {
  /** The state the server last reported. */
  const [state, setState] = createSignal<WalletState | null>(null);
  /** True while the state is being read. */
  const [loading, setLoading] = createSignal(true);
  /** The refusal of the last read, if the read failed. */
  const [readError, setReadError] = createSignal<string | null>(null);
  /** The last five pause/resume rows of the wallet's audit trail. */
  const [rows, setRows] = createSignal<WalletAuditRow[]>([]);

  /** Which intent is waiting for confirmation, if any. */
  const [confirming, setConfirming] = createSignal<'pause' | 'resume' | null>(null);
  /** True while the intent is in flight. */
  const [busy, setBusy] = createSignal(false);
  /** The last error of the last intent, verbatim from the server where it gave one. */
  const [error, setError] = createSignal<string | null>(null);
  /** A short note after a successful round-trip. */
  const [note, setNote] = createSignal<string | null>(null);

  let triggerRef: HTMLButtonElement | undefined;
  let dialogRef: HTMLDivElement | undefined;

  // The owner gate: a non-owner never sees the control.
  const owner = () => props.access?.owner === true;

  /**
   * Read the state of the wallet — and the intent rows of its audit trail.
   *
   * Both are read again after an intent, so the panel never shows a state
   * the server has not confirmed.
   */
  const load = async () => {
    setLoading(true);
    try {
      const live = await fetchWalletState(props.walletId);
      setState(live);
      setReadError(null);
    } catch (err) {
      setState(null);
      setReadError(readErrorMessage(err));
    }
    try {
      const audit = await fetchWalletAudit(props.walletId);
      setRows(intentRowsFromAudit(audit));
    } catch {
      // The audit trail is context, not the control: a failed read leaves the
      // list empty rather than breaking the panel.
      setRows([]);
    }
    setLoading(false);
  };

  onMount(() => {
    void load();
  });

  // Move focus into the dialog when it opens, and back to the trigger when
  // it closes — the dialog is keyboard-reachable end to end.
  createEffect(() => {
    if (confirming() && dialogRef) {
      const first = dialogRef.querySelector<HTMLElement>('button, [href], input, select');
      (first ?? dialogRef).focus();
    }
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && confirming()) {
      event.preventDefault();
      closeDialog();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  onCleanup(() => document.removeEventListener('keydown', onKeyDown));

  /** Close the dialog and hand focus back to the button that opened it. */
  const closeDialog = () => {
    setConfirming(null);
    triggerRef?.focus();
  };

  /**
   * Run the intent, then RE-READ the state.
   *
   * The panel shows nothing new until the server has answered twice: the
   * POST confirms the write, the GET confirms the resulting state.
   */
  const runIntent = async (action: 'pause' | 'resume') => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await postWalletIntent(props.walletId, action);
      await load();
      setNote(
        action === 'pause'
          ? 'Pause requested — the state above is what the server reports now.'
          : 'Unpause requested — the state above is what the server reports now.',
      );
    } catch (err) {
      if (err instanceof WalletApiError) {
        setError(
          err.status === 403
            ? OWNER_ONLY
            : err.status === 400
              ? err.message
              : `The server refused the request (${err.status}). Try again in a moment.`,
        );
      } else {
        setError(err instanceof Error ? err.message : 'Could not reach the server. Try again.');
      }
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  /** The action the current state invites. */
  const action = (): 'pause' | 'resume' | null => {
    const current = state();
    if (!current) return null;
    if (current.state === 'running') return 'pause';
    if (current.state === 'paused_by_owner') return 'resume';
    return null;
  };

  /** The label of the main control button. */
  const actionLabel = () => (action() === 'pause' ? 'Pause wallet' : 'Unpause wallet');

  return (
    <Show when={owner()}>
      <div class="wc-panel" aria-labelledby={`intent-${props.walletId}`}>
        <div class="wc-panel__title" id={`intent-${props.walletId}`}>
          Pause / unpause <span class="sub">owner control · {props.walletName}</span>
        </div>

        <Show
          when={state()}
          fallback={
            <Show
              when={readError()}
              fallback={
                <div class="wc-state" role="status">
                  {loading() ? 'Reading wallet state…' : 'No wallet state yet.'}
                </div>
              }
            >
              {(message) => (
                <div role="alert">
                  <Callout tone="danger">{message()}</Callout>
                </div>
              )}
            </Show>
          }
        >
          {(current) => (
            <>
              <p class="wc-note">
                <Pill tone={pillTone(current().state)}>{pillLabel(current().state)}</Pill>{' '}
                <span class="wc-field__hint">
                  Last read: {formatReadAt(current().read_at)}
                  {current().numbers_stale ? ' · numbers may be out of date' : ''}
                </span>
              </p>

              <Show when={current().numbers_stale || !current().read_at}>
                <p class="wc-field__hint" role="status">
                  These numbers are older than the server&apos;s own freshness window. The control
                  still works — the state you see is the last state the server reported.
                </p>
              </Show>

              <Show when={current().state === 'parked_by_governor'}>
                <p class="wc-field__hint">Parked by the governor — it comes back on its own.</p>
              </Show>

              <div>
                <span class="wc-field__label">Owner control</span>
                <Show
                  when={action()}
                  fallback={
                    <button
                      class="btn"
                      type="button"
                      disabled
                      aria-describedby={`intent-help-${props.walletId}`}
                    >
                      Pause / unpause wallet
                    </button>
                  }
                >
                  <button
                    ref={triggerRef}
                    class={action() === 'pause' ? 'btn' : 'btn btn--primary'}
                    type="button"
                    disabled={busy()}
                    aria-describedby={`intent-help-${props.walletId}`}
                    onClick={() => setConfirming(action()!)}
                  >
                    {busy() ? 'Working…' : actionLabel()}
                  </button>
                </Show>
                <span class="wc-field__hint" id={`intent-help-${props.walletId}`}>
                  {current().state === 'parked_by_governor'
                    ? 'The governor decides when this wallet comes back, so the control stays off.'
                    : 'Pausing moves traffic to the next wallet in the fallback order.'}
                </span>
              </div>

              <Show when={error()}>
                {(message) => (
                  <div role="alert">
                    <Callout tone="danger">{message()}</Callout>
                  </div>
                )}
              </Show>

              <Show when={note()}>
                {(message) => (
                  <div role="status">
                    <Callout tone="info">{message()}</Callout>
                  </div>
                )}
              </Show>

              <Show when={confirming()}>
                <div
                  class="modal-backdrop"
                  onClick={(event) => {
                    if (event.target === event.currentTarget) closeDialog();
                  }}
                >
                  <div
                    ref={dialogRef}
                    class="modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={`intent-dialog-title-${props.walletId}`}
                    aria-describedby={`intent-dialog-body-${props.walletId}`}
                  >
                    <div class="modal__header">
                      <span class="modal__title" id={`intent-dialog-title-${props.walletId}`}>
                        {confirming() === 'pause' ? 'Pause this wallet?' : 'Unpause this wallet?'}
                      </span>
                    </div>
                    <div class="modal__body" id={`intent-dialog-body-${props.walletId}`}>
                      <p>{CONFIRM_COPY}</p>
                    </div>
                    <div class="modal__footer">
                      <button class="btn" type="button" onClick={closeDialog} disabled={busy()}>
                        Cancel
                      </button>
                      <button
                        class="btn btn--primary"
                        type="button"
                        disabled={busy()}
                        onClick={() => void runIntent(confirming()!)}
                      >
                        {busy()
                          ? 'Working…'
                          : confirming() === 'pause'
                            ? 'Yes, pause this wallet'
                            : 'Yes, unpause this wallet'}
                      </button>
                    </div>
                  </div>
                </div>
              </Show>

              <div class="wc-trail" aria-label="Last pause and unpause intents">
                <div class="wc-panel__title">Recent intents</div>
                <Show
                  when={rows().length > 0}
                  fallback={
                    <div class="wc-state" role="status">
                      No pause or unpause yet.
                    </div>
                  }
                >
                  <For each={rows()}>
                    {(row) => (
                      <div class="wc-trail__row">
                        <span class="wc-trail__time">{row.created_at}</span>
                        <div class="wc-trail__body">
                          {row.action}
                          {row.actor_user_id ? ` · ${row.actor_user_id}` : ' · unknown actor'}
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}
