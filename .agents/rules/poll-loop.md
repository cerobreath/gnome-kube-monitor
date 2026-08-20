---
paths:
  - "lib/poller.js"
  - "lib/client.js"
  - "lib/schedule.js"
---

# Poll loop invariants

This loop runs inside the compositor process, so a wedge here freezes the desktop. Preserve
all five, plus the watch rules below.

- **Reentrancy**: `_polling` guards against overlapping polls. The timer is a
  self-rescheduling single-shot, not a fixed recurring one, which guarantees the next poll
  is scheduled in `finally` and makes backoff possible.
- **Watchdog plus cancellable swap**: each poll arms a `POLL_TIMEOUT_SECONDS` watchdog that
  cancels the shared `Gio.Cancellable` **and replaces it with a fresh one**, so the next
  tick starts clean. This is what prevents the "eternal Loading" wedge on an unreachable
  cluster. `stop()` cancels it too, and the catch block distinguishes a real timeout
  (`timedOut`) from a `stop()` cancellation so teardown stays silent and does not
  reschedule.
- **Backoff**: consecutive failures grow the delay from the base interval to
  `MAX_BACKOFF_SECONDS` and reset on success. The math and the cap are pure in
  `schedule.js` and unit-tested; keep them there. The alert machine's settle threshold
  keys off the same constant, which is why it is shared rather than copied.
- **Refresh coalescing**: `refreshNow()` lets an in-flight poll with the same tier and
  options deliver instead of restarting it, so button-mashing cannot starve the answer.
  `refreshNow(true)` force-restarts; the network-reconnect path needs that because the
  in-flight poll's sockets are already dead.
- **Tier agreement**: both polling tiers derive `level` and `ready` from the same
  `model.js` helpers, so the panel dot means the same thing either way. A new severity
  source goes into `deriveStatus`/`nodeLevel`, never into one tier.

## Watch rules

Tier 1 is normally a long-lived `kubectl get nodes --watch` (`NodeWatcher` in
`lib/client.js`); polling is the bridge, the fallback and the menu-open detail tier.

- **Polling never goes away.** `_shouldPoll()` is `menuOpen || !watchActive`. The watch
  only suspends health polls after its first complete snapshot; any exit resumes them, so
  every failure surface stays the tested poll path.
- **The watch argv must not carry `--request-timeout`**: the flag cleanly ends a watch
  when it elapses (rc 0, measured). Its jsonpath cannot use `{range}` on watch events
  (broken in kubectl 1.35), hence the zipped condition lists.
- **Snapshots are complete or not at all.** Events coalesce (quiet 250 ms, cap 1.5 s)
  before the alert machine observes them; never deliver a half-listed cluster.
- **Every source id lives in `_timeouts`**, keyed by role, and is armed only through
  `_timeoutAdd`/`_timeoutAddSeconds`. The helper removes the name's previous holder on
  the line above the `timeout_add` and forgets the entry before the callback runs, since
  a fired source is already gone. `stop()` loops the map; `_releaseWatch()` clears the
  five watch names. EGO review checks teardown against exactly this one collection, and
  a scheduler that refuses to re-arm instead of replacing is rejected too.
- **Respawn policy lives in `schedule.js`** (`classifyWatchExit`): stable exits respawn at
  once, quick deaths back off, three park the watch behind the slow retry. Keep the math
  pure and tested.
- The reconcile table cross-checks membership, readiness and cordon only; it cannot see
  pressure conditions, so it must never feed the panel dot directly.

## Observations

`onObservation` fires from **both** the success and the error path. The error path is what
lets the alert machine see an unreachable cluster. A `stop()` cancellation emits neither
that nor `onState`.

## The kubectl edge

`lib/client.js` is the only file that spawns a process. It builds the environment
explicitly, because gnome-shell has a trimmed `PATH` and no `KUBECONFIG`, always passes
`--request-timeout=5s` so a stalled API server cannot outlive the poll interval, and
delegates all parsing to `model.js`.

**Never log raw kubectl output.** Its stderr can carry credential material from an exec
plugin, and the journal is readable and long-lived. Route it through `classifyError` or
`redactForLog`.

Tier selection and the measurements behind it: `docs/architecture.md`.

## Smoke-testing against a real cluster

A plain `gjs` script can import `lib/client.js` and call the `fetch*` functions. Use a
static `import`, not `await import()`: in standalone gjs a top-level dynamic import plus a
manually-run `MainLoop` deadlocks, because they contend for the main context. Inside
gnome-shell this never arises.
