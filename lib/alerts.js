// Alert state machine for node readiness and cluster reachability: a Prometheus
// rule lifecycle (inactive -> pending -> firing, with a for-debounce and a
// keep_firing_for hold) over an Alertmanager notify log. Kept gi-free, with
// wall-clock time injected as nowMs; poller.js feeds it, extension.js dispatches.

import {_, ngettext, format} from './i18n.js';
import {errorTitle} from './model.js';

/**
 * @typedef {'inactive' | 'pending' | 'firing'} AlertPhase
 */

/**
 * One alert's lifecycle record. Only pending/firing records are persisted, so
 * the map stays bounded by the number of currently-degraded alerts.
 * @typedef {object} AlertRecord
 * @property {AlertPhase} phase
 * @property {number} since           wall-ms the current phase began
 * @property {number} lastNotifiedAt  wall-ms of the last notification (0 = never)
 * @property {'firing' | 'resolved'} lastStatus  the last NOTIFIED status (notify log)
 * @property {number} resolveSince    wall-ms the condition first went false while firing (0 = true now); drives keep_firing_for
 */

/**
 * The persisted blob. A different context reads as a cold start; v lets a future
 * shape change discard old blobs.
 * @typedef {object} AlertState
 * @property {number} v
 * @property {string} context
 * @property {number} lastObservedAt  wall-ms of the last processed observation
 * @property {Record<string, AlertRecord>} alerts  keyed 'ClusterUnreachable' | 'NodeNotReady:<name>'
 */

/**
 * @typedef {object} AlertObservation
 * @property {boolean} reachable
 * @property {boolean} [offline]  the machine itself had no network route
 * @property {string} context
 * @property {{name: string, ready: boolean}[]} nodes
 * @property {import('./model.js').ClassifiedError | null} [error]  set when !reachable
 */

/**
 * @typedef {object} AlertConfig
 * @property {boolean} nodeEnabled
 * @property {boolean} clusterEnabled
 * @property {boolean} resolveNotify
 * @property {number} nodeForSec
 * @property {number} clusterForSec
 * @property {number} keepFiringForSec
 * @property {number} repeatIntervalSec  0 = never re-notify a still-firing alert
 * @property {number} intervalSec        base poll interval (feeds the settle window)
 * @property {number} settleFactor       gap > settleFactor x max(interval, backoffCap) => settle
 * @property {number} silencedUntilMs    wall-ms until which notifications are muted (0 = not silenced)
 */

/**
 * @typedef {object} AlertAction
 * @property {'fire' | 'resolve'} type
 * @property {string} key
 * @property {string} label  short target name (node name, or 'cluster') for grouped banners
 * @property {string} title
 * @property {string} body
 */

const STATE_VERSION = 1;
// Must match MAX_BACKOFF_SECONDS in poller.js: the settle threshold is keyed off
// the delay an outage backs the poll loop off to.
const MAX_BACKOFF_SECONDS = 60;
// Never treat a gap under this as a settle, even at tiny poll intervals.
const SETTLE_FLOOR_MS = 90_000;
// Ceiling on tracked alerts, so a cluster-wide outage can't grow the persisted
// blob without bound. See capAlerts().
const MAX_TRACKED_ALERTS = 200;

export const CLUSTER_KEY = 'ClusterUnreachable';
const NODE_PREFIX = 'NodeNotReady:';

/** @param {number} now @param {number} then @returns {number} non-negative elapsed ms */
function elapsed(now, then) {
    return Math.max(0, now - then);
}

/**
 * @param {AlertConfig} config
 * @returns {number} ms gap above which an observation counts as a settle event
 */
function settleGapMs(config) {
    return Math.max(SETTLE_FLOOR_MS,
        config.settleFactor * Math.max(config.intervalSec, MAX_BACKOFF_SECONDS) * 1000);
}

/**
 * A fresh pending record, carrying any prior notify-log fields forward so
 * re-anchoring keeps the delivery history.
 * @param {number} nowMs
 * @param {AlertRecord | undefined} prev
 * @returns {AlertRecord}
 */
function pendingRecord(nowMs, prev) {
    return {
        phase: 'pending',
        since: nowMs,
        lastNotifiedAt: prev?.lastNotifiedAt ?? 0,
        lastStatus: prev?.lastStatus ?? 'resolved',
        resolveSince: 0,
    };
}

/**
 * @typedef {object} StepOpts
 * @property {number} forSec
 * @property {number} keepFiringForSec
 * @property {number} repeatIntervalSec
 * @property {boolean} enabled       when false, the lifecycle still advances but no action is emitted (and the log is marked, so re-enabling never replays)
 * @property {boolean} resolveNotify
 * @property {boolean} settle        silent sync: preserve firing, re-anchor pending, drop on false, emit nothing
 * @property {number} silencedUntilMs  wall-ms until which notifications are muted (0 = not silenced)
 * @property {string} key
 * @property {string} label
 * @property {string} fireTitle
 * @property {string} fireBody
 * @property {string} resolveTitle
 * @property {string} resolveBody
 */

/**
 * Advance one alert by one observation. Never mutates prev.
 * @param {AlertRecord | undefined} prev
 * @param {boolean} cond  is the alert's condition (bad) currently true?
 * @param {number} nowMs
 * @param {StepOpts} opts
 * @returns {{rec: AlertRecord | null, action: AlertAction | null}}
 */
function stepAlert(prev, cond, nowMs, opts) {
    const {enabled, resolveNotify, key} = opts;
    /** @param {'fire' | 'resolve'} type @returns {AlertAction} */
    const action = type => ({
        type,
        key,
        label: opts.label,
        title: type === 'fire' ? opts.fireTitle : opts.resolveTitle,
        body: type === 'fire' ? opts.fireBody : opts.resolveBody,
    });

    // Settle syncs to current truth silently: keep a known firing alert,
    // re-anchor anything else still bad to pending, drop cleared alerts without
    // a stale resolve banner.
    if (opts.settle) {
        if (cond) {
            if (prev && prev.phase === 'firing')
                return {rec: {...prev, resolveSince: 0}, action: null};
            return {rec: pendingRecord(nowMs, prev), action: null};
        }
        return {rec: null, action: null};
    }

    const silenced = nowMs < opts.silencedUntilMs;

    if (cond) {
        if (!prev || prev.phase === 'inactive')
            return {rec: pendingRecord(nowMs, prev ?? undefined), action: null};

        if (prev.phase === 'pending' && elapsed(nowMs, prev.since) < opts.forSec * 1000)
            return {rec: {...prev}, action: null};   // still inside the for window

        // wantNotify covers the pending->firing edge, a firing episode not yet
        // delivered (it fired while silenced), and repeat_interval re-notification.
        const becameFiring = prev.phase !== 'firing';
        const wantNotify = prev.lastStatus !== 'firing' ||
            (opts.repeatIntervalSec > 0 && elapsed(nowMs, prev.lastNotifiedAt) >= opts.repeatIntervalSec * 1000);
        /** @type {AlertRecord} */
        const rec = {
            phase: 'firing',
            since: becameFiring ? nowMs : prev.since,
            lastNotifiedAt: prev.lastNotifiedAt,
            lastStatus: prev.lastStatus,
            resolveSince: 0,
        };
        if (wantNotify && !silenced) {
            // Mark the notify-log delivered before emitting. When disabled it is
            // marked without a banner, so re-enabling never replays.
            rec.lastNotifiedAt = nowMs;
            rec.lastStatus = 'firing';
            return {rec, action: enabled ? action('fire') : null};
        }
        // Silenced, or nothing to notify: the log stays untouched so a still-
        // firing alert delivers once the silence expires.
        return {rec, action: null};
    }

    // Condition is false (good).
    if (!prev || prev.phase === 'inactive')
        return {rec: null, action: null};
    if (prev.phase === 'pending')
        return {rec: null, action: null};   // cleared before firing -> inactive, silent

    // Firing and now good: hold for keep_firing_for, then resolve.
    const resolveSince = prev.resolveSince || nowMs;
    if (elapsed(nowMs, resolveSince) >= opts.keepFiringForSec * 1000) {
        const emit = enabled && resolveNotify && !silenced && prev.lastStatus === 'firing';
        return {rec: null, action: emit ? action('resolve') : null};
    }
    return {rec: {...prev, resolveSince}, action: null};
}

/**
 * Fold one observation into the alert state. Never mutates prevState.
 *
 * The cluster alert is evaluated first: an unreachable cluster inhibits per-node
 * alerts, freezing their records rather than resolving them.
 *
 * @param {AlertState | null} prevState
 * @param {AlertObservation} observation
 * @param {AlertConfig} config
 * @param {number} nowMs  wall clock (Date.now() at the call site)
 * @returns {{state: AlertState, actions: AlertAction[]}}
 */
export function reduce(prevState, observation, config, nowMs) {
    /** @type {AlertAction[]} */
    const actions = [];

    const base = prevState && prevState.v === STATE_VERSION && prevState.context === observation.context
        ? prevState
        : null;
    const prevAlerts = base ? base.alerts : {};

    // Settle on a cold start, a large gap (suspend, long lock, reboot), or a
    // backward wall-clock jump.
    let settle = base === null;
    if (base) {
        const gap = nowMs - base.lastObservedAt;
        if (gap < 0 || gap > settleGapMs(config))
            settle = true;
    }

    /** @type {Record<string, AlertRecord>} */
    const alerts = {};

    // ClusterUnreachable, always evaluated. A failure while the machine itself
    // is offline says nothing about the cluster, so it steps like a settle:
    // a firing alert survives, but nothing accumulates toward a new banner.
    {
        const prev = prevAlerts[CLUSTER_KEY];
        const offline = !observation.reachable && observation.offline === true;
        const {rec, action} = stepAlert(prev, !observation.reachable, nowMs, {
            forSec: config.clusterForSec,
            keepFiringForSec: config.keepFiringForSec,
            repeatIntervalSec: config.repeatIntervalSec,
            enabled: config.clusterEnabled,
            resolveNotify: config.resolveNotify,
            settle: settle || offline,
            silencedUntilMs: config.silencedUntilMs,
            key: CLUSTER_KEY,
            // Translators: stands in for a node name in a grouped banner's list,
            // e.g. "web-1, db-2, cluster". Lowercase, to read as one list item.
            label: _('cluster'),
            fireTitle: observation.error?.title ?? errorTitle('unreachable'),
            // No body: kubectl's raw detail can carry credential material from an
            // exec plugin's stderr, and GNOME renders notification bodies on the
            // lock screen. The detail stays in the menu.
            fireBody: '',
            // Translators: notification title when the cluster answers again.
            resolveTitle: _('Cluster reachable again'),
            resolveBody: '',
        });
        if (rec)
            alerts[CLUSTER_KEY] = rec;
        if (action)
            actions.push(action);
    }

    // Per-node alerts
    if (observation.reachable) {
        // The first reachable tick after an unreachable one re-anchors pending
        // node timers: the outage gap is not NotReady evidence. resolveSince === 0
        // on the prior cluster record identifies that edge.
        const prevCluster = prevAlerts[CLUSTER_KEY];
        const recovering = prevCluster !== undefined && prevCluster.resolveSince === 0;
        const seen = new Set();

        for (const node of observation.nodes) {
            const key = NODE_PREFIX + node.name;
            seen.add(key);
            let prev = prevAlerts[key];
            if (recovering && prev && prev.phase === 'pending')
                prev = {...prev, since: nowMs};
            const {rec, action} = stepNode(prev, !node.ready, node.name, nowMs, config, settle);
            if (rec)
                alerts[key] = rec;
            if (action)
                actions.push(action);
        }

        // Nodes that dropped out of the list: treat as recovered/removed.
        for (const [key, prev] of Object.entries(prevAlerts)) {
            if (key === CLUSTER_KEY || seen.has(key))
                continue;
            const name = key.slice(NODE_PREFIX.length);
            const {rec, action} = stepNode(prev, false, name, nowMs, config, settle);
            if (rec)
                alerts[key] = rec;
            if (action)
                actions.push(action);
        }
    } else {
        // Unreachable: node records freeze unchanged, inhibited by the cluster
        // alert. Wall-clock since survives; the recovery edge re-anchors them.
        for (const [key, prev] of Object.entries(prevAlerts)) {
            if (key !== CLUSTER_KEY)
                alerts[key] = prev;
        }
    }

    return {
        state: {
            v: STATE_VERSION,
            context: observation.context,
            lastObservedAt: nowMs,
            alerts: capAlerts(alerts),
        },
        actions,
    };
}

/**
 * Bound the tracked-alert map, so a rolling reboot of thousands of nodes can't
 * persist a multi-megabyte blob. Firing records are kept ahead of pending ones.
 * @param {Record<string, AlertRecord>} alerts
 * @returns {Record<string, AlertRecord>}
 */
function capAlerts(alerts) {
    const keys = Object.keys(alerts);
    if (keys.length <= MAX_TRACKED_ALERTS)
        return alerts;
    // The cluster alert is reserved outside the ranking: special-casing it inside
    // the comparator would make the outcome depend on Array.sort internals.
    const cluster = alerts[CLUSTER_KEY];
    const budget = MAX_TRACKED_ALERTS - (cluster ? 1 : 0);
    const ranked = keys
        .filter(k => k !== CLUSTER_KEY)
        .sort((a, b) => {
            const pa = alerts[a].phase === 'firing' ? 0 : 1;
            const pb = alerts[b].phase === 'firing' ? 0 : 1;
            return pa !== pb ? pa - pb : alerts[a].since - alerts[b].since;
        })
        .slice(0, budget);
    /** @type {Record<string, AlertRecord>} */
    const capped = {};
    if (cluster)
        capped[CLUSTER_KEY] = cluster;
    for (const key of ranked)
        capped[key] = alerts[key];
    return capped;
}

/**
 * stepAlert specialized for a node, with the node's wording.
 * @param {AlertRecord | undefined} prev
 * @param {boolean} cond
 * @param {string} name
 * @param {number} nowMs
 * @param {AlertConfig} config
 * @param {boolean} settle
 * @returns {{rec: AlertRecord | null, action: AlertAction | null}}
 */
function stepNode(prev, cond, name, nowMs, config, settle) {
    return stepAlert(prev, cond, nowMs, {
        forSec: config.nodeForSec,
        keepFiringForSec: config.keepFiringForSec,
        repeatIntervalSec: config.repeatIntervalSec,
        enabled: config.nodeEnabled,
        resolveNotify: config.resolveNotify,
        settle,
        silencedUntilMs: config.silencedUntilMs,
        key: NODE_PREFIX + name,
        label: name,
        // Translators: notification title when a node stops being Ready.
        // %s is the node name as the cluster spells it; do not translate it.
        fireTitle: format(_('%s is down'), name),
        fireBody: '',
        // Translators: notification title when a node becomes Ready again.
        // %s is the node's name.
        resolveTitle: format(_('%s recovered'), name),
        resolveBody: '',
    });
}

/**
 * @typedef {object} GroupedNotification
 * @property {'fire' | 'resolve'} kind
 * @property {string} title
 * @property {string} body
 * @property {'high' | 'normal'} urgency
 */

/**
 * Coalesce a batch of actions into at most two banners, one for fires and one
 * for resolves, the way Alertmanager groups a receiver's alerts. Fires are high,
 * not critical: critical banners never auto-hide, so a monitoring alert would
 * squat on the screen long after its outage ended.
 * @param {AlertAction[]} actions
 * @returns {GroupedNotification[]}
 */
export function groupActions(actions) {
    /** @type {GroupedNotification[]} */
    const out = [];
    const fires = actions.filter(a => a.type === 'fire');
    const resolves = actions.filter(a => a.type === 'resolve');
    if (fires.length)
        out.push(coalesce(fires, 'fire', 'high'));
    if (resolves.length)
        out.push(coalesce(resolves, 'resolve', 'normal'));
    return out;
}

/**
 * @param {AlertAction[]} list  non-empty, all the same type
 * @param {'fire' | 'resolve'} type
 * @param {'high' | 'normal'} urgency
 * @returns {GroupedNotification}
 */
function coalesce(list, type, urgency) {
    if (list.length === 1)
        return {kind: type, title: list[0].title, body: list[0].body, urgency};
    const n = list.length;
    const title = type === 'fire'
        // Translators: banner title when several alerts fire at the same time.
        // %d is how many; the body lists the node names.
        ? format(ngettext('%d alert firing', '%d alerts firing', n), n)
        // Translators: banner title when several alerts clear at the same time.
        // %d is how many; the body lists the node names.
        : format(ngettext('%d alert recovered', '%d alerts recovered', n), n);
    return {kind: type, title, body: list.map(a => a.label).join(', '), urgency};
}

/**
 * Un-mark the notify-log for actions never delivered, so the next observation
 * notifies again. Teardown needs it: disable() must not post banners, so the
 * group-wait buffer is rolled back. Only fires apply; a resolve drops its record.
 * @param {AlertState | null} state
 * @param {AlertAction[]} undelivered
 * @returns {AlertState | null}  a new state, or the same one when nothing changed
 */
export function rollbackDelivery(state, undelivered) {
    if (!state || !undelivered.length)
        return state;
    /** @type {Record<string, AlertRecord>} */
    const alerts = {...state.alerts};
    let changed = false;
    for (const action of undelivered) {
        const rec = alerts[action.key];
        if (action.type !== 'fire' || !rec || rec.lastStatus !== 'firing')
            continue;
        // since stays (the outage did start then); resetting only the delivery
        // bookkeeping is what makes the next tick re-notify.
        alerts[action.key] = {...rec, lastStatus: 'resolved', lastNotifiedAt: 0};
        changed = true;
    }
    return changed ? {...state, alerts} : state;
}

/**
 * Order-independent fingerprint of the alert records, so a reordered node list
 * doesn't read as a change.
 * @param {Record<string, AlertRecord>} alerts
 * @returns {string}
 */
function alertsFingerprint(alerts) {
    return Object.keys(alerts).sort().map(k => {
        const r = alerts[k];
        return `${k}:${r.phase}:${r.since}:${r.lastNotifiedAt}:${r.lastStatus}:${r.resolveSince}`;
    }).join('|');
}

/**
 * Does next need writing to storage, given what was last persisted?
 *
 * lastObservedAt advances on every observation, so comparing whole states would
 * rewrite dconf thousands of times a day. Only the records must be durable; the
 * stamp may drift by stampToleranceMs, and may go stale while no alert is tracked
 * (a stale stamp only makes the next gap look bigger, erring toward settling).
 * @param {AlertState | null} persisted
 * @param {AlertState | null} next
 * @param {number} stampToleranceMs
 * @returns {boolean}
 */
export function needsPersist(persisted, next, stampToleranceMs) {
    if (!next)
        return persisted !== null;
    if (!persisted)
        return Object.keys(next.alerts).length > 0;
    if (persisted.v !== next.v || persisted.context !== next.context)
        return true;
    if (alertsFingerprint(persisted.alerts) !== alertsFingerprint(next.alerts))
        return true;
    if (Object.keys(next.alerts).length === 0)
        return false;
    return Math.abs(next.lastObservedAt - persisted.lastObservedAt) >= stampToleranceMs;
}

/**
 * @param {AlertState} state
 * @returns {string}
 */
export function serializeState(state) {
    return JSON.stringify(state);
}

/**
 * @param {string} json
 * @returns {AlertState | null}  null on empty, corrupt, or version-mismatched input
 */
export function deserializeState(json) {
    if (!json)
        return null;
    try {
        const o = JSON.parse(json);
        if (!o || o.v !== STATE_VERSION || typeof o.context !== 'string' ||
            !isFiniteNumber(o.lastObservedAt) ||
            typeof o.alerts !== 'object' || o.alerts === null)
            return null;
        // Validate every record: this blob lives in dconf, which has no per-key
        // ACL, so any same-UID process can rewrite it. An unknown phase would fall
        // through to the firing branch, and a NaN timestamp would never resolve.
        /** @type {Record<string, AlertRecord>} */
        const alerts = {};
        for (const [key, rec] of Object.entries(o.alerts)) {
            if (isValidRecord(rec) && (key === CLUSTER_KEY || key.startsWith(NODE_PREFIX)))
                alerts[key] = /** @type {AlertRecord} */ (rec);
        }
        return {v: STATE_VERSION, context: o.context, lastObservedAt: o.lastObservedAt, alerts};
    } catch {
        return null;
    }
}

/** @param {unknown} n @returns {boolean} */
function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

/** @param {unknown} rec @returns {boolean} */
function isValidRecord(rec) {
    if (!rec || typeof rec !== 'object')
        return false;
    const r = /** @type {any} */ (rec);
    return (r.phase === 'pending' || r.phase === 'firing') &&
        isFiniteNumber(r.since) && isFiniteNumber(r.lastNotifiedAt) &&
        isFiniteNumber(r.resolveSince) &&
        (r.lastStatus === 'firing' || r.lastStatus === 'resolved');
}
