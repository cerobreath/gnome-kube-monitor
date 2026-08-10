// The poll loop: tier selection (cheap health poll with the menu closed, full
// detail when it is open), a per-poll watchdog, reentrancy and backoff. Each
// poll schedules the next one as a single-shot timer, so polls never overlap
// and the delay can grow on failure.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as client from './client.js';
import {applyMetrics, classifyError} from './model.js';
import {baseDelaySec, backoffDelaySec} from './schedule.js';
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
// Ceiling for backoff, and the longest a recovered cluster can stay shown as
// down. Must match MAX_BACKOFF_SECONDS in alerts.js, which keys the settle
// threshold off the largest gap this loop can legitimately produce.
const MAX_BACKOFF_SECONDS = 60;

// Best-effort fallback for the optional fetches. The explicit type keeps the
// return null rather than any in the relaxed view pass (see tsconfig.ui.json).
/** @type {() => null} */
const nullFallback = () => null;

export class KubePoller {
    /** @param {PollerDeps} deps */
    constructor(deps) {
        this._deps = deps;
        this._cancellable = new Gio.Cancellable();
        this._timerId = 0;
        this._watchdogId = 0;
        this._polling = false;
        this._menuOpen = false;
        this._failures = 0;
        this._stopped = true;
        this._refreshPending = false;
        /** @type {string | null} */
        this._pollKey = null;
    }

    start() {
        this._stopped = false;
        // A cancelled Gio.Cancellable never un-cancels, so without a fresh one
        // a stop() then start() on the same instance would fail every request
        // instantly with CANCELLED, silently and without ever backing off.
        if (this._cancellable.is_cancelled())
            this._cancellable = new Gio.Cancellable();
        this._tick();                 // poll immediately, then self-schedule
    }

    stop() {
        this._stopped = true;
        this._refreshPending = false;
        this._clearTimer();
        this._clearWatchdog();
        this._cancellable.cancel();   // in-flight poll unwinds quietly
    }

    // Switch tiers. Opening the menu pulls detail now, not at the next tick.
    /** @param {boolean} open */
    setMenuOpen(open) {
        if (open === this._menuOpen)
            return;
        this._menuOpen = open;
        if (open)
            this.refreshNow();
    }

    // Manual refresh (refresh button, context switch, connection setting change).
    // force restarts even an identical in-flight poll: after a network flip its
    // sockets are already dead, so waiting the watchdog out helps nobody.
    /** @param {boolean} [force] */
    refreshNow(force = false) {
        if (this._stopped)
            return;
        this._clearTimer();
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

    // Identity of a poll: what it fetches and with which options. Same key means
    // the running kubectl would be respawned with identical arguments.
    /** @param {'health' | 'detail'} tier @param {import('./client.js').Opts} opts */
    _pollKeyFor(tier, opts) {
        return [tier, opts.kubectlPath, opts.kubeconfig, opts.context].join('\n');
    }

    _desiredKey() {
        return this._pollKeyFor(this._menuOpen ? 'detail' : 'health', this._deps.getOpts());
    }

    // Re-arm the idle timer at the new base interval, without polling now.
    intervalChanged() {
        if (this._stopped || this._polling)
            return;
        this._clearTimer();
        this._scheduleNext(this._baseDelay());
    }

    _baseDelay() {
        return baseDelaySec(this._deps.getIntervalSec());
    }

    _nextDelay() {
        return backoffDelaySec(this._failures, this._baseDelay(), MAX_BACKOFF_SECONDS);
    }

    /** @param {number} delaySec */
    _scheduleNext(delaySec) {
        const cb = () => {
            this._timerId = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        };
        // timeout_add_seconds aligns to second boundaries for power saving, so a
        // zero delay can slip by up to ~1s. Immediate re-polls use milliseconds.
        this._timerId = delaySec <= 0
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, cb)
            : GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.round(delaySec), cb);
    }

    _clearTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _clearWatchdog() {
        if (this._watchdogId) {
            GLib.source_remove(this._watchdogId);
            this._watchdogId = 0;
        }
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
        this._watchdogId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_TIMEOUT_SECONDS, () => {
                timedOut = true;
                this._watchdogId = 0;
                cancellable.cancel();
                if (this._cancellable === cancellable)
                    this._cancellable = new Gio.Cancellable();
                return GLib.SOURCE_REMOVE;
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
                state = {tier, ...detail, pods, context: contextLabel, error: null};
            } else {
                const health = await client.fetchHealth(opts, cancellable);
                state = {tier, ...health, pods: null, context: contextLabel, error: null};
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
                nodes: [],
                readyCount: 0,
                total: 0,
                pods: null,
            });
        } finally {
            this._clearWatchdog();
            this._polling = false;
            this._pollKey = null;
            if (!this._stopped) {
                // A refresh, a context switch or the menu opening abandoned this
                // poll: re-poll at once with the new options and tier.
                const immediate = this._refreshPending;
                this._refreshPending = false;
                const delay = immediate ? 0 : this._nextDelay();
                debug('poll', 'next poll scheduled', {inSec: delay, failures: this._failures});
                this._scheduleNext(delay);
            }
        }
    }
}
