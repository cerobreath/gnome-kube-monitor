// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// The poll loop and the node watch. Health streams from a long-lived kubectl
// watch once it proves itself; polling remains the fallback, the menu-open
// detail tier, and the bridge whenever the watch is down. Each poll schedules
// the next one as a single-shot timer, so polls never overlap.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as client from './client.js';
import {
    applyMetrics, applyWatchEvent, classifyError, parseWatchEvent,
    reconcileDiffers, summarizeHealthMap,
} from './model.js';
import {
    baseDelaySec, backoffDelaySec, classifyWatchExit, flushDelayMs,
    MAX_BACKOFF_SECONDS, RECONCILE_SECONDS, WATCH_QUIET_MS, WATCH_STARTUP_SECONDS,
} from './schedule.js';
import {debug} from './log.js';

/**
 * @typedef {object} PollState
 * @property {'health' | 'detail'} tier
 * @property {string} context
 * @property {import('./model.js').NodeLevelValue} level
 * @property {(import('./model.js').HealthNode | import('./model.js').DetailNode)[]} nodes
 * @property {number} readyCount
 * @property {number} total
 * @property {import('./model.js').PodsSummary | null} [pods]
 * @property {import('./model.js').ClassifiedError | null} [error]
 * @property {number} [failures]  consecutive failed polls; 0 on success
 * @property {number} [monotonic]
 */

/**
 * @typedef {object} PollerDeps
 * @property {() => import('./client.js').Opts} getOpts
 * @property {() => number} getIntervalSec
 * @property {() => string} getContextLabel
 * @property {() => boolean} [isOffline]  true while the machine has no network route
 * @property {(state: PollState) => void} [onState]
 * @property {(obs: import('./alerts.js').AlertObservation) => void} [onObservation]
 */

// Hard cap on a single poll: a hung kubectl is cancelled, the loop keeps going.
const POLL_TIMEOUT_SECONDS = 12;

// Best-effort fallback for the optional fetches. The explicit type keeps the
// return null rather than any in the relaxed view pass (see tsconfig.ui.json).
/** @type {() => null} */
const nullFallback = () => null;

export class KubePoller {
    /** @param {PollerDeps} deps */
    constructor(deps) {
        this._deps = deps;
        this._cancellable = new Gio.Cancellable();
        // Every main loop source this class arms, keyed by role. Teardown is
        // one loop over this map, so no source id may live anywhere else.
        /** @type {Map<string, number>} */
        this._timeouts = new Map();
        this._polling = false;
        this._menuOpen = false;
        this._failures = 0;
        this._stopped = true;
        this._refreshPending = false;
        /** @type {string | null} */
        this._pollKey = null;

        // Watch state: the live child, its accumulated node map, and the
        // timers that coalesce, heartbeat, cross-check and respawn it.
        /** @type {client.NodeWatcher | null} */
        this._watcher = null;
        /** @type {string | null} */
        this._watchKey = null;
        this._watchActive = false;
        /** @type {Map<string, import('./model.js').HealthNode>} */
        this._watchMap = new Map();
        this._quickDeaths = 0;
        this._firstPendingMs = 0;
        this._lastEventMs = 0;
        this._reconcileFailures = 0;
    }

    start() {
        this._stopped = false;
        // A cancelled Gio.Cancellable never un-cancels, so without a fresh one
        // a stop() then start() on the same instance would fail every request
        // instantly with CANCELLED, silently and without ever backing off.
        if (this._cancellable.is_cancelled())
            this._cancellable = new Gio.Cancellable();
        this._spawnWatch();
        this._tick();                 // poll immediately, then self-schedule
    }

    // The teardown path, called from the extension's disable().
    stop() {
        this._stopped = true;
        this._refreshPending = false;
        this._teardownWatch();
        for (const name of [...this._timeouts.keys()])
            this._clearTimeout(name);
        this._cancellable.cancel();   // in-flight poll unwinds quietly
    }

    // The only place a source is armed: the name's previous holder is removed
    // on the line above each timeout_add, and the entry is forgotten before
    // the callback runs, because a fired source is already gone. Anything
    // recurring re-arms itself explicitly.
    /** @param {string} name @param {number} ms @param {() => void} cb */
    _timeoutAdd(name, ms, cb) {
        this._clearTimeout(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            cb();
            return GLib.SOURCE_REMOVE;
        }));
    }

    /** @param {string} name @param {number} sec @param {() => void} cb */
    _timeoutAddSeconds(name, sec, cb) {
        this._clearTimeout(name);
        this._timeouts.set(name, GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, sec, () => {
            this._timeouts.delete(name);
            cb();
            return GLib.SOURCE_REMOVE;
        }));
    }

    /** @param {string} name */
    _clearTimeout(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    // Switch tiers. Opening the menu pulls detail now, not at the next tick.
    /** @param {boolean} open */
    setMenuOpen(open) {
        if (open === this._menuOpen)
            return;
        this._menuOpen = open;
        if (open) {
            this.refreshNow();
        } else if (this._watchActive) {
            // The watch carries tier 1 again: drop the leftover detail cadence
            // and replace the menu's last detail state with a live snapshot.
            this._clearTimeout('poll');
            this._deliverWatchSnapshot();
        }
    }

    // Manual refresh (refresh button, context switch, connection setting change).
    // force restarts even an identical in-flight poll: after a network flip its
    // sockets are already dead, so waiting the watchdog out helps nobody.
    /** @param {boolean} [force] */
    refreshNow(force = false) {
        if (this._stopped)
            return;
        // New options or dead sockets invalidate the running watch or a parked
        // retry; the poll below bridges the gap until the new stream activates.
        if (force || (this._watcher && this._watchKey !== this._watchKeyFor(this._deps.getOpts())))
            this._restartWatch();
        this._clearTimeout('poll');
        if (this._polling) {
            // An identical poll is already in flight and will deliver this
            // refresh; restarting it would only push the answer further away.
            if (!force && !this._refreshPending && this._pollKey === this._desiredKey())
                return;
            // Abandon the in-flight poll, which may be stuck on an unreachable
            // context, and re-poll once it unwinds.
            this._refreshPending = true;
            this._cancellable.cancel();
            this._cancellable = new Gio.Cancellable();
            return;
        }
        this._tick();
    }

    // Identity of a poll: what it fetches and with which options.
    /** @param {'health' | 'detail'} tier @param {import('./client.js').Opts} opts */
    _pollKeyFor(tier, opts) {
        return [tier, opts.kubectlPath, opts.kubeconfig, opts.context].join('\n');
    }

    _desiredKey() {
        return this._pollKeyFor(this._menuOpen ? 'detail' : 'health', this._deps.getOpts());
    }

    /** @param {import('./client.js').Opts} opts */
    _watchKeyFor(opts) {
        return [opts.kubectlPath, opts.kubeconfig, opts.context].join('\n');
    }

    // Health polls stand down while the watch is active; the menu's detail
    // tier always polls, because the watch cannot see metrics or pods.
    _shouldPoll() {
        return this._menuOpen || !this._watchActive;
    }

    // Re-arm the idle timers at the new base interval, without polling now.
    intervalChanged() {
        if (this._stopped)
            return;
        if (this._timeouts.has('heartbeat'))
            this._startHeartbeat();   // re-arms on the new interval
        if (this._polling || !this._shouldPoll())
            return;
        this._scheduleNext(this._baseDelay());
    }

    _baseDelay() {
        return baseDelaySec(this._deps.getIntervalSec());
    }

    _nextDelay() {
        return backoffDelaySec(this._failures, this._baseDelay(), MAX_BACKOFF_SECONDS);
    }

    // timeout_add_seconds aligns to second boundaries for power saving, so a zero
    // delay can slip by up to ~1s. Immediate re-polls use milliseconds instead.
    /** @param {number} delaySec */
    _scheduleNext(delaySec) {
        const cb = () => this._tick();
        if (delaySec <= 0)
            this._timeoutAdd('poll', 0, cb);
        else
            this._timeoutAddSeconds('poll', Math.round(delaySec), cb);
    }

    /** @param {PollState} state */
    _deliver(state) {
        state.monotonic = GLib.get_monotonic_time();
        this._deps.onState?.(state);
    }

    // A poll that lands after stop(), or after a refresh superseded it, must
    // deliver nothing: gnome-shell reuses the Extension instance across
    // lock/unlock, so a late result would hit the next enable cycle's callbacks.
    /** @returns {boolean} */
    _isStale() {
        return this._stopped || this._refreshPending;
    }

    async _tick() {
        // Reentrancy: a slow poll must not be overlapped by the next tick.
        if (this._stopped || this._polling)
            return;
        this._polling = true;

        const opts = this._deps.getOpts();
        const contextLabel = this._deps.getContextLabel();
        const cancellable = this._cancellable;
        const tier = this._menuOpen ? 'detail' : 'health';
        this._pollKey = this._pollKeyFor(tier, opts);

        // Watchdog: cancel an overrunning poll and swap in a fresh cancellable so
        // the next tick starts clean. A hung kubectl would otherwise wedge on
        // "Loading" forever.
        let timedOut = false;
        this._timeoutAddSeconds('watchdog', POLL_TIMEOUT_SECONDS, () => {
            timedOut = true;
            cancellable.cancel();
            if (this._cancellable === cancellable)
                this._cancellable = new Gio.Cancellable();
        });

        try {
            /** @type {PollState} */
            let state;
            if (tier === 'detail') {
                // Nodes are required; metrics and pods are best-effort, so a
                // missing metrics-server or an RBAC gap never blanks the menu.
                const [detail, metrics, pods] = await Promise.all([
                    client.fetchNodesDetail(opts, cancellable),
                    client.fetchNodeMetrics(opts, cancellable).catch(nullFallback),
                    client.fetchPodsSummary(opts, cancellable).catch(nullFallback),
                ]);
                applyMetrics(detail.nodes, metrics);
                state = {tier, ...detail, pods, context: contextLabel, error: null, failures: 0};
            } else {
                const health = await client.fetchHealth(opts, cancellable);
                state = {tier, ...health, pods: null, context: contextLabel, error: null, failures: 0};
            }

            this._failures = 0;
            if (this._isStale()) {
                debug('poll', 'discarding a result that arrived after teardown', {tier});
                return;
            }
            debug('poll', 'ok', {tier, nodes: state.nodes.length, ready: state.readyCount});
            this._deps.onObservation?.({
                reachable: true,
                offline: false,
                context: contextLabel,
                nodes: state.nodes.map(n => ({name: n.name, ready: n.ready})),
                error: null,
            });
            this._deliver(state);
        } catch (e) {
            const err = /** @type {any} */ (e);
            const cancelled = err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            // stop() cancelled the poll; stay quiet, and finally won't reschedule.
            if (cancelled && !timedOut)
                return;

            this._failures++;
            if (this._isStale()) {
                debug('poll', 'discarding a failure that arrived after teardown', {tier});
                return;
            }
            const offline = this._deps.isOffline?.() ?? false;
            const error = classifyError(err?.message ?? err, {timedOut, offline});
            // Only the classified, redacted error is logged, never raw stderr.
            debug('poll', 'failed', {
                tier, failures: this._failures, timedOut, offline, reason: error.title,
            });
            // Cluster-unreachable observation; stale polls returned above, so
            // they never count as an outage.
            this._deps.onObservation?.({reachable: false, offline, context: contextLabel, nodes: [], error});
            this._deliver({
                tier,
                context: contextLabel,
                level: 'error',
                error,
                failures: this._failures,
                nodes: [],
                readyCount: 0,
                total: 0,
                pods: null,
            });
        } finally {
            this._clearTimeout('watchdog');
            this._polling = false;
            this._pollKey = null;
            if (!this._stopped) {
                // A refresh, a context switch or the menu opening abandoned this
                // poll: re-poll at once with the new options and tier.
                const immediate = this._refreshPending;
                this._refreshPending = false;
                if (immediate) {
                    this._scheduleNext(0);
                } else if (this._shouldPoll()) {
                    const delay = this._nextDelay();
                    debug('poll', 'next poll scheduled', {inSec: delay, failures: this._failures});
                    this._scheduleNext(delay);
                }
            }
        }
    }

    // The watch: spawn, coalesce, activate, heartbeat, reconcile, respawn.

    _spawnWatch() {
        if (this._stopped || this._watcher)
            return;
        const opts = this._deps.getOpts();
        this._watchKey = this._watchKeyFor(opts);
        this._watchMap = new Map();
        this._firstPendingMs = 0;
        const watcher = new client.NodeWatcher(opts, {
            onLine: line => this._onWatchLine(watcher, line),
            onExit: info => this._onWatchExit(watcher, info),
        });
        this._watcher = watcher;
        watcher.start();
        // A stream that produces no snapshot in this budget is not coming:
        // a black-holed route can hang the dial far longer than any poll.
        this._timeoutAddSeconds('watchStartup', WATCH_STARTUP_SECONDS, () => {
            watcher.stop();
            this._onWatchExit(watcher, {
                ok: false, detail: '', lifetimeMs: WATCH_STARTUP_SECONDS * 1000,
            });
        });
    }

    /** Kill the watch and release everything it owns. */
    _teardownWatch() {
        this._watcher?.stop();
        this._releaseWatch();
    }

    /** Drop every reference and main loop source the watch owned. */
    _releaseWatch() {
        this._watcher = null;
        this._watchKey = null;
        this._watchActive = false;
        this._watchMap = new Map();
        this._firstPendingMs = 0;
        this._reconcileFailures = 0;
        for (const name of ['watchStartup', 'coalesce', 'heartbeat', 'reconcile', 'watchRetry'])
            this._clearTimeout(name);
    }

    _restartWatch() {
        this._teardownWatch();
        this._quickDeaths = 0;
        this._spawnWatch();
    }

    _monotonicMs() {
        return GLib.get_monotonic_time() / 1000;
    }

    /**
     * @param {client.NodeWatcher} watcher
     * @param {string} line
     */
    _onWatchLine(watcher, line) {
        if (watcher !== this._watcher || this._stopped)
            return;
        const event = parseWatchEvent(line);
        if (!event)
            return;
        applyWatchEvent(this._watchMap, event);
        const now = this._monotonicMs();
        if (!this._firstPendingMs)
            this._firstPendingMs = now;
        this._lastEventMs = now;
        if (!this._timeouts.has('coalesce'))
            this._armCoalesce(WATCH_QUIET_MS);
    }

    // Coalescing turns the initial ADDED burst, and kubectl's habit of sending
    // several MODIFIED events per real change, into one complete snapshot, so
    // the alert machine never observes a half-listed cluster.
    /** @param {number} delayMs */
    _armCoalesce(delayMs) {
        this._timeoutAdd('coalesce', delayMs, () => {
            const wait = flushDelayMs(
                this._monotonicMs(), this._firstPendingMs, this._lastEventMs);
            if (wait > 0)
                this._armCoalesce(wait);
            else
                this._flushWatch();
        });
    }

    _flushWatch() {
        this._firstPendingMs = 0;
        if (!this._watchActive) {
            this._watchActive = true;
            this._quickDeaths = 0;
            this._failures = 0;
            this._clearTimeout('watchStartup');
            this._startHeartbeat();
            this._startReconcile();
            // The watch now carries tier 1; polling stands down until the
            // menu opens or the stream dies.
            if (!this._menuOpen)
                this._clearTimeout('poll');
            debug('watch', 'active', {nodes: this._watchMap.size});
        }
        if (this._menuOpen)
            this._emitWatchObservation();   // the detail poll owns the view
        else
            this._deliverWatchSnapshot();
    }

    /** @returns {import('./model.js').NodeSummary<import('./model.js').HealthNode>} */
    _emitWatchObservation() {
        const summary = summarizeHealthMap(this._watchMap);
        this._deps.onObservation?.({
            reachable: true,
            offline: false,
            context: this._deps.getContextLabel(),
            nodes: summary.nodes.map(n => ({name: n.name, ready: n.ready})),
            error: null,
        });
        return summary;
    }

    _deliverWatchSnapshot() {
        const summary = this._emitWatchObservation();
        debug('watch', 'snapshot', {nodes: summary.total, ready: summary.readyCount});
        this._deliver({
            tier: 'health',
            context: this._deps.getContextLabel(),
            level: summary.level,
            nodes: summary.nodes,
            readyCount: summary.readyCount,
            total: summary.total,
            pods: null,
            error: null,
            failures: 0,
        });
    }

    // The alert machine steps on observations, so a healthy but silent stream
    // must keep observing at the poll cadence; the map costs nothing to read.
    _startHeartbeat() {
        this._timeoutAddSeconds('heartbeat', Math.round(this._baseDelay()), () => {
            if (this._stopped || !this._watchActive)
                return;
            // Polls emit their own observations, and a pending flush is
            // fresher than the map.
            if (!this._menuOpen && !this._polling && !this._firstPendingMs)
                this._emitWatchObservation();
            this._startHeartbeat();
        });
    }

    // The cross-check: a server-printed table is cheap, and any disagreement
    // with the map means the stream went stale and must re-list.
    _startReconcile() {
        this._timeoutAddSeconds('reconcile', RECONCILE_SECONDS, () => this._reconcile());
    }

    async _reconcile() {
        if (this._stopped || !this._watchActive)
            return;
        if (this._polling) {
            // The menu's detail poll is already talking to the cluster.
            this._startReconcile();
            return;
        }
        try {
            const rows = await client.fetchHealthTable(this._deps.getOpts(), this._cancellable);
            if (this._stopped || !this._watchActive)
                return;
            this._reconcileFailures = 0;
            if (reconcileDiffers(this._watchMap, rows)) {
                debug('watch', 'reconcile drift, restarting', {
                    mapped: this._watchMap.size, listed: rows.length,
                });
                this._restartWatch();
                return;
            }
            this._startReconcile();
        } catch (e) {
            const err = /** @type {any} */ (e);
            if (err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (this._stopped || !this._watchActive)
                return;
            this._reconcileFailures++;
            debug('watch', 'reconcile failed', {
                failures: this._reconcileFailures,
                reason: classifyError(err?.message ?? err).title,
            });
            // Two misses while the stream stays silent smells like a dead
            // connection; restarting lets the polling fallback surface it.
            if (this._reconcileFailures >= 2) {
                this._restartWatch();
                return;
            }
            this._startReconcile();
        }
    }

    /**
     * @param {client.NodeWatcher} watcher
     * @param {import('./client.js').WatchExitInfo} info
     */
    _onWatchExit(watcher, info) {
        // Identity, not lifecycle: a superseded stream was already released by
        // whoever replaced it, and the state below belongs to its successor.
        if (watcher !== this._watcher)
            return;
        const wasActive = this._watchActive;
        this._releaseWatch();

        const plan = classifyWatchExit(info.lifetimeMs / 1000, this._quickDeaths);
        this._quickDeaths = plan.quickDeaths;
        // Only the classified error is logged, never raw stderr.
        debug('watch', 'exited', {
            ok: info.ok,
            lifetimeSec: Math.round(info.lifetimeMs / 1000),
            quickDeaths: plan.quickDeaths,
            retryInSec: plan.delaySec,
            reason: info.ok ? '' : classifyError(info.detail).title,
        });

        if (plan.delaySec <= 0) {
            // A stream that lived long enough is just the server ending the
            // request; respawn at once, the fresh list bridges the gap.
            this._spawnWatch();
            return;
        }
        this._scheduleWatchRetry(plan.delaySec);
        // Polling carries the load until the watch comes back; an immediate
        // poll turns "the stream died" into a classified truth right away.
        if (wasActive && !this._polling && !this._timeouts.has('poll'))
            this._scheduleNext(0);
    }

    // Backoff, not cleanup: the dead watch is already released above, and
    // polling covers the cluster until this respawns the stream.
    /** @param {number} delaySec */
    _scheduleWatchRetry(delaySec) {
        this._timeoutAddSeconds('watchRetry', delaySec, () => this._spawnWatch());
    }
}
