# RET-721 — live API map (client ↔ RET-720)

Written by `devcrew-frontend-dev` during the finish-pass that ran out of iteration
budget. Everything below is read from the RET-720 backend commit `54047be73`
(branch `ret720-wallet-console`), NOT guessed. The next run should implement
straight from this file.

## 0. The one blocking defect in the banked frontend

`packages/frontend/src/services/api/wallet-console.ts` talks to routes that
**do not exist** in RET-720:

```
GET  /wallets/console/settings     ❌
GET  /wallets/console/balancer     ❌
GET  /wallets/console/progress     ❌
GET  /wallets/console/access       ❌
POST /wallets/console/ask-crew     ❌
PATCH /wallets/console/settings/... ❌
```

All of them 404 against the real backend, so every panel renders the **demo**
payload (`demo: true`) forever. The UI, tokens, dark theme, primitives, routes,
sidebar gating and 25 vitest cases are fine — only the transport layer is wrong.

## 1. Real RET-720 contract (base `/api/v1`, session cookie, tenant from
`TenantContext`)

### GET /wallets/:id/settings
```jsonc
{ "settings": {
  "wallet_id": "…", "tenant_id": "…",
  "drain_day_enabled": true, "priority": 100,
  "parked": false, "kill_switch_fallback": false,
  "daily_lines": { "base_pct": 10, "rollover_pool_pct": 0.744, "floor_pct": 4 } | null,
  "updated_at": "…", "updated_by_user_id": "…"
}}
```

### PUT /wallets/:id/settings
Body (all optional): `daily_lines?: { base_pct?, rollover_pool_pct?, floor_pct? }`,
`drain_day_enabled?`, `priority?`, `parked?`, `kill_switch_fallback?`.
Response: `{ settings, changed: boolean, audit_id: string|null, ruling: {…}|null }`
— the ruling is the auto-minted decisions-ledger id (D-YYYY-MM-DD-NN). Show it.

### GET /wallets/:id/settings/audit
Response `{ audit: [...] }` — each row has `wallet_id`, `actor_user_id`,
`action` (`settings.update`), `before` (jsonb), `after` (jsonb), `ruling_id`,
`created_at`. Exact key set to be re-confirmed from
`wallet-console.service.ts` → `listAudit` before mapping.

### GET /quota-board
Forces one fresh provider-own poll first; `stale_feed` says whether the feed
answered.
```jsonc
{ "generated_at": "…", "polled_at": "…", "stale_feed": false,
  "ration": { "available": true, "updated_at": "…", "unavailable_reason": null },
  "wallets": [{
    "wallet_id": "…", "name": "MAIN", "color": "…",
    "parked": false, "priority": 100, "drain_day_enabled": true, "halted": false,
    "min_five_h_pct_left": 42.5, "min_weekly_pct_left": 71.2,
    "keys": [{ "label": "…", "provider": "zai", "account": "…",
      "five_h_pct_left": 42.5, "weekly_pct_left": 71.2,
      "five_h_reset_at": "…", "weekly_reset_at": "…",
      "plan_level": "…", "subscription_status": "…",
      "seen_at": "…", "stale": false, "error": null, "halted": false }]
  }]}
```

### GET /budgets/daily
Reads the published RET-670-V3 governor state as-is (no re-forked line math).
```jsonc
{ "generated_at": "…", "available": true, "unavailable_reason": null,
  "ration_updated_at": "…",
  "accounts": [{ "account": "…", "keys": ["…"],
    "allowed_today_pct": 10.74409, "used_today_pct": 4.092248,
    "remaining_today_pct": 6.651842, "base_pct": 10, "rollover_pool_pct": 0.744,
    "floor_pct": 4, "weekly_headroom_pct": 71.2, "five_h_headroom_pct": 42.5,
    "drain_day": false, "drain_window": false, "allow": true, "halted": false,
    "day_number": 3, "day_index": 2, "ration_model": "…", "reasons": [],
    "halted_by_console": false }],
  "wallets": [{ "wallet_id": "…", "name": "MAIN", "accounts": ["…"],
    "parked": false, "drain_day_enabled": true, "daily_lines": {…}|null }]
}
```

## 2. Mapping the banked view models onto the real payloads

| Banked field | Real source |
|---|---|
| `WalletLine.base_pct` | `settings.daily_lines.base_pct` (fallback `accounts[].base_pct`) |
| `WalletLine.rollover_pct` | `settings.daily_lines.rollover_pool_pct` (fallback `accounts[].rollover_pool_pct`) |
| `WalletLine.floor_pct` | `settings.daily_lines.floor_pct` (fallback `accounts[].floor_pct`) |
| `WalletLine.allowed_pct` | `accounts[].allowed_today_pct` (server-computed `usable_pct`) |
| `WalletLine.formula` | server terms only: `base`, `rollover pool`, `floor`; result = `allowed_today_pct` |
| `WalletSettingsResponse.behaviour` | `drain_day_enabled` / `parked` / `kill_switch_fallback` from settings; `budget_mode` from the ration model / governor, not invented |
| `WalletSettingsResponse.priority` | `quota-board.wallets[].priority`, sorted ascending |
| `WalletSettingsResponse.members` | `quota-board.wallets[].keys[]` → `label` + `provider` |
| `WalletSettingsResponse.audit` | `GET /wallets/:id/settings/audit` per wallet |
| `WalletSettingsResponse.governor_tick` | `budgets/daily` → `generated_at`, `ration_updated_at`, `allowed_today_pct`, `used_today_pct` |
| `LoadBalancerCard.window.pct_left` | `quota-board.wallets[].min_five_h_pct_left` (+ per-key values) |
| `LoadBalancerCard.weekly.pct_left` | `quota-board.wallets[].min_weekly_pct_left` |
| `LoadBalancerCard.resets_label` | `keys[].five_h_reset_at` / `weekly_reset_at` |
| `LoadBalancerCard.provider_state` | `keys[].stale` / `keys[].error` / `keys[].subscription_status` |
| `LoadBalancerCard.lane_tags` | `keys[].label`; `lane_tags_live` = `!stale_feed` |
| `LoadBalancerCard.parked/halted` | `wallets[].parked` / `wallets[].halted` |
| `ProgressBlock.used_pct / allowed_pct / still_allowed_pct / floor_pct` | `budgets/daily.accounts[]` |
| `ProgressBlock.formula` | `base_pct`, `rollover_pool_pct`, `floor_pct` → result `allowed_today_pct` |

**Important spec correction:** the mockup strip is `base + rollover + reserve −
floor`, but RET-720 publishes only **three** numbers (base, rollover pool,
floor) plus the server-computed `allowed_today_pct`. Render the server's
numbers; do **not** invent a reserve term and do not re-sum the allowed value on
the client (spec: no client-side budget arithmetic).

## 3. Owner gate

`assertOwner(tenantId, userId)` runs on **every** one of the five endpoints
(`tenants.owner_user_id === TenantContext.userId`). There is **no**
`/access` endpoint. So the console must derive owner state from a cheap probe:
use `GET /budgets/daily` (no provider poll) —

* `200` → owner
* `403` → signed in but **not** the owner → render the "Owner only" gate
* `401` → not signed in (existing `fetchJson` redirects to `/login`)
* `404` → console surface disabled (`MANIFEST_WALLET_CONSOLE_ENABLED=false`) → keep the demo payload, labelled

The banked `getWalletConsoleAccess()` must not treat 403 as "endpoint missing"
(an earlier run already fixed that bug — keep that behaviour).

## 4. Gaps with **no** backend source (need a follow-up card, not a guess)

1. **ask-crew** — no route exists (`needs-you|needsYou|ask-crew|askCrew` → 0
   matches in `packages/backend/src`). The banked button posts to a dead route.
   Needs a backend card (Discord/Linear needs-you filing) — owner of RET-720
   lane. Until then the button must stay honest (disabled + "needs-you filing
   is not wired yet"), never fake a card ref.
2. **weekly heatmap (4 weeks of daily burn %)** and the **14-day day strip** —
   no backend endpoint publishes per-day history (`quota-board` is a snapshot,
   `budgets/daily` is today only). Either a backend card (per-day spend series
   per wallet) or the panels ship as explicit "not published yet" states.
3. **burn-meter in-flight lanes** — no lane-concurrency source in the console
   API. `quota-board` gives quota headroom only. `analytics` has
   `in_flight|concurrency` rows but not per wallet lane counts.

## 5. Burn-meter authority — unresolved, do not silently pick

Owner pick **D-2026-11-20-22** (card comment, 01:27Z) says the burn meter is
**INDEPENDENT** (it steers lanes by itself). Later architect seeds paraphrase
the same pick as "advisore/advise-only". The banked code implements
`advisory: true` (proposes, never moves a lane). **Resolve with the owner
before shipping the gauge as authoritative**, and keep the label honest either
way.

## 6. Deploy facts (verify, don't trust)

* Deploy truth branch on fsn1: `/root/ret662/gateway`, branch `ret692fix`.
  `ret721` (frontend) and `ret720-wallet-console` (backend `54047be73`) exist
  there; whether the backend commit is merged into `ret692fix` and which image
  the `mnfs` namespace runs was **not** verified in this pass — re-check with
  `git merge-base --is-ancestor 54047be73 ret692fix` and
  `kubectl -n mnfs get deploy mnfs-app -o jsonpath='{.spec.template.spec.containers[0].image}'`.
* Migration `1803400000000-AddWalletSettings` (additive, two tables) must be
  applied on the real PG — devops owns that step (RET-720 follow-up).
* `RUN_MIGRATIONS_ON_BOOT` defaults to true; the deployment manifest path on
  fsn1 is **not** `deploy/mnfs-app` (that path does not exist there).
* Build gate is the in-container docker build (`127.0.0.1:30500/djeyff/mnfs-app:ret692fix-<sha>`),
  then `kubectl set image` — per the `mnfs-app-deploy-verify` skill. **Never
  restart the `mnfs-app` gateway pod bare; a `kubectl set image` roll is the
  sanctioned path.**
* EACCES pitfall: a foreign `packages/backend/node_modules` breaks `npm ci` —
  move it aside first. Never run docker on the fsn1 host.

## 7. Frontend repo conventions (already established)

* Solid + Vite; pages in `packages/frontend/src/pages/`, primitives in
  `packages/frontend/src/components/wallet-console/`, token home is
  `packages/frontend/src/styles/tokens.css`.
* API helpers: `packages/frontend/src/services/api/core.ts` →
  `fetchJson(path, params, opts)` / `fetchMutate(path, init)`, base `/api/v1`,
  `credentials: 'include'`.
* Vitest under `packages/frontend/tests/`. `manifest-shared` must be built
  (`npx turbo run build --filter=manifest-shared`) or 79 suites fail to resolve.
* Known pre-existing failure, unrelated to RET-721:
  `MessageLog.test.tsx > does NOT render agent filter dropdown in agent-scoped mode`.

## 8. Banked frontend commits (branch `ret721`, do not rewrite)

* `482f59597` — `services/api/wallet-console.ts` (client, **needs rewiring**),
  `components/wallet-console/{Console.tsx,wallet-console.css}` (primitives).
* `b7a759421` — the three pages `WalletSettings.tsx`, `LoadBalancer.tsx`,
  `DailyProgress.tsx`, routes `/wallets/{settings,balancer,progress}` in
  `index.tsx`, WALLETS sidebar group in `Sidebar.tsx`.
* `cacb7efa7` — 25 vitest cases
  (`tests/services/wallet-console.test.ts`, `tests/pages/WalletConsole.test.tsx`).
  They mock the **dead** routes, so they must be re-pointed at the real
  endpoints and the transport rewritten against them.

## 9. Next run — mechanical order

1. Rewrite `wallet-console.ts` transport onto the five real endpoints
   (mapping table in §2), keeping the demo fallback ONLY for 404/disabled.
2. Replace `getWalletConsoleAccess()` with the `budgets/daily` probe (§3).
3. Re-point the 25 vitest cases at the real paths; keep the two real defects
   they caught (no read before the owner check; 403 ≠ missing endpoint).
4. Run vitest + lint + `tsc --noEmit`.
5. Ask the owner the burn-meter question (§5); file backend follow-up cards for
   ask-crew, heatmap/day-strip history and lane concurrency (§4).
6. Merge `ret721` (frontend) **and** `54047be73` (backend) into the deploy
   branch, docker build, `kubectl set image` roll, then verify: public asset /
   chunk proof, owner-only gate canary, live round-trip of one settings line
   (audit row + ruling id), dark-theme screenshots, zero console errors.
7. Write the closeout digest as a workspace file and attach it to the card in
   the same turn as the checkpoint comment.
