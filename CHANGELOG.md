# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Note that EGO additionally requires the integer `version` in `metadata.json` to
increase on every upload, independently of the semantic `version-name`.

## [Unreleased]

Not yet released. `metadata.json` still reads `0.1.0` / `version: 1`; bump both
when publishing.

### Added

- **Alert state machine** (`lib/alerts.js`), replacing the previous one-bit
  readiness diff. Prometheus-style `inactive → pending → firing` lifecycle with a
  `for` debounce and a `keep_firing_for` hold, an Alertmanager-style notification
  log for deduplication, state persisted across restarts, a settle guard for cold
  start / suspend / long screen-lock, and a new `ClusterUnreachable` alert that
  inhibits per-node alerts. A fully unreachable cluster used to notify nothing.
- **Alert grouping and urgency.** Simultaneous fires coalesce into one banner
  (`alert-group-wait`), fires post at `CRITICAL` so they stay put and appear under
  Do Not Disturb, resolves at normal urgency.
- **Mute / snooze** from the panel menu (15 minutes, 1 hour, 8 hours). A muted
  alert is withheld, not discarded: if it is still firing when the mute expires, it
  is delivered then.
- **A dedicated notification source** (`lib/notifier.js`) titled "Kube Node
  Monitor" with the helm icon, so banners are no longer attributed to the generic
  "System" source. Bridges the MessageTray API change at GNOME 46 by feature
  detection, and is tested against both generations.
- **Error classification** (`classifyError`): kubectl's raw multi-line stderr
  becomes a short human headline plus a de-noised detail, with the klog spam
  stripped and kubectl's own summary line preferred.
- **Opt-in diagnostics** (`lib/log.js`, `debug-logging`, off by default) recording
  poll outcomes, backoff state and alert decisions, so "why did I not get a
  notification?" is answerable from the journal.
- **Preferences**: a Notifications group (cluster-unreachable and recovery
  toggles, debounce, keep-firing, repeat interval, group wait) and a diagnostics
  switch under Advanced.
- `SECURITY.md`, this changelog, and an explicit `session-modes` in
  `metadata.json`.

### Changed

- **Test suite**: every shipped file is now held at 100% line, branch and function
  coverage (233 tests), enforced by `npm run coverage` in `npm run check` and as
  its own CI job. `tests/hooks.mjs` redirects `gi://` and `resource:///` imports to
  behavioural fakes so the IO, view, wiring and preferences layers are testable
  under plain node.
- **Menu width is now bounded.** A long single-line error used to stretch the popup
  across the screen; error text wraps and the context title ellipsizes.
- CI now builds a zip whose file set is identical to `npm run pack` (it previously
  included the compiled schema and swept directories blindly).

### Fixed

- A poll finishing after `disable()` could paint the *next* enable cycle's menu and
  fold a bogus "cluster unreachable" observation into the alert machine — a
  spurious banner on unlock, plus corrupted persisted state.
- `_refreshContextInfo` read its cancellable late, so `disable()` left an
  unkillable `kubectl` running and could write a stale context list into a new menu.
- The alert state was rewritten to dconf on *every* poll (~8600 writes/day at the
  default interval); the "only when changed" guard never held because the
  observation timestamp always changed.
- `disable()` posted a notification and then destroyed the source that would have
  rendered it, losing the alert while marking it delivered.
- `disable()` threw when `enable()` had never run, which is exactly when the shell
  calls it after a failed enable.
- A node being down was signalled by colour alone: the computed `NotReady` text was
  never rendered (WCAG 1.4.1). The panel's accessible name now tracks cluster
  state, node rows carry a spoken summary, the refresh button is reachable by
  keyboard, and focus is visible.
- GNOME's Light style was broken: a hardcoded white on a white popup (1.0:1).
- `parseMemBytes` read units off the prototype chain, so a capacity like
  `5constructor` yielded `NaN`.
- Removed dead code found while chasing full branch coverage: an unreachable
  scheduling branch in the poller, two `.catch` handlers on a function that cannot
  reject, and a redundant cancellation check.

### Security

- kubectl stderr no longer reaches notification bodies, which GNOME renders on the
  lock screen, and credential-shaped material (JWTs, presigned-URL parameters,
  `Authorization` headers, PEM blocks) is redacted before any display or logging.
  A credential plugin's stderr is merged into kubectl's, so this was reachable.
- The child process environment is now an allowlist instead of the whole session
  environment, which was being forwarded to `kubectl` and thence to exec credential
  plugins (SSH agent socket, bus address, keyring control, `environment.d` values).
- `kubectl-path` must be an absolute path to an executable regular file, closing a
  dconf-to-exec gadget.
- Node names are sanitised at the parse boundary: the name reaches the clipboard
  inside a `kubectl describe node` command, where a newline would auto-execute the
  remainder on paste.
- Persisted alert records are typechecked on load, and the preferences toast no
  longer runs untrusted text through the Pango markup parser.

## [0.1.0] — 2026-07-11

### Added

- Initial extension: panel indicator with a status dot, per-node readiness with
  up/down duration, role or failure reason, CPU/memory meters via metrics-server,
  a pods summary, one-click context switching, click-to-copy `kubectl describe
  node`, and desktop notifications on readiness changes.
- Two-tier polling (a compact jsonpath query while the menu is closed, full detail
  only while it is open), a per-poll watchdog, and exponential backoff.
- Pure, unit-tested core (`lib/model.js`, `lib/schedule.js`) with the IO and view
  layers kept at the edges.
