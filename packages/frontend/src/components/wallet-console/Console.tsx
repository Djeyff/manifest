import { Show, For, createSignal, type JSX } from 'solid-js';
import type {
  WalletFormulaStrip,
  WalletAuditEntry,
} from '../../services/api/wallet-console';
import './wallet-console.css';

/** Shared primitives for the owner wallet console (RET-721). */

type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'drain' | 'info';

export function Pill(props: { tone: Tone; children: JSX.Element }) {
  return (
    <span class={`wc-pill wc-pill--${props.tone}`}>
      <span class="wc-pill__dot" aria-hidden="true" />
      {props.children}
    </span>
  );
}

export function WalletChip(props: { tone: string; children: JSX.Element }) {
  return (
    <span class={`wc-chip wc-chip--${props.tone}`}>
      <span class="wc-chip__dot" aria-hidden="true" />
      {props.children}
    </span>
  );
}

export function Callout(props: { tone?: 'info' | 'warn' | 'danger'; children: JSX.Element }) {
  const tone = () => props.tone ?? 'info';
  return (
    <div class={`wc-callout wc-callout--${tone()}`}>
      <span aria-hidden="true">{tone() === 'warn' ? '▲' : '◎'}</span>
      <span>{props.children}</span>
    </div>
  );
}

export function Kv(props: { k: string; v: JSX.Element }) {
  return (
    <div class="wc-kv">
      <span class="wc-kv__k">{props.k}</span>
      <span class="wc-kv__v">{props.v}</span>
    </div>
  );
}

/**
 * The formula strip — the arithmetic is the interface. Terms arrive from the
 * server; this component only renders them.
 */
export function Formula(props: {
  formula: WalletFormulaStrip;
  used?: number;
  projected?: number;
  suffix?: JSX.Element;
}) {
  return (
    <div class="wc-formula" role="group" aria-label={`${props.formula.label} calculation`}>
      <span class="wc-formula__label">{props.formula.label}</span>
      <For each={props.formula.terms}>
        {(term) => (
          <>
            <span class="wc-formula__op" aria-hidden="true">
              {term.op || '='}
            </span>
            <span class="wc-formula__term">
              {term.label} <b>{term.value.toFixed(1)}%</b>
            </span>
          </>
        )}
      </For>
      <span class="wc-formula__op" aria-hidden="true">
        =
      </span>
      <span class="wc-formula__result">
        {props.formula.result.value.toFixed(1)}% of line
      </span>
      <Show when={props.used !== undefined}>
        <span class="wc-formula__op" aria-hidden="true">
          ·
        </span>
        <span class="wc-formula__term">
          used <b>{props.used!.toFixed(1)}%</b>
        </span>
      </Show>
      <Show when={props.projected !== undefined}>
        <span class="wc-formula__op" aria-hidden="true">
          →
        </span>
        <span class="wc-formula__term">
          projected at reset <b>{props.projected!.toFixed(1)}%</b>
        </span>
      </Show>
      <Show when={props.formula.ruling_id}>
        <span class="wc-ruling-chip">{props.formula.ruling_id}</span>
      </Show>
      <Show when={props.suffix}>{props.suffix}</Show>
    </div>
  );
}

/** Horizontal meter with a text label — never colour-only. */
export function Meter(props: {
  label: string;
  value: number;
  valueLabel: string;
  sub?: string | null;
  tone?: 'ok' | 'warn';
}) {
  const pct = () => Math.max(0, Math.min(100, props.value));
  return (
    <div class="wc-meter-block">
      <div class="wc-meter-row">
        <span class="wc-meter-row__label">{props.label}</span>
        <span class="wc-meter-row__value">
          {props.valueLabel}
          <Show when={props.sub}>
            <small>{props.sub}</small>
          </Show>
        </span>
      </div>
      <div
        class={`wc-meter${props.tone === 'warn' ? ' wc-meter--warn' : ''}`}
        style={{ '--wc-meter-value': `${pct()}%` }}
        role="img"
        aria-label={`${props.label}: ${props.valueLabel}${props.sub ? `, ${props.sub}` : ''}`}
      >
        <div class="wc-meter__fill" />
      </div>
    </div>
  );
}

export function AuditTrail(props: { entries: WalletAuditEntry[] }) {
  return (
    <div class="wc-trail">
      <For each={props.entries}>
        {(entry) => (
          <div class="wc-trail__row">
            <span class="wc-trail__time">
              {entry.at.slice(0, 10)}
              <br />
              {entry.at.slice(11, 16)}Z
            </span>
            <div class="wc-trail__body">
              {entry.summary}
              <br />
              <Show when={entry.ruling_id}>
                <span class="wc-ruling-chip">{entry.ruling_id}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

/** Ask-the-crew: one tap files a needs-you card. */
export function AskCrew(props: {
  placeholder: string;
  onFile: (message: string) => Promise<void>;
  busyLabel?: string;
}) {
  const [message, setMessage] = createSignal('');
  const [state, setState] = createSignal<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [detail, setDetail] = createSignal('');

  const submit = async () => {
    const text = message().trim();
    if (!text) return;
    setState('busy');
    setDetail('');
    try {
      await props.onFile(text);
      setState('done');
      setDetail('Filed — the crew lane has it.');
      setMessage('');
    } catch (err) {
      setState('error');
      setDetail(err instanceof Error ? err.message : 'Could not file the card.');
    }
  };

  return (
    <div class="wc-ask-crew">
      <label class="wc-visually-hidden" for="wc-ask-input">
        Ask the crew
      </label>
      <input
        id="wc-ask-input"
        class="wc-input"
        type="text"
        value={message()}
        placeholder={props.placeholder}
        aria-label="Ask the crew"
        onInput={(e) => setMessage(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      <button
        class="btn btn--primary"
        type="button"
        disabled={state() === 'busy' || !message().trim()}
        onClick={() => void submit()}
      >
        {state() === 'busy' ? (props.busyLabel ?? 'Filing…') : 'File needs-you'}
      </button>
      <Show when={detail()}>
        <p class={`wc-ask-crew__status wc-ask-crew__status--${state()}`} role="status">
          {detail()}
        </p>
      </Show>
    </div>
  );
}
