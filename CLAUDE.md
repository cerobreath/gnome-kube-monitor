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
dbus-run-session -- gnome-shell --nested --wayland          # test in a nested shell
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
- **Release**: `npm run pack` builds the installable / EGO-upload zip; CI uploads the same
  artifact on every push/PR.

## Two execution contexts that cannot share runtime code

- **Shell process** — `extension.js` + everything in `lib/`. Has `St`, `Clutter`, `Main`,
  `PanelMenu`/`PopupMenu`. No Gtk.
- **Prefs process** — `prefs.js`, a separate process. Has `Adw`, `Gtk`, `Gio`, `GLib`.
  **No** access to `St`/`Clutter`/`Main`. It *may* import the gi-only modules `lib/model.js`
  and `lib/client.js` (prefs reuses `client.js` to list contexts) — but never the St-based
  `lib/indicator.js`.

The only thing they share is the **GSettings schema**. All cross-context state (context,
kubeconfig/kubectl paths, interval, notify toggle) flows through settings keys.

## Architecture: a pure core with thin IO/UI edges

The layering is the point — it's what makes the logic testable and the shell coupling
contained. Dependencies point inward toward `model.js`; nothing imports "up".

- **`lib/model.js` — pure, zero `gi://` imports.** All parsing, severity, sorting, and
  display-string formatting. Plain data in → plain data out; time-dependent functions take
  an explicit `nowMs`. This runs unchanged under gnome-shell, plain gjs, and node, which is
  why it carries the test coverage. **Keep it gi-free.**
- **`lib/schedule.js` — pure, gi-free.** Poll-cadence math (base-interval clamp,
  exponential backoff) split out of the loop so it's unit-tested. **Keep it gi-free too.**
- **`lib/client.js` — the kubectl IO edge.** The only file that shells out
  (`Gio.Subprocess`). Builds the environment explicitly (gnome-shell has a trimmed PATH and
  no `KUBECONFIG`), always passes `--request-timeout=5s` and `--context` when set, and
  delegates all parsing to `model.js`.
- **`lib/poller.js` — the poll loop.** Owns tier selection, backoff (delays from
  `schedule.js`), the watchdog, and reentrancy (see invariants below). Pushes render state
  out via callbacks.
- **`lib/indicator.js` — the view.** `PanelMenu.Button` + menu. Decoupled from settings:
  it emits `refresh-requested`, `context-selected(string)`, `menu-open-changed(bool)` and
  never reads GSettings itself.
- **`extension.js` — thin wiring** + node up/down notifications.

### Two-tier polling (the core optimization)

Polling cost lands inside the compositor process, so steady state must be minimal. The
poller picks a tier by menu state:

- **Menu closed** (≈always): `client.fetchHealth` — one compact jsonpath query (~250 B vs
  ~120 KB for `-o json`). Drives only the panel dot + notifications. One kubectl spawn,
  negligible parse.
- **Menu open**: `fetchNodesDetail` + `fetchNodeMetrics` + `fetchPodsSummary` in parallel
  (metrics/pods are best-effort, `.catch(() => null)`). Refreshed only while visible.

`setMenuOpen(true)` triggers an immediate detail poll instead of waiting for the next tick.

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
- Status color is class-based (`kube-dot-<level>` / `kube-value-<level>`, level ∈
  `ok|warning|error|unknown`), not inline. The one exception is the panel logo color:
  `_syncIconColor()` pins the symbolic icon to the panel's foreground and re-runs on
  `Main.panel` `style-changed` so it tracks light/dark themes.
- The "updated N ago" label uses `GLib.get_monotonic_time()` (immune to wall-clock jumps).

## Testing & type-checking

- The pure modules carry the unit tests: `model.js` (`tests/model.test.js` + hand-built
  `tests/fixtures.js`, covering every node branch) and `schedule.js`
  (`tests/schedule.test.js`). Run with `npm test`.
- Types are JSDoc + the `@girs/*` packages (dev-only; the shipped extension is still plain
  JS with no build). `npm run typecheck` runs two passes: `tsconfig.json` is **strict** over
  the logic (`model`/`schedule`/`client`/`poller`/`prefs`); `tsconfig.ui.json` relaxes only
  `strictNullChecks` for the GObject view (`extension.js` + `lib/indicator.js`), because
  `PanelMenu.Button` assigns its fields in `_init` (not a constructor) and JSDoc has no
  definite-assignment `!`, so strict-null reports false "possibly undefined" on every
  `_init`-assigned widget. Everything imported into the view pass rides along, so the
  `null`-typed fallbacks in `poller.js` are pinned with an explicit type.
- **Never use class fields in a `GObject.registerClass` class** (`_x;` or `_x = …` in the
  class body). Their initializers run *after* `_init()` and clobber whatever `_init` set
  back to `undefined` (verified on GJS 1.88). Assign all instance state inside `_init()`.
- To smoke-test the kubectl edge against a real cluster, a plain-`gjs` script can import
  `lib/client.js` and call the `fetch*` functions. **Use static `import`, not dynamic
  `await import()`** — in standalone gjs, top-level `await import()` plus a manually-run
  `MainLoop` deadlocks (they contend for the main context). Inside gnome-shell this never
  arises (static imports, always-running loop).
- `indicator.js` can only run inside gnome-shell (imports `resource:///…`); `node --check`
  plus the view type-pass are the best static validation.
