// Alert state machine for node readiness and cluster reachability.
//
// Pure, zero gi:// imports: plain data in -> plain data out, wall-clock time
// injected as nowMs, so it runs unchanged under gnome-shell, gjs and node and
// carries the unit tests. The impure edges feed it observations (poller.js) and
// dispatch its actions to the notifier (extension.js).
//
// The model is the industry-standard alerting lifecycle, scoped to the two
// signals we actually collect (node Ready/NotReady + cluster reachability):
//
//   - Prometheus rule lifecycle: inactive -> pending -> firing, with a `for`
//     debounce and a `keep_firing_for` hold that rides out flaps and one-poll
//     false resolves.
//   - Alertmanager notification log: notify only on a status-change edge (or
//     when repeat_interval elapses), and persist the log so a restart neither
//     replays nor forgets.
//   - A settle guard for cold start / suspend-resume / long screen-lock, plus a
//     ClusterUnreachable alert that inhibits per-node alerts.
//
// Flap detection (Nagios-style) is intentionally not implemented here (deferred).

/**
 * @typedef {'inactive' | 'pending' | 'firing'} AlertPhase
 */

/**
 * One alert's lifecycle record. Only pending/firing records are persisted;
 * inactive/resolved records are dropped, so the map stays bounded by the number
 * of currently-degraded alerts.
 * @typedef {object} AlertRecord
 * @property {AlertPhase} phase
 * @property {number} since           wall-ms the current phase began
 * @property {number} lastNotifiedAt  wall-ms of the last notification (0 = never)
 * @property {'firing' | 'resolved'} lastStatus  the last NOTIFIED status (notify log)
 * @property {number} resolveSince    wall-ms the condition first went false while firing (0 = true now); drives keep_firing_for
 */

/**
 * The persisted blob. `context` scopes it to one cluster; a different context is
 * a cold start. `v` lets a future shape change discard old blobs.
 * @typedef {object} AlertState
 * @property {number} v
 * @property {string} context
 * @property {number} lastObservedAt  wall-ms of the last processed observation
 * @property {Record<string, AlertRecord>} alerts  keyed 'ClusterUnreachable' | 'NodeNotReady:<name>'
 */

/**
 * @typedef {object} AlertObservation
 * @property {boolean} reachable
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
// Must match MAX_BACKOFF_SECONDS in poller.js: during an outage the loop backs
// off to this cap, so the healthy-gap-to-settle threshold is keyed off it.
const MAX_BACKOFF_SECONDS = 300;
// Never treat a gap under this as a settle, even at tiny poll intervals.
const SETTLE_FLOOR_MS = 90_000;

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
 * A fresh pending record, carrying the notify-log fields forward from any prior
 * record so re-anchoring doesn't lose "we already told the user" history.
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
 * Advance one alert by one observation. Pure: never mutates `prev`.
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

    // Settle: sync to current truth silently. Preserve a known firing alert
    // (don't re-nag), re-anchor anything else that's still bad to pending, and
    // drop cleared alerts without a (stale) resolve banner.
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
            return {rec: {...prev}, action: null};   // still within `for`

        // Becoming or staying firing. wantNotify covers three cases: the
        // pending->firing edge, a firing episode we haven't managed to deliver
        // yet (e.g. it fired while silenced), and repeat_interval re-notification.
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
            // Mark the notify-log as delivered, then emit -- unless disabled,
            // which marks without a banner so re-enabling never replays.
            rec.lastNotifiedAt = nowMs;
            rec.lastStatus = 'firing';
            return {rec, action: enabled ? action('fire') : null};
        }
        // Silenced (or nothing to notify): leave the log untouched so a still-
        // firing alert delivers once the silence expires (Alertmanager semantics).
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
 * Fold one observation into the alert state. Never mutates `prevState`.
 *
 * Ordering matters: the cluster alert is evaluated first because an unreachable
 * cluster inhibits per-node alerts (we have no node data, so node records are
 * frozen, not resolved). The first reachable observation after an outage
 * re-anchors pending node timers so the outage gap can't instant-fire them.
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

    // Settle on a cold start, a large gap (suspend / long lock / reboot after a
    // while), or a backward wall-clock jump.
    let settle = base === null;
    if (base) {
        const gap = nowMs - base.lastObservedAt;
        if (gap < 0 || gap > settleGapMs(config))
            settle = true;
    }

    /** @type {Record<string, AlertRecord>} */
    const alerts = {};

    // --- ClusterUnreachable (always evaluated) ---
    {
        const prev = prevAlerts[CLUSTER_KEY];
        const {rec, action} = stepAlert(prev, !observation.reachable, nowMs, {
            forSec: config.clusterForSec,
            keepFiringForSec: config.keepFiringForSec,
            repeatIntervalSec: config.repeatIntervalSec,
            enabled: config.clusterEnabled,
            resolveNotify: config.resolveNotify,
            settle,
            silencedUntilMs: config.silencedUntilMs,
            key: CLUSTER_KEY,
            label: 'cluster',
            fireTitle: observation.error?.title ?? "Can't reach the cluster",
            fireBody: observation.error?.detail ?? '',
            resolveTitle: 'Cluster reachable again',
            resolveBody: '',
        });
        if (rec)
            alerts[CLUSTER_KEY] = rec;
        if (action)
            actions.push(action);
    }

    // --- Per-node alerts ---
    if (observation.reachable) {
        // recovering = this is the first reachable tick after an unreachable
        // one, so re-anchor pending node timers (the outage gap is not "NotReady"
        // evidence and would otherwise instant-fire them). A prior cluster record
        // with resolveSince===0 means last tick the cluster was still unreachable;
        // once we're in the keep_firing_for hold (resolveSince>0) it's no longer
        // the recovery edge.
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
        // Unreachable: freeze node records unchanged (inhibited by the cluster
        // alert). Wall-clock `since` survives the freeze, and pending timers are
        // re-anchored on the recovery edge above.
        for (const [key, prev] of Object.entries(prevAlerts)) {
            if (key !== CLUSTER_KEY)
                alerts[key] = prev;
        }
    }

    return {
        state: {v: STATE_VERSION, context: observation.context, lastObservedAt: nowMs, alerts},
        actions,
    };
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
        fireTitle: `${name} is down`,
        fireBody: '',
        resolveTitle: `${name} recovered`,
        resolveBody: '',
    });
}

/**
 * @typedef {object} GroupedNotification
 * @property {string} title
 * @property {string} body
 * @property {'critical' | 'normal'} urgency
 */

/**
 * Coalesce a batch of actions into at most two banners -- one for fires
 * (critical) and one for resolves (normal) -- the way Alertmanager groups a
 * receiver's alerts so simultaneous flips don't become a wall of banners.
 * Urgency is derived from the action type. Pure, so the wording is tested.
 * @param {AlertAction[]} actions
 * @returns {GroupedNotification[]}
 */
export function groupActions(actions) {
    /** @type {GroupedNotification[]} */
    const out = [];
    const fires = actions.filter(a => a.type === 'fire');
    const resolves = actions.filter(a => a.type === 'resolve');
    if (fires.length)
        out.push(coalesce(fires, 'critical', 'firing'));
    if (resolves.length)
        out.push(coalesce(resolves, 'normal', 'recovered'));
    return out;
}

/**
 * @param {AlertAction[]} list  non-empty, all the same type
 * @param {'critical' | 'normal'} urgency
 * @param {string} plural  word for the multi-item header ("firing" | "recovered")
 * @returns {GroupedNotification}
 */
function coalesce(list, urgency, plural) {
    if (list.length === 1)
        return {title: list[0].title, body: list[0].body, urgency};
    return {title: `${list.length} ${plural}`, body: list.map(a => a.label).join(', '), urgency};
}

/**
 * Un-mark the notify-log for actions that were never delivered, so the next
 * observation notifies again instead of assuming the user saw them.
 *
 * This is what teardown uses: `disable()` must not post banners (the tray
 * source is being destroyed, and allocating one there is an EGO anti-pattern),
 * so anything still sitting in the group-wait buffer is rolled back rather than
 * dropped. Only fires need it -- a resolve drops its record entirely, so there
 * is nothing left to re-notify and a missed "recovered" is harmless.
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
        // Keep `since` (the outage really did start then); only the delivery
        // bookkeeping is reset, which is what makes the next tick re-notify.
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
 * Does `next` need writing to storage, given what was last persisted?
 *
 * `lastObservedAt` advances on every observation, so comparing whole serialized
 * states would rewrite the store on every single poll (thousands of dconf writes
 * a day at the default interval). The alert *records* are what must be durable;
 * the observation stamp only has to be fresh enough for the settle window to
 * spot a real gap, so it may drift by `stampToleranceMs` before forcing a write.
 * With no alerts on the books nothing's age matters, so the stamp is allowed to
 * go stale indefinitely -- a stale stamp only ever makes the next gap look
 * bigger, which errs toward settling silently.
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
            typeof o.lastObservedAt !== 'number' || typeof o.alerts !== 'object' || o.alerts === null)
            return null;
        return /** @type {AlertState} */ (o);
    } catch {
        return null;
    }
}
