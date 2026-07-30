// The poll loop. Owns tier selection (cheap health poll when the menu is
// closed, full detail when it's open), a per-poll watchdog, reentrancy, and
// exponential backoff when the cluster is unreachable.
//
// It self-reschedules a single-shot timer after every poll rather than using a
// fixed recurring timer: this lets the delay grow on failure and guarantees a
// poll never overlaps the previous one.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as client from './client.js';
import {applyMetrics, classifyError} from './model.js';
import {baseDelaySec, backoffDelaySec} from './schedule.js';

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
 * @property {(state: PollState) => void} [onState]
 * @property {(obs: import('./alerts.js').AlertObservation) => void} [onObservation]
 */

// Hard cap on a single poll. If kubectl hangs (e.g. no network right after
// boot), the poll is cancelled and the loop keeps going instead of wedging.
const POLL_TIMEOUT_SECONDS = 12;
// Ceiling for backoff, so an unreachable cluster is retried at most this often.
const MAX_BACKOFF_SECONDS = 300;

// Best-effort fallback for the optional fetches. The explicit type keeps the
// return as `null` (not `any`) when this file is pulled into the view-layer
// type-check pass, which relaxes strictNullChecks (see tsconfig.ui.json).
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
    }

    start() {
        this._stopped = false;
        this._tick();                 // poll immediately, then self-schedule
    }

    stop() {
        this._stopped = true;
        this._refreshPending = false;
        this._clearTimer();
        this._clearWatchdog();
        this._cancellable.cancel();   // in-flight poll unwinds quietly
    }

    // Switch tiers. Opening the menu pulls full detail right away instead of
    // waiting for the next tick.
    /** @param {boolean} open */
    setMenuOpen(open) {
        if (open === this._menuOpen)
            return;
        this._menuOpen = open;
        if (open)
            this.refreshNow();
    }

    // Manual refresh (refresh button, context switch, connection setting change).
    refreshNow() {
        if (this._stopped)
            return;
        this._clearTimer();
        if (this._polling) {
            // Abandon the in-flight poll (it may be slow, or stuck on an
            // unreachable context) and re-poll immediately once it unwinds.
            this._refreshPending = true;
            this._cancellable.cancel();
            this._cancellable = new Gio.Cancellable();
            return;
        }
        this._tick();
    }

    // The base interval changed; re-arm the idle timer so it takes effect
    // without forcing an immediate poll.
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
        // Seconds-granularity timers are aligned to second boundaries for power
        // saving, so a "0s" delay can slip by up to ~1s. Use a millisecond timer
        // for immediate re-polls (context switch); seconds only for real delays.
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

    async _tick() {
        if (this._stopped || this._polling)
            return;
        this._polling = true;

        const opts = this._deps.getOpts();
        const contextLabel = this._deps.getContextLabel();
        const cancellable = this._cancellable;
        const tier = this._menuOpen ? 'detail' : 'health';

        // Watchdog: cancel the poll if it overruns, replacing the shared
        // cancellable so the next tick starts clean. This is what prevents the
        // "eternal Loading" wedge when kubectl hangs on an unreachable cluster.
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
                // Detail is only reached while the menu is open. Nodes are
                // required; metrics/pods are best-effort so a missing
                // metrics-server or an RBAC gap never blanks the menu.
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
            this._deps.onObservation?.({
                reachable: true,
                context: contextLabel,
                nodes: state.nodes.map(n => ({name: n.name, ready: n.ready})),
                error: null,
            });
            this._deliver(state);
        } catch (e) {
            const err = /** @type {any} */ (e);
            const cancelled = err?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            if (cancelled && !timedOut)
                return;   // stop() cancelled us; stay quiet (finally won't reschedule)

            this._failures++;
            const error = classifyError(err?.message ?? err, {timedOut});
            // Feed the alerter a "cluster unreachable" observation. The stop()
            // cancellation above returns first, so a teardown/context switch
            // never counts as an outage.
            this._deps.onObservation?.({reachable: false, context: contextLabel, nodes: [], error});
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
            if (!this._stopped) {
                if (this._refreshPending) {
                    // A context switch / manual refresh cancelled this poll;
                    // re-poll now with the new options.
                    this._refreshPending = false;
                    this._scheduleNext(0);
                } else {
                    // If the menu opened mid-poll we just did a cheap health
                    // poll; fetch detail now instead of waiting a full interval.
                    const wantDetailNow = this._menuOpen && tier === 'health';
                    this._scheduleNext(wantDetailNow ? 0 : this._nextDelay());
                }
            }
        }
    }
}
