# Architecture

A pure core with thin IO and UI edges. Dependencies point inward toward `model.js`, and
nothing imports "up". That layering is what makes the logic testable without gnome-shell
and keeps the shell coupling in three files.

## Modules

| File | Role |
| --- | --- |
| `lib/model.js` | Parsing, severity, sorting, display strings, error classification. Pure. |
| `lib/i18n.js` | `_`, `ngettext`, `pgettext`, `N_`, and `format()`. Pure. |
| `lib/schedule.js` | Poll-cadence math: interval clamp, exponential backoff. Pure. |
| `lib/alerts.js` | The alert state machine. Pure. |
| `lib/log.js` | Opt-in diagnostics behind `debug-logging`. Pure. |
| `lib/client.js` | The only file that spawns `kubectl`. |
| `lib/poller.js` | The poll loop: tier selection, backoff, watchdog, reentrancy. |
| `lib/indicator.js` | The view: `PanelMenu.Button` and its menu. |
| `lib/notifier.js` | The notification edge: a dedicated `MessageTray.Source`. |
| `extension.js` | Wiring only. |

"Pure" means zero `gi://` imports, so the module runs unchanged under gnome-shell, plain
gjs and node. Time-dependent functions take an explicit `nowMs` rather than reading a
clock.

### Notable module contracts

**`model.js`** owns `classifyError`, which maps raw kubectl stderr to a `{key, title,
detail}`: a short human headline, kubectl's own summary line in preference to the klog
noise, and a machine-readable key so callers can branch on the cause instead of matching
prose that changes with the locale. Headline wording and its tests live here, not in the
view.

**`log.js`** uses `console.log` (GLib `LEVEL_MESSAGE`) rather than `console.debug`
(`LEVEL_DEBUG`). GLib's default log writer discards `LEVEL_DEBUG` unless `G_MESSAGES_DEBUG`
is set on the process, and you cannot set an environment variable on a gnome-shell the user
is already running. Measured in a nested shell, `console.debug` produced nothing at all.
Every line goes through `redactForLog` and a length cap.

**`alerts.js`** is a `reduce(prevState, observation, config, nowMs)` reducer turning each
poll observation into `fire`/`resolve` actions. It implements a Prometheus rule lifecycle
(`inactive → pending → firing`, with a `for` debounce and a `keep_firing_for` hold) over an
Alertmanager-style notify log for dedup and persistence. Also: cluster-unreachable
inhibition of node alerts, offline inhibition of the cluster alert (an observation flagged
`offline` steps like a settle, so a machine without a network never accumulates toward a
"cluster unreachable" banner while a pre-existing firing alert survives), a settle guard
for cold start, suspend and long screen locks, and a `silencedUntilMs` mute that withholds
without marking, so an alert still firing when the silence expires is delivered then.
`nowMs` is wall-clock, because the state must survive a reboot. State is serialized into
the `alert-state` GSettings key. `groupActions()` coalesces a batch into at most two
banners: fires at high urgency (not critical, which would never auto-hide), resolves at
normal.

**`indicator.js`** is decoupled from settings. It emits `refresh-requested`,
`context-selected(string)`, `menu-open-changed(bool)`, `node-copied(string)` and
`snooze-requested(int seconds)`, and never reads GSettings itself. Notifications are the
extension's job, so the copy row and the mute submenu emit rather than act; the extension
pushes mute state back with `setSnoozeUntil(ms)`.

**`notifier.js`** owns a `MessageTray.Source` titled "Kube Node Monitor" with the helm
icon, so banners are attributed to the extension instead of the generic "System" source. It
bridges the MessageTray API split at GNOME 46 (45 uses positional constructors and
`showNotification`; 46 onward use params objects and `addNotification`) by feature-detecting
`addNotification` on the `Source` prototype. The source is recreated after the shell
destroys it. At most one alert banner is live at a time (`notifyAlert`): a newer fire
replaces it and a resolve withdraws it, so the tray never holds a stale outage banner.

**`extension.js`** feeds each observation through `alerts.reduce`, buffers the returned
actions through a `group_wait` timer, dispatches them coalesced to `notifier.js`, and
persists the machine's state only when it changes. Its `changed` handler uses a
connection-key allowlist (`context`, `kubeconfig-path`, `kubectl-path`) so writing
`alert-state` does not self-trigger a re-poll; alert tunables are read live per observation.
It also owns the `Gio.NetworkMonitor` handler: poll failures while offline are classified
as such, and the first `network-changed` back to available forces an immediate re-poll
instead of waiting out the backoff.

## Two-tier polling

Polling cost lands inside the compositor process, so steady state has to be minimal. The
poller picks a tier by menu state.

| | Menu closed (almost always) | Menu open |
| --- | --- | --- |
| Call | `fetchHealth` | `fetchNodesDetail` + `fetchNodeMetrics` + `fetchPodsSummary` |
| Query | one compact jsonpath | `-o json`, the last two best-effort |
| Payload | ~250 B for the whole cluster | ~36 KB per node |
| Drives | panel dot and notifications | the full menu |

`setMenuOpen(true)` triggers an immediate detail poll instead of waiting for the next tick.

### Scale limits

Measured on a real 3-node k3s cluster: tier 2 costs about **36 KB per node**
(`status.images` is 40% of that) against **251 B for the entire cluster** in tier 1. A
1000-node cluster therefore means roughly 36 MB going through `JSON.parse` on the
compositor's main loop while the menu is open.

Two bounds contain it: `MAX_NODE_ROWS` (`indicator.js`) caps rows at 50, sorted
most-severe-first with the remainder summarised, and `MAX_TRACKED_ALERTS` (`alerts.js`)
caps the persisted alert map.

The row cap was profiled rather than reasoned about, on a Ryzen 7 5800HS under headless
GNOME 50, with synthetic nodes tuned to the measured 37 KB:

| nodes | capped at 50 | uncapped | tier-2 parse |
| --- | --- | --- | --- |
| 50 | 40 ms build / 129 ms laid out | same | 6 ms |
| 200 | 42 / 133 ms | 157 / 641 ms | 24 ms |
| 500 | 39 / 128 ms | 406 / 889 ms | 31 ms |
| 1000 | 43 / 138 ms | 830 / **1826 ms** | 64 ms |

The cap holds cost flat whatever the cluster size. Without it, a 1000-node cluster would
freeze the whole shell for nearly two seconds on every menu open. At roughly 2.5 ms per
row, halving the cap halves the hitch and shows half the nodes, which is an informed trade
rather than a guess. Re-rendering an unchanged list costs about 2.5 ms in total, so the
build cost lands on the first open and on a signature change, not on every poll.

The parse column is separate and is **not** capped: it scales with the whole cluster and is
the remaining tier-2 cost.

### One optimisation that was measured and rejected

Replacing tier 2's `-o json` with jsonpath does not work. Roles come from label *keys*,
jsonpath cannot prefix-filter a map, and emitting `{.metadata.labels}` wholesale is worse:
one kubevirt node carried around 500 labels, so the "optimised" query came out only 4x
smaller. Doing it properly needs a different projection, custom-columns for the scalars
plus the table output's ROLES column. That is a follow-up, not a free win.
