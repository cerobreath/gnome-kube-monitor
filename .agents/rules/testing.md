---
paths:
  - "tests/**"
---

# Test harness

340 tests across 14 files, no dependencies, no cluster, no gnome-shell. Every shipped file
is held at 100% line, branch and function coverage by `npm run coverage`, which is part of
`npm run check` and its own CI job.

## How gi-dependent code is testable at all

- The gi-free modules (`model.js`, `schedule.js`, `alerts.js`, `i18n.js`, `theme.js`,
  `log.js`) are
  tested directly, because node can resolve every import they have.
- Everything else imports `gi://…` or `resource:///…`, which node cannot resolve.
  `tests/hooks.mjs` redirects those specifiers at `tests/stubs/` using `node:module`
  `registerHooks`. Use the synchronous form: `module.register()` is deprecated and cannot
  intercept these specifiers at all.
- The hook is loaded with `--import ./tests/hooks.mjs`, which runs before the test files,
  so their static imports are caught.

## The fakes are behavioural, not empty

- `stubs/gi/GLib.js` owns a clock that only moves when a test says so: `__advance` drains
  timers, `__setClock` moves time alone. Cadence, backoff, the watchdog and `group_wait`
  are asserted without sleeping. **Never add a real sleep to a test.**
- `stubs/gi/Gio.js` makes the subprocess scriptable (`hang`, `defer`, `throws`, non-zero
  exit, `null` stdout), which is what lets a poll be landed *after* `stop()` on purpose. It
  also carries a GSettings fake seeded with the real schema defaults that emits
  `changed`/`changed::key` like dconf.
- `stubs/shell/messageTray.js` can present either notification API generation, so the GNOME
  45 shim stays tested even though nobody develops on 45.
- `stubs/shell/extension.js` carries a real gettext catalogue (`__catalog`) and a pluggable
  plural rule (`__pluralIndex`). One test drives the whole stack in Ukrainian with a
  three-form plural rule. It is empty by default, so every other test reads in English.

## Two test files read source rather than run it

Nothing here executes them, so the invariant is checked textually:
`tests/stylesheet.test.js` holds the `:ltr`/`:rtl` rule over `stylesheet.css`, and
`tests/catalogues.test.js` holds what gettext's own tools cannot express over `po/*.po`.
Both were validated by injecting a violation and watching them fail. Do that too before
trusting a new check of this kind: the first catalogue parser silently dropped every
`msgctxt`, which made two of its assertions vacuous.

## Coverage is a review tool, not a vanity metric

Chasing full branch coverage has already found dead code, a prototype-chain bug in
`parseMemBytes`, `disable()` throwing when `enable()` never ran, a timer armed with no
owner, and a mute row shown before anything was muted.

When a branch resists covering, decide whether it is genuinely unreachable (delete it) or a
real guard (test it white-box, as with the poller's `_tick` re-entry guard). **Do not
contrive a test to paint it green.**

## Types

JSDoc plus the dev-only `@girs/*` packages. `npm run typecheck` runs two passes:
`tsconfig.json` is strict over the logic, and `tsconfig.ui.json` relaxes only
`strictNullChecks` for the GObject view (`extension.js`, `lib/indicator.js`,
`lib/notifier.js`), because `PanelMenu.Button` assigns fields in `_init` rather than a
constructor and JSDoc has no definite-assignment `!`.

## Node

Floor is 24 (Active LTS), set in `engines` and enforced by `.npmrc`'s `engine-strict`. CI
runs coverage on a matrix of 24 and 26 (Current). Coverage still needs
`--experimental-test-coverage` to switch collection on as of 26.5; only the
`--test-coverage-*` thresholds are unflagged, so the script keeps both.
