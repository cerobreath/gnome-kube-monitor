# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell extension (`shell-version` 45–50) that shows Kubernetes node health in the
top bar. UUID `kube-monitor@cerobreath.dev`. The extension itself is pure GJS/ESM — **no
build step or bundler**; gnome-shell loads the `.js` files directly. There is a dev-only
test / lint / type layer (`package.json`, `tests/`, `eslint.config.js`, `tsconfig*.json`)
plus CI, a husky pre-commit hook and a `LICENSE` — none of it ships with the extension.

## Commands

```bash
./install.sh                                          # compile schema + symlink into ~/.local/share/gnome-shell/extensions
gnome-extensions enable  kube-monitor@cerobreath.dev
gnome-extensions prefs   kube-monitor@cerobreath.dev  # open preferences window
glib-compile-schemas schemas/                         # MUST re-run after editing the gschema.xml

npm install                                           # dev tooling only (eslint, typescript, @girs types)
npm run check                                         # lint + typecheck + test — the pre-commit & CI gate
npm test                                              # pure-logic unit tests (node --test); no deps, no cluster
npm run lint                                          # eslint (flat config)
npm run typecheck                                     # tsc --checkJs against @girs types (no emit; two passes)
npm run pack                                          # → kube-monitor@cerobreath.dev.shell-extension.zip (install / EGO upload)
```

**Iterating on the shell side** (Wayland picks up a *new* extension only after logout, and
reloads code changes only after a shell restart). The install is a **symlink**, so edits
are seen by the next shell restart — no reinstall unless you touch the schema:

```bash
# Test in a throwaway shell. Nested is the default when --display-server is absent;
# --nested was REMOVED in GNOME 50. --headless doesn't steal focus, and pairing it
# with `gnome-extensions info <uuid>` in the same dbus-run-session proves the
# extension actually reached State: ACTIVE (silence alone proves nothing).
dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800 --wayland
journalctl -f -o cat /usr/bin/gnome-shell | grep -i kube    # extension logs / stack traces
```

## Working in this repo (keep the bar here)

- **Quality gate**: every change must pass `npm run check` (eslint + `tsc --checkJs` ×2 +
  `node --test`). A husky pre-commit hook and GitHub Actions (`.github/workflows/ci.yml`)
  both run it — don't bypass with `git commit --no-verify`.
- **Where new logic goes**: parsing, severity, scheduling and formatting are pure and live
  in `lib/model.js` / `lib/schedule.js` (**no `gi://` imports**) — that is what makes them
  testable, so put new logic there and cover it with a `tests/*.test.js`. IO stays in
  `client.js`, the timer/side-effect loop in `poller.js`, widgets in `indicator.js`.
- **Types**: annotate new code with JSDoc so both `tsc` passes stay clean (strict for the
  logic, strict-minus-null for the GObject view — see Testing below).
- **Commits**: Conventional Commits (`feat:`, `fix:`, `chore(deps):` …), matching history.
- **License**: GPL-2.0-or-later. The panel icon is the official Kubernetes helm —
  regenerate it by extracting the helm path from the source logo SVG, don't hand-edit the
  path data.
- **Release**: `npm run pack` builds the installable / EGO-upload zip (metadata, the four
  top-level files, `lib/`, `icons/`, `LICENSE`, and the `.gschema.xml` — **not** the compiled
  schema). CI can't call it (`gnome-extensions` ships inside the heavy gnome-shell package),
  so `.github/workflows/ci.yml` hand-rolls a zip whose file set is kept **identical**: it
  validates the schema with `--dry-run` (writing no `gschemas.compiled`) and excludes that
  file plus editor leftovers. Change one and change the other.

## Two execution contexts that cannot share runtime code

- **Shell process** — `extension.js` + everything in `lib/`. Has `St`, `Clutter`, `Main`,
  `PanelMenu`/`PopupMenu`. No Gtk.
- **Prefs process** — `prefs.js`, a separate process. Has `Adw`, `Gtk`, `Gio`, `GLib`.
  **No** access to `St`/`Clutter`/`Main`. It *may* import the gi-only modules `lib/model.js`
  and `lib/client.js` (prefs reuses `client.js` to list contexts) — but never the shell-only
  `lib/indicator.js` / `lib/notifier.js`.

The only thing they share is the **GSettings schema**. All cross-context state (context,
kubeconfig/kubectl paths, interval, notify toggle) flows through settings keys.

## Architecture: a pure core with thin IO/UI edges

The layering is the point — it's what makes the logic testable and the shell coupling
contained. Dependencies point inward toward `model.js`; nothing imports "up".

- **`lib/model.js` — pure, zero `gi://` imports.** All parsing, severity, sorting,
  display-string formatting, and error classification (`classifyError` maps raw kubectl
  stderr to a `{title, detail}` — headline wording + tests live here, not in the view).
  Plain data in → plain data out; time-dependent functions take
  an explicit `nowMs`. This runs unchanged under gnome-shell, plain gjs, and node, which is
  why it carries the test coverage. **Keep it gi-free.**
- **`lib/schedule.js` — pure, gi-free.** Poll-cadence math (base-interval clamp,
  exponential backoff) split out of the loop so it's unit-tested. **Keep it gi-free too.**
- **`lib/alerts.js` — pure, gi-free.** The alert state machine: a `reduce(prevState,
  observation, config, nowMs)` reducer that turns each poll observation (node readiness +
  cluster reachability) into `fire`/`resolve` actions, with a Prometheus-style
  `inactive→pending→firing` lifecycle (`for` debounce, `keep_firing_for` hold), an
  Alertmanager-style notify-log for dedup + persistence, cluster-unreachable inhibition of
  node alerts, a settle guard for cold start / suspend / long screen-lock, and a
  `silencedUntilMs` mute that withholds without marking (so a still-firing alert delivers
  when the silence expires). `nowMs` is wall-clock (must survive reboot). State is serialized
  to the `alert-state` GSettings key. `groupActions(actions)` coalesces a batch into at most
  two banners (fires = critical, resolves = normal) — Alertmanager grouping. **Keep it
  gi-free**; all firing wording + tests live here, not in the view.
- **`lib/client.js` — the kubectl IO edge.** The only file that shells out
  (`Gio.Subprocess`). Builds the environment explicitly (gnome-shell has a trimmed PATH and
  no `KUBECONFIG`), always passes `--request-timeout=5s` and `--context` when set, and
  delegates all parsing to `model.js`.
- **`lib/poller.js` — the poll loop.** Owns tier selection, backoff (delays from
  `schedule.js`), the watchdog, and reentrancy (see invariants below). Pushes render state
  out via `onState`, and an `AlertObservation` (`{reachable, context, nodes, error}`) via
  `onObservation` from **both** the success and the error path — the error path is what lets
  the alert machine see an unreachable cluster. A `stop()`-cancellation emits neither.
- **`lib/indicator.js` — the view.** `PanelMenu.Button` + menu. Decoupled from settings:
  it emits `refresh-requested`, `context-selected(string)`, `menu-open-changed(bool)`,
  `node-copied(string)`, `snooze-requested(int seconds)` and never reads GSettings itself.
  Notifications are the extension's job, so the copy row emits `node-copied` and the "Mute
  alerts" submenu emits `snooze-requested`; the extension pushes mute state back via
  `setSnoozeUntil(ms)`.
- **`lib/notifier.js` — the notification edge.** Shell-only (imports `resource:///`, like
  `indicator.js`). Owns a dedicated `MessageTray.Source` titled "Kube Node Monitor" with the
  helm icon, so banners are attributed to the extension, not the generic "System" source.
  Bridges the MessageTray API split at GNOME 46 (45: positional ctors + `showNotification`;
  46–50+: params-object ctors + `addNotification`) by feature-detecting `addNotification` on
  the `Source` prototype. `notify(title, body, {transient, urgency})` maps `urgency` to
  `MessageTray.Urgency` (`critical` = sticky, shown under DND — used for fires). Persistent-
  source pattern: recreated after the shell destroys it.
- **`extension.js` — thin wiring.** Feeds each `onObservation` through `alerts.reduce`,
  buffers the returned actions through a `group_wait` timer, then dispatches them coalesced
  (`alerts.groupActions`) to `notifier.js`, and persists the machine's state to the
  `alert-state` GSettings key (only when it changes). Snooze: `snooze-requested` writes an
  absolute `alert-silence-until` deadline the reducer reads live. The `changed` handler uses a
  connection-key allowlist (`context`/`kubeconfig-path`/`kubectl-path`) so writing
  `alert-state` doesn't self-trigger a re-poll; alert tunables are read live per observation.

### Two-tier polling (the core optimization)

Polling cost lands inside the compositor process, so steady state must be minimal. The
poller picks a tier by menu state:

- **Menu closed** (≈always): `client.fetchHealth` — one compact jsonpath query (~250 B vs
  ~120 KB for `-o json`). Drives only the panel dot + notifications. One kubectl spawn,
  negligible parse.
- **Menu open**: `fetchNodesDetail` + `fetchNodeMetrics` + `fetchPodsSummary` in parallel
  (metrics/pods are best-effort, `.catch(() => null)`). Refreshed only while visible.

`setMenuOpen(true)` triggers an immediate detail poll instead of waiting for the next tick.

**Scale limits (measured, not guessed).** On a real 3-node k3s cluster tier 2 costs
**~36 KB/node** (`status.images` is 40% of it) against **251 B for the whole cluster** in
tier 1 — so a 1000-node cluster means ~36 MB `JSON.parse`d on the compositor's main loop
while the menu is open. Two bounds contain the damage: `MAX_NODE_ROWS` (indicator.js) caps
rows at 50 (sorted most-severe-first, remainder summarised, never silently dropped) since
~14 St actors per row is what actually wedges the shell, and `MAX_TRACKED_ALERTS`
(alerts.js) caps the persisted alert map. Replacing tier 2's `-o json` with jsonpath was
measured and **rejected**: roles come from label *keys*, jsonpath can't prefix-filter a map,
and emitting `{.metadata.labels}` wholesale is worse — one kubevirt node carried ~500 labels,
so the "optimised" query was only 4x smaller. Fixing it properly needs a different
projection (custom-columns for the scalars + the table output's ROLES column), which is a
follow-up, not a free win.

### Invariants in the poll loop — preserve them

- **Reentrancy**: `_polling` guards against overlapping polls; the self-rescheduling
  single-shot timer (not a fixed recurring timer) guarantees the next poll is scheduled in
  `finally`, and enables backoff.
- **Watchdog + cancellable swap**: each poll arms a `POLL_TIMEOUT_SECONDS` watchdog that
  cancels the shared `Gio.Cancellable` and **replaces it with a fresh one**, so the next
  tick starts clean. This is what prevents the "eternal Loading" wedge on an unreachable
  cluster. `stop()` also cancels it; the catch block distinguishes a real timeout
  (`timedOut`) from a `stop()` cancellation so teardown stays silent and doesn't reschedule.
- **Backoff**: consecutive failures grow the delay (base → cap `MAX_BACKOFF_SECONDS`),
  reset on success. The delay math is pure in `schedule.js` and unit-tested.
- **Tier agreement**: both tiers derive `level`/`ready` from the same `model.js` helpers, so
  the panel dot means the same thing whether it came from a health or a detail poll. If you
  add a severity source, add it to `deriveStatus`/`nodeLevel`, not to one tier.

### UI conventions (`lib/indicator.js`, `stylesheet.css`)

- **Actor reuse**: node rows are keyed by name in `_nodeRows`; a full rebuild happens only
  when the signature (sorted names + levels) changes. Otherwise only dynamic bits (up/down
  duration, CPU/MEM) are updated in place — no teardown churn while the menu is open.
- Status color is class-based (`kube-dot-<level>` / `kube-meter-<level>`, level ∈
  `ok|warning|error|unknown`), not inline. The one exception is the panel logo color:
  `_syncIconColor()` pins the symbolic icon to the panel's foreground and re-runs on
  `Main.panel` `style-changed` so it tracks light/dark themes.
- **Stable width**: the menu width is the header's `min-width` (`.kube-header`); any
  variable-length text is bounded so it can't stretch the popup. The context title
  ellipsizes; the error state (`_makeErrorItem`) wraps at `WORD_CHAR`. St clamps an actor's
  preferred width to its CSS `max-width`, so a `max-width` + `line_wrap` label reflows
  instead of widening the menu — never let unbounded text into the menu.
- The "updated N ago" label uses `GLib.get_monotonic_time()` (immune to wall-clock jumps).

## Testing & type-checking

**Every shipped source file is held at 100% line / branch / function coverage.**
`npm run coverage` (part of `npm run check`, and its own CI job) enforces that with
node's built-in thresholds, so a drop fails the build rather than going unnoticed.
223 tests, no dependencies, no cluster, no gnome-shell.

- **The gi-free modules** (`model.js`, `schedule.js`, `alerts.js`) are tested directly.
- **Everything else** (`client.js`, `poller.js`, `indicator.js`, `notifier.js`,
  `extension.js`, `prefs.js`) imports `gi://…` or `resource:///…`, which node cannot
  resolve. `tests/hooks.mjs` registers **`node:module` `registerHooks`** (the
  synchronous form; `module.register()` is deprecated) to redirect those specifiers to
  fakes in `tests/stubs/`. It is loaded via `--import ./tests/hooks.mjs`, which runs
  before the test files so their static imports are intercepted. Needs Node ≥ 22.15
  (see `engines`); the harness throws a clear message on older runtimes.
- **The fakes are deliberately behavioural, not empty:**
  `stubs/gi/GLib.js` owns a clock that only moves when a test says so
  (`__advance` drains timers, `__setClock` moves time alone), so cadence, backoff,
  the watchdog and `group_wait` are asserted without sleeping.
  `stubs/gi/Gio.js` makes the subprocess scriptable — `hang`, `defer`, `throws`,
  non-zero exit, `null` stdout — which is what lets a poll be landed *after*
  `stop()` on purpose, and carries a GSettings fake seeded with the real schema
  defaults that emits `changed`/`changed::key` like dconf.
  `stubs/shell/messageTray.js` can present **either** notification API generation, so
  the GNOME 45 shim is tested even though nobody develops on 45.
- **Chasing full branch coverage is a review tool, not a vanity metric.** It has
  already found: dead code (`wantDetailNow` in the poller, two `.catch` handlers on a
  function that cannot reject, an entry-time cancellation check), a prototype-chain
  bug in `parseMemBytes`, `disable()` throwing when `enable()` never ran, a timer
  armed with no owner, and a mute row shown before anything was muted. When a branch
  resists covering, decide whether it is genuinely unreachable (delete it) or a real
  guard (test it white-box, as with the poller's `_tick` re-entry guard) — do not
  contrive a test to paint it green.
- Types are JSDoc + the `@girs/*` packages (dev-only; the shipped extension is still
  plain JS with no build). `npm run typecheck` runs two passes: `tsconfig.json` is
  **strict** over the logic (`model`/`schedule`/`alerts`/`client`/`poller`/`prefs`);
  `tsconfig.ui.json` relaxes only `strictNullChecks` for the GObject view
  (`extension.js` + `lib/indicator.js` + `lib/notifier.js`), because
  `PanelMenu.Button` assigns its fields in `_init` (not a constructor) and JSDoc has no
  definite-assignment `!`, so strict-null reports false "possibly undefined" on every
  `_init`-assigned widget. Everything imported into the view pass rides along, so the
  `null`-typed fallbacks in `poller.js` are pinned with an explicit type.
- **Never use class fields in a `GObject.registerClass` class** (`_x;` or `_x = …` in
  the class body). Their initializers run *after* `_init()` and clobber whatever
  `_init` set back to `undefined` (verified on GJS 1.88). Assign all instance state
  inside `_init()`.
- To smoke-test the kubectl edge against a real cluster, a plain-`gjs` script can
  import `lib/client.js` and call the `fetch*` functions. **Use static `import`, not
  dynamic `await import()`** — in standalone gjs, top-level `await import()` plus a
  manually-run `MainLoop` deadlocks (they contend for the main context). Inside
  gnome-shell this never arises (static imports, always-running loop).
- The nested-shell run is still worth doing before a release: unit tests prove the
  logic, but only a real gnome-shell proves the extension *loads* (schema compiled,
  no `resource:///` typo, no St property that does not exist). Pair
  `gnome-shell --headless` with `gnome-extensions info <uuid>` and look for
  `State: ACTIVE` — see Commands above.
