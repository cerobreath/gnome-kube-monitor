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
npm run check                                         # lint + typecheck + coverage + i18n — the pre-commit & CI gate

npm run i18n:pot                                      # re-extract po/<uuid>.pot from the sources
npm run i18n:update                                   # merge the .pot into all 14 po/*.po
npm run i18n:compile                                  # po/ → locale/<lang>/LC_MESSAGES/<uuid>.mo (install.sh runs it)
npm run i18n:check                                    # the gate: POTFILES/LINGUAS consistent, .pot current, catalogues complete
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
# For "why did I (not) get a notification?", turn on diagnostics (Preferences →
# Advanced, or the key below) and watch the same journal. Off by default.
gsettings --schemadir schemas set org.gnome.shell.extensions.kube-monitor debug-logging true
```

## Working in this repo (keep the bar here)

- **Quality gate**: every change must pass `npm run check` (eslint + `tsc --checkJs` ×2 +
  `node --test` at 100% coverage + the i18n check). A husky pre-commit hook and GitHub
  Actions (`.github/workflows/ci.yml`) both run it — don't bypass with `git commit
  --no-verify`. The i18n step needs GNU gettext installed; it says so if it is missing.
- **New user-facing strings**: wrap them (see Translations below) and run
  `npm run i18n:pot && npm run i18n:update`, then fill in the 14 catalogues. `npm run
  check` fails on an untranslated or fuzzy message, the same way it fails on a coverage
  drop — "shipped" and "actually translated" are not allowed to diverge.
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
  top-level files, `lib/`, `icons/`, `LICENSE`, the `.gschema.xml` — **not** the compiled
  schema — and `locale/`, which `--podir=po` compiles from the catalogues; `po/` itself is
  not shipped). CI can't call it (`gnome-extensions` ships inside the heavy gnome-shell
  package), so `.github/workflows/ci.yml` hand-rolls a zip whose file set is kept
  **identical**: it validates the schema with `--dry-run` (writing no `gschemas.compiled`),
  runs `./po/i18n.sh compile` to produce the same `locale/`, and excludes that compiled
  schema plus editor leftovers. Change one and change the other — 34 files, both sides.

## Two execution contexts that cannot share runtime code

- **Shell process** — `extension.js` + everything in `lib/`. Has `St`, `Clutter`, `Main`,
  `PanelMenu`/`PopupMenu`. No Gtk.
- **Prefs process** — `prefs.js`, a separate process. Has `Adw`, `Gtk`, `Gio`, `GLib`.
  **No** access to `St`/`Clutter`/`Main`. It *may* import the gi-only modules `lib/model.js`
  and `lib/client.js` (prefs reuses `client.js` to list contexts) — but never the shell-only
  `lib/indicator.js` / `lib/notifier.js`.

They share the **GSettings schema** and the **gettext domain**. All cross-context state
(context, kubeconfig/kubectl paths, interval, notify toggle) flows through settings keys;
translations flow through `metadata.json`'s `gettext-domain` and the bundled `locale/`,
which each process binds for itself.

## Translations

`gettext-domain` is the UUID; `ExtensionBase.initTranslations()` binds it to the
extension's own `locale/` directory. Catalogue sources live in `po/` (14 languages);
`locale/` is **build output** and gitignored — `gnome-extensions pack --podir=po` and
`install.sh` both compile it. The decisions worth keeping:

- **Bind through the extension instance**, `bindTranslations(this)`, not the module-level
  `gettext` exported by `resource:///…/extension.js`. That export resolves the domain by
  walking an `Error` stack for a path under `/gnome-shell/extensions/`; the instance
  methods take the domain straight from the metadata and skip the guesswork.
- **`format()`, never `String.prototype.format`.** That method is not a language feature:
  gnome-shell's `ui/environment.js` installs it from `imports.format`, and the
  preferences process does **not** (verified — `typeof ''.format` is `undefined` there),
  so a `.format()` call anywhere `prefs.js` reaches would throw in that process alone,
  and again under node. `format()` also supports `%1$s`, which several catalogues need:
  fr, tr, ja, ko and zh_CN all reorder the arguments of "N of M nodes ready", and Turkish
  writes the percent sign *before* the number (`CPU %%%d`).
- **`N_()` for static tables.** `model.js`'s error headlines and `indicator.js`'s spoken
  severity words are built at module load, before any locale is bound, so they store the
  English source and go through `_()` at lookup. This also keeps the 100% coverage gate
  honest: a table of thunks would need every entry *called* to count as covered.
- **Kubernetes vocabulary stays untranslated** — `Ready`, `NotReady`,
  `SchedulingDisabled`, the pressure condition types, role names. They are API
  identifiers printed verbatim by `kubectl get nodes`; translating them would make the
  menu disagree with the command it is a window onto. `classifyError` now also returns
  the machine `key` alongside the translated `title`.
- **The gschema is deliberately not translated.** Its summaries are only ever read by
  dconf-editor, a separate process that never calls `bindtextdomain()` for this
  extension's `locale/`, so the entries would be unreachable. `po/POTFILES.in` says so.
- **Width is part of the translation.** The menu's width is fixed by `.kube-header`, and
  every locale is longer than English: the pods row is capped (`.kube-pods` max-width)
  with ellipsizing labels, and the meter labels carry a "keep it to three characters"
  translator note. Long strings must reflow or trim, never widen the popup.
- **Which locales actually resolve.** gettext falls back from a regional locale to the
  bare language (`de_AT`→`de`, `fr_CA`→`fr`, `es_MX`→`es`, `nl_BE`→`nl`, `ru_UA`→`ru`,
  `ar_MA`→`ar`, `uk_UA`→`uk`) but **never sideways**. That is the whole reason 18
  catalogues exist for 14 languages: `pt_PT` found nothing behind `pt_BR`, and `zh_TW`,
  `zh_HK`, `zh_SG` each found nothing behind `zh_CN`. `zh_HK` is `zh_TW` adapted for Hong
  Kong (連接 for a connection, not Taiwan's 連線) and `zh_SG` is `zh_CN` unchanged, since
  Singapore follows mainland simplification — both are labelled as derivations in the
  file that generates them rather than passed off as independent work. Measured across
  30 locales, not assumed.
- **RTL is a stylesheet problem, not a translation one.** St's CSS subset has no logical
  properties: gnome-shell's own theme uses the `:ltr` / `:rtl` pseudo-classes in 28
  places and `margin-inline-*` in none. Meanwhile `StBoxLayout` *does* reverse its
  children under RTL, so a bare `margin-left` keeps pushing right in Arabic while the
  neighbour it was clearing has moved. Three of our rules had exactly that bug
  (`.kube-caret`, `.kube-context-icon`, `.kube-node-meters`); they are now split per
  direction, and `tests/stylesheet.test.js` fails the build if a directional property
  ever appears outside an `:ltr`/`:rtl` selector, or if one side is declared without the
  other.
- **Verified at runtime, not only in tests.** The decisive one: a headless GNOME 50 with
  an isolated dconf store (`XDG_CONFIG_HOME` set **before** `dbus-run-session`, so the
  activated dconf service inherits it — setting it inside the script leaks to the real
  store) and a deliberately broken `kubectl-path`, which made the shell log
  `poll: failed … reason=У kubectl виникла помилка` and
  `alert: posting banner title=kubectl ist auf ein Problem gestoßen` — i.e. both gi-free
  modules rendering through the real shell process. Also: the pure modules driven under
  standalone `gjs` against the compiled `.mo` (uk picks all three plural forms, ar all
  six), and the preferences window built end-to-end in a real Adw process for uk/de/ar/ja.
  GNOME 45's `ExtensionBase` was checked against upstream and carries the same three
  instance methods and the same `initTranslations`, so the binding works across 45–50.
  A real `ar_EG` locale (built with `localedef` into a `LOCPATH`, since the machine has
  none) makes GTK report `TextDirection.RTL`, and the extension still reaches the shell
  and logs Arabic with the direction-split stylesheet in place. What is **not** verified:
  the *pixels* of an RTL layout — GNOME 50's mutter dropped `--x11`, so no window manager
  is available under Xvfb to place a mirrored window on screen, and the shell refuses
  screenshots outside unsafe mode. That last gap is toolkit behaviour rather than ours.
  Also unverified: no native speaker has reviewed the catalogues.

## Architecture: a pure core with thin IO/UI edges

The layering is the point — it's what makes the logic testable and the shell coupling
contained. Dependencies point inward toward `model.js`; nothing imports "up".

- **`lib/model.js` — pure, zero `gi://` imports.** All parsing, severity, sorting,
  display-string formatting, and error classification (`classifyError` maps raw kubectl
  stderr to a `{title, detail}` — headline wording + tests live here, not in the view).
  Plain data in → plain data out; time-dependent functions take
  an explicit `nowMs`. This runs unchanged under gnome-shell, plain gjs, and node, which is
  why it carries the test coverage. **Keep it gi-free.**
- **`lib/i18n.js` — pure, gi-free.** The translation plumbing: `_`, `ngettext`,
  `pgettext`, the `N_` extraction marker, and `format()`. Both processes inject their own
  backend once at start-up (`bindTranslations(this)` from `enable()` and from
  `fillPreferencesWindow()`), which is what lets the gi-free modules carry their own
  wording without importing gnome-shell's gettext. Unbound it is the identity, so the
  unit tests read in plain English and a mis-ordered start-up shows English rather than
  throwing. See Translations below for why `format()` exists at all.
- **`lib/log.js` — pure, gi-free.** Opt-in diagnostics behind the `debug-logging`
  key (off by default). Uses `console.log`, **not** `console.debug`: GLib's default
  log writer discards `LEVEL_DEBUG` unless `G_MESSAGES_DEBUG` is set on the process,
  and you cannot set an env var on a gnome-shell the user is already running —
  measured in a nested shell, `console.debug` produced nothing without it. Every line
  goes through `redactForLog` (model.js) and a length cap, because the journal is
  readable and long-lived: **never log raw kubectl output**, only classified or
  already-redacted strings.
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
rows at 50 (sorted most-severe-first, remainder summarised, never silently dropped), and
`MAX_TRACKED_ALERTS` (alerts.js) caps the persisted alert map.

The row cap has since been **profiled rather than reasoned about** (Ryzen 7 5800HS,
headless GNOME 50, synthetic nodes tuned to the measured 37 KB):

| nodes | menu open, capped at 50 | menu open, uncapped | tier-2 parse |
|-------|-------------------------|---------------------|--------------|
| 50    | 40 ms build / 129 ms laid out | same | 6 ms |
| 200   | 42 / 133 ms             | 157 / 641 ms        | 24 ms |
| 500   | 39 / 128 ms             | 406 / 889 ms        | 31 ms |
| 1000  | 43 / 138 ms             | 830 / **1826 ms**   | 64 ms |

So the cap holds the cost flat whatever the cluster size, and without it a 1000-node
cluster would freeze the entire shell for nearly two seconds on every menu open. ~2.5 ms
per row: halving the cap halves the hitch and shows half the nodes, which is now an
informed trade rather than a guess. Re-rendering an unchanged list is ~2.5 ms total, so
the build cost lands on the first open and on a signature change, not on every poll —
that is the actor-reuse path earning its keep. The parse column is separate and *not*
capped: it scales with the whole cluster and is the remaining tier-2 cost.

Replacing tier 2's `-o json` with jsonpath was
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
- **Direction-sensitive CSS must be split.** `margin-left`/`margin-right` (and the
  padding/border equivalents) have to be written twice, under `:ltr` and `:rtl` — St has
  no logical properties, and `StBoxLayout` reverses child order under RTL. A test
  enforces it; see Translations.
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
252 tests, no dependencies, no cluster, no gnome-shell.

- **The gi-free modules** (`model.js`, `schedule.js`, `alerts.js`, `i18n.js`) are tested
  directly.
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
  `stubs/shell/extension.js` carries a real gettext catalogue (`__catalog`) plus a
  pluggable plural rule (`__pluralIndex`), so one test in `extension.test.js` drives the
  whole stack in Ukrainian and proves a bound locale reaches the panel, the menu **and**
  the gi-free alert machine — with a three-form plural rule, which is the assumption most
  worth breaking. It is empty by default, so every other test still reads in English.
- **Two test files read source rather than run it**, because nothing executes them
  here: `tests/stylesheet.test.js` holds the `:ltr`/`:rtl` invariant over
  `stylesheet.css` (gnome-shell parses that file, not node), and
  `tests/catalogues.test.js` holds what gettext's tools cannot express over `po/*.po`
  — that translations stay inside the printf subset `format()` implements, keep the
  whitespace and ellipsis a caller depends on, and that the meter labels and duration
  abbreviations still fit the columns they sit in. Both were checked by injecting a
  violation and watching them fail; the first attempt at the catalogue parser dropped
  every `msgctxt`, which made two of its checks vacuous until that bite-test caught it.
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
