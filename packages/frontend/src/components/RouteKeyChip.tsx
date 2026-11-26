import { createEffect, createSignal, For, onCleanup, Show, type Component } from 'solid-js';
import type { RoutingProvider } from '../services/api.js';
import { canonicalKeyLabel, type WalletOption } from '../services/api/wallet-options.js';
import { useWalletStates } from '../services/api/wallet-states.js';
import { WalletChip } from './wallet-console/Console.js';
import type { WalletState } from '../services/api/wallet-settings.js';

interface RouteKeyChipProps {
  keys: RoutingProvider[];
  currentLabel?: string | null;
  modelLabel: string;
  usedLabels?: () => Set<string>;
  onPick: (label: string | null) => void | Promise<void>;
  buttonClass: string;
  disabled?: boolean;
  allowClear?: boolean;
  leadingMargin?: boolean;
  menuMinWidth?: number;
  stopPropagation?: boolean;
  /**
   * Wallet options for the route provider (owner order D-2026-11-22-11).
   * When present, the dropdown offers WALLETS instead of raw provider keys:
   * picking a wallet writes that wallet's canonical key label into the route
   * (`keyLabel`), never the wallet display name.
   */
  wallets?: () => WalletOption[];
}

/** The tone of the read-only state pill for a wallet state. */
function stateTone(state: WalletState['state']): string {
  if (state === 'running') return 'running';
  if (state === 'paused_by_owner') return 'paused';
  return 'parked';
}

/** The label of the read-only state pill for a wallet state. */
function stateLabel(state: WalletState['state']): string {
  if (state === 'running') return 'Running';
  if (state === 'paused_by_owner') return 'Paused by owner';
  return 'Parked by governor';
}

const RouteKeyChip: Component<RouteKeyChipProps> = (props) => {
  const [open, setOpen] = createSignal(false);
  // Live wallet states, for the READ-ONLY state pill in the dropdown
  // (architect decision DC1). No action lives here — the pause/unpause
  // control is on /wallets/settings.
  const walletStates = useWalletStates();
  let containerRef: HTMLSpanElement | undefined;

  createEffect(() => {
    if (!open()) return;
    const handler = (e: MouseEvent) => {
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    onCleanup(() => document.removeEventListener('mousedown', handler));
  });

  const stop = (event: Event) => {
    if (props.stopPropagation) event.stopPropagation();
  };

  /** Wallets available for this route, if the caller supplied them. */
  const walletOptions = (): WalletOption[] => props.wallets?.() ?? [];
  /** True when the dropdown lists wallets rather than provider keys. */
  const walletMode = () => walletOptions().length > 0;

  /**
   * The key label a wallet writes: the wallet's canonical key label, i.e. the
   * first member key label in the order the server returned it. The wallet ->
   * key mapping is automatic; the owner never picks a room key.
   */
  const keyLabelForWallet = (wallet: WalletOption): string | undefined => canonicalKeyLabel(wallet);

  /** The wallet that owns the currently pinned key label. */
  const currentWallet = (): WalletOption | undefined => {
    const current = props.currentLabel?.toLowerCase();
    if (!current) return undefined;
    return walletOptions().find((wallet) =>
      wallet.key_labels.some((label) => label.toLowerCase() === current),
    );
  };

  const displayLabel = () => {
    if (walletMode()) {
      const wallet = currentWallet();
      if (wallet) return wallet.display_name;
      const label = props.currentLabel;
      if (label) return label;
      return walletOptions()[0]?.display_name ?? '';
    }
    return props.currentLabel ?? props.keys[0]?.label ?? '';
  };
  const usedLabels = () => props.usedLabels?.() ?? new Set<string>();
  const buttonStyle = () =>
    `background: hsl(var(--muted) / 0.5); border: 1px solid hsl(var(--border)); border-radius: 999px; padding: 2px 8px; font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); cursor: pointer; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;${props.leadingMargin ? ' margin-left: 4px;' : ''}`;
  const menuStyle = () =>
    `position: absolute; top: 100%; right: 0; margin-top: 4px; list-style: none; padding: 4px; min-width: ${props.menuMinWidth ?? 160}px; border: 1px solid hsl(var(--border)); border-radius: 6px; background: hsl(var(--background)); box-shadow: 0 4px 12px hsl(var(--foreground) / 0.08); z-index: 10; display: flex; flex-direction: column; gap: 2px;`;

  return (
    <span ref={containerRef} style="position: relative; display: inline-flex; flex-shrink: 0;">
      <button
        type="button"
        class={props.buttonClass}
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={`${walletMode() ? 'Wallet' : 'API key'} for ${props.modelLabel}: currently ${displayLabel()}. Click to change.`}
        title={displayLabel()}
        disabled={props.disabled}
        onClick={(event) => {
          stop(event);
          setOpen(!open());
        }}
        style={buttonStyle()}
      >
        <span style="overflow: hidden; text-overflow: ellipsis;">{displayLabel()}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <Show when={open()}>
        <ul
          role="listbox"
          aria-label={walletMode() ? 'Choose wallet' : 'Choose API key'}
          onClick={stop}
          style={menuStyle()}
        >
          <Show when={props.allowClear && props.currentLabel}>
            <li>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={(event) => {
                  stop(event);
                  setOpen(false);
                  void props.onPick(null);
                }}
                style="width: 100%; text-align: left; background: none; border: none; padding: 4px 6px; cursor: pointer; border-radius: 4px; font-size: var(--font-size-xs); color: hsl(var(--muted-foreground)); border-bottom: 1px solid hsl(var(--border)); margin-bottom: 2px; padding-bottom: 6px;"
              >
                Clear pin
              </button>
            </li>
          </Show>
          <Show when={walletMode()}>
            <For each={walletOptions()}>
              {(wallet) => {
                const label = () => keyLabelForWallet(wallet);
                const isUsedElsewhere = () => usedLabels().has((label() ?? '').toLowerCase());
                const isSelected = () => {
                  const current = props.currentLabel;
                  if (!current) return false;
                  return wallet.key_labels.some(
                    (keyLabel) => keyLabel.toLowerCase() === current.toLowerCase(),
                  );
                };
                const shouldPick = () => {
                  const current = props.currentLabel;
                  const target = label();
                  if (!target) return false;
                  if (!current) return true;
                  // The wallet already serves the pinned key: no write needed.
                  if (
                    wallet.key_labels.some(
                      (keyLabel) => keyLabel.toLowerCase() === current.toLowerCase(),
                    )
                  )
                    return false;
                  return current.toLowerCase() !== target.toLowerCase();
                };
                // READ-ONLY state of this wallet (architect decision DC1). The
                // dropdown never offers a pause/unpause action.
                const walletState = (): WalletState | undefined => walletStates()[wallet.wallet_id];
                return (
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected()}
                      disabled={props.disabled || isUsedElsewhere()}
                      onClick={(event) => {
                        stop(event);
                        setOpen(false);
                        if (shouldPick()) {
                          void props.onPick(label()!);
                        }
                      }}
                      style={`width: 100%; text-align: left; background: none; border: none; padding: 4px 6px; cursor: pointer; border-radius: 4px; font-size: var(--font-size-xs); color: hsl(var(--foreground)); display: flex; align-items: center; gap: 6px;${isUsedElsewhere() ? ' opacity: 0.4; cursor: not-allowed;' : ''}`}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="8"
                        height="8"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        style={`visibility: ${isSelected() ? 'visible' : 'hidden'}`}
                      >
                        <path d="M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14" />
                      </svg>
                      <span style="display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px;">
                        <span>{wallet.display_name}</span>
                        <span
                          style="font-size: 10px; color: hsl(var(--muted-foreground));"
                          data-testid="wallet-key-label"
                        >
                          {wallet.provider}
                          {label() ? ` · ${label()}` : ''}
                        </span>
                      </span>
                      <Show when={walletState()}>
                        {(current) => (
                          <WalletChip tone={stateTone(current().state)}>
                            {stateLabel(current().state)}
                          </WalletChip>
                        )}
                      </Show>
                    </button>
                  </li>
                );
              }}
            </For>
          </Show>
          <Show when={!walletMode()}>
            <For each={props.keys}>
              {(key) => {
                const isUsedElsewhere = () => usedLabels().has(key.label.toLowerCase());
                const isSelected = () =>
                  props.currentLabel
                    ? props.currentLabel.toLowerCase() === key.label.toLowerCase()
                    : displayLabel().toLowerCase() === key.label.toLowerCase();
                const shouldPick = () =>
                  (props.currentLabel ?? '').toLowerCase() !== key.label.toLowerCase();
                return (
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected()}
                      disabled={props.disabled || isUsedElsewhere()}
                      onClick={(event) => {
                        stop(event);
                        setOpen(false);
                        if (shouldPick()) {
                          void props.onPick(key.label);
                        }
                      }}
                      style={`width: 100%; text-align: left; background: none; border: none; padding: 4px 6px; cursor: pointer; border-radius: 4px; font-size: var(--font-size-xs); color: hsl(var(--foreground)); display: flex; align-items: center; gap: 6px;${isUsedElsewhere() ? ' opacity: 0.4; cursor: not-allowed;' : ''}`}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="8"
                        height="8"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        style={`visibility: ${isSelected() ? 'visible' : 'hidden'}`}
                      >
                        <path d="M12 5a7 7 0 1 0 0 14 7 7 0 1 0 0-14" />
                      </svg>
                      {key.label}
                    </button>
                  </li>
                );
              }}
            </For>
          </Show>
        </ul>
      </Show>
    </span>
  );
};

export default RouteKeyChip;
