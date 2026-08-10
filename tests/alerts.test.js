// Tests for the pure alert state machine. An explicit nowMs clock drives every
// step, so the whole lifecycle is deterministic.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    reduce, groupActions, rollbackDelivery, needsPersist, serializeState, deserializeState,
    CLUSTER_KEY,
} from '../lib/alerts.js';

const CTX = 'ctx';
const T0 = 1_700_000_000_000;   // fixed wall-ms base
const SEC = 1000;

/** @param {object} [over] */
function cfg(over = {}) {
    return {
        nodeEnabled: true, clusterEnabled: true, resolveNotify: true,
        nodeForSec: 30, clusterForSec: 30, keepFiringForSec: 60,
        repeatIntervalSec: 0, intervalSec: 10, settleFactor: 3, silencedUntilMs: 0,
        ...over,
    };
}

/** @param {boolean} reachable @param {[string, boolean][]} nodeSpecs @param {object} [opts] */
function obs(reachable, nodeSpecs, opts = {}) {
    return {
        reachable,
        offline: opts.offline ?? false,
        context: opts.context ?? CTX,
        nodes: nodeSpecs.map(([name, ready]) => ({name, ready})),
        error: opts.error ?? null,
    };
}

/**
 * Drive steps through the reducer; each step's dt is milliseconds of wall clock.
 * @param {{dt?: number, obs: any, config?: any}[]} steps
 * @param {any} [start]
 */
function run(steps, start = null) {
    let state = start;
    let now = T0;
    const out = [];
    for (const s of steps) {
        now += s.dt ?? 0;
        const r = reduce(state, s.obs, s.config ?? cfg(), now);
        state = r.state;
        out.push(r.actions);
    }
    return {out, state, now};
}

const types = actions => actions.map(a => `${a.type}:${a.key}`);

test('for-debounce: a single NotReady poll pends, a sustained one fires after `for`', () => {
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', false]])},          // cold start -> silent baseline
        {dt: 10 * SEC, obs: obs(true, [['a', false]])},    // +10s: still pending (< 30s)
        {dt: 25 * SEC, obs: obs(true, [['a', false]])},    // +35s: fires
    ]);
    assert.deepEqual(out[0], []);
    assert.deepEqual(out[1], []);
    assert.deepEqual(types(out[2]), ['fire:NodeNotReady:a']);
    assert.equal(out[2][0].title, 'a is down');
});

test('for-debounce: a Ready poll within `for` resets it (no fire)', () => {
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', false]])},          // cold pending
        {dt: 10 * SEC, obs: obs(true, [['a', true]])},     // recovered before firing -> inactive
        {dt: 10 * SEC, obs: obs(true, [['a', false]])},    // NotReady again -> fresh pending
        {dt: 20 * SEC, obs: obs(true, [['a', false]])},    // only 20s into the new pending
    ]);
    assert.deepEqual(out.flat(), []);   // never fired
});

test('dedup: a still-down node does not re-notify; repeat_interval re-fires', () => {
    const c = cfg({repeatIntervalSec: 120});
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', false]]), config: c},
        {dt: 35 * SEC, obs: obs(true, [['a', false]]), config: c},   // fire
        {dt: 60 * SEC, obs: obs(true, [['a', false]]), config: c},   // +60s since fire: silent
        {dt: 70 * SEC, obs: obs(true, [['a', false]]), config: c},   // +130s since fire: re-fire
    ]);
    assert.deepEqual(types(out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(out[2], []);
    assert.deepEqual(types(out[3]), ['fire:NodeNotReady:a']);
});

test('repeat_interval 0 never re-fires a still-down node', () => {
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
        {dt: 999 * SEC, obs: obs(true, [['a', false]])},  // long later, still down
    ]);
    assert.deepEqual(types(out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(out[2], []);
});

test('keep_firing_for: resolve only after the hold; a flap back within it stays firing', () => {
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
        {dt: 10 * SEC, obs: obs(true, [['a', true]])},    // recovered, hold starts (60s)
        {dt: 20 * SEC, obs: obs(true, [['a', false]])},   // flap back down within hold -> stays firing, no re-fire
        {dt: 10 * SEC, obs: obs(true, [['a', true]])},    // recovered again, hold restarts
        {dt: 70 * SEC, obs: obs(true, [['a', true]])},    // past the hold -> resolve
    ]);
    assert.deepEqual(types(out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(out[2], []);
    assert.deepEqual(out[3], []);   // flap back: no re-fire
    assert.deepEqual(out[4], []);
    assert.deepEqual(types(out[5]), ['resolve:NodeNotReady:a']);
    assert.equal(out[5][0].title, 'a recovered');
});

test('resolveNotify off: clears the alert without a resolve banner', () => {
    const c = cfg({resolveNotify: false});
    const {out, state} = run([
        {dt: 0, obs: obs(true, [['a', false]]), config: c},
        {dt: 35 * SEC, obs: obs(true, [['a', false]]), config: c},   // fire
        {dt: 10 * SEC, obs: obs(true, [['a', true]]), config: c},
        {dt: 70 * SEC, obs: obs(true, [['a', true]]), config: c},    // past hold: cleared, no action
    ]);
    assert.deepEqual(types(out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(out[3], []);
    assert.equal(state.alerts['NodeNotReady:a'], undefined);   // no dangling firing record
});

test('cluster-unreachable: pends under `for`, fires once, resolves on reconnect', () => {
    const err = {title: "Can't reach the cluster", detail: 'connection refused'};
    const {out} = run([
        {dt: 0, obs: obs(false, [], {error: err})},        // cold -> pending
        {dt: 35 * SEC, obs: obs(false, [], {error: err})}, // fire
        {dt: 10 * SEC, obs: obs(true, [['a', true]])},     // reachable: hold starts
        {dt: 70 * SEC, obs: obs(true, [['a', true]])},     // past hold: resolve
    ]);
    assert.deepEqual(types(out[1]), [`fire:${CLUSTER_KEY}`]);
    assert.equal(out[1][0].title, "Can't reach the cluster");
    // The kubectl detail can carry credential material from an exec plugin, and
    // GNOME shows notification bodies on the lock screen, so it stays in the menu.
    assert.equal(out[1][0].body, '');
    assert.deepEqual(out[2], []);
    assert.deepEqual(types(out[3]), [`resolve:${CLUSTER_KEY}`]);
});

test('cluster: a one-poll reachable blip is absorbed by keep_firing_for', () => {
    const err = {title: "Can't reach the cluster", detail: ''};
    const {out} = run([
        {dt: 0, obs: obs(false, [], {error: err})},
        {dt: 35 * SEC, obs: obs(false, [], {error: err})},   // fire
        {dt: 10 * SEC, obs: obs(true, [['a', true]])},       // blip reachable (hold starts)
        {dt: 10 * SEC, obs: obs(false, [], {error: err})},   // unreachable again within hold
    ]);
    assert.deepEqual(types(out[1]), [`fire:${CLUSTER_KEY}`]);
    assert.deepEqual(out[2], []);
    assert.deepEqual(out[3], []);   // no resolve, no re-fire
});

test('inhibition: an unreachable poll freezes node records instead of resolving them', () => {
    const err = {title: "Can't reach the cluster", detail: ''};
    const {out, state} = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},      // node a fires
        {dt: 10 * SEC, obs: obs(false, [], {error: err})},   // unreachable: a must NOT resolve
    ]);
    assert.deepEqual(types(out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(out[2], []);                            // no resolve for a
    assert.equal(state.alerts['NodeNotReady:a'].phase, 'firing');   // frozen
});

test('recovery edge: reconnect re-anchors a pending node (no instant fire) and never false-resolves', () => {
    const err = {title: "Can't reach the cluster", detail: ''};
    // Node b was mid-pending when the cluster went unreachable; node a stays Ready.
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', true], ['b', false]])},     // cold: b pending
        {dt: 20 * SEC, obs: obs(true, [['a', true], ['b', false]])}, // b 20s into `for`
        {dt: 30 * SEC, obs: obs(false, [], {error: err})},        // unreachable (b frozen)
        {dt: 20 * SEC, obs: obs(true, [['a', true], ['b', false]])}, // reconnect: b re-anchored
        {dt: 20 * SEC, obs: obs(true, [['a', true], ['b', false]])}, // only 20s since re-anchor
    ]);
    // a never alerted, so never resolves; b was re-anchored and has not fired yet.
    assert.deepEqual(out.flat(), []);
});

test('settle: a large gap syncs silently -- no re-fire of a still-down node, no stale resolve', () => {
    const bigGap = 20 * 60 * SEC;   // 20 min > 15 min settle window
    // Still down across the gap: preserved firing, no re-fire.
    const stillDown = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
        {dt: bigGap, obs: obs(true, [['a', false]])},     // settle: no action
    ]);
    assert.deepEqual(types(stillDown.out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(stillDown.out[2], []);
    assert.equal(stillDown.state.alerts['NodeNotReady:a'].phase, 'firing');

    // Recovered across the gap: silently cleared, no stale "recovered".
    const recovered = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
        {dt: bigGap, obs: obs(true, [['a', true]])},      // settle: silent clear
    ]);
    assert.deepEqual(recovered.out[2], []);
    assert.equal(recovered.state.alerts['NodeNotReady:a'], undefined);
});

test('settle re-anchors a still-pending node, carrying its notify-log forward', () => {
    const bigGap = 20 * 60 * SEC;
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);       // cold -> pending
    now += 10 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);        // still pending (<30s)
    assert.equal(s.state.alerts['NodeNotReady:a'].phase, 'pending');
    now += bigGap;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);        // settle while pending
    assert.deepEqual(s.actions, []);
    const rec = s.state.alerts['NodeNotReady:a'];
    assert.equal(rec.phase, 'pending');
    assert.equal(rec.since, now);                                     // timer re-anchored
    assert.equal(rec.lastStatus, 'resolved');                         // log carried forward
    // It still has to serve the full debounce from the new anchor.
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now + 10 * SEC);
    assert.deepEqual(s.actions, []);
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now + 35 * SEC);
    assert.deepEqual(types(s.actions), ['fire:NodeNotReady:a']);
});

test('settle: a backward wall-clock jump is treated as settle', () => {
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);            // cold pending
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);            // fire
    assert.deepEqual(types(s.actions), ['fire:NodeNotReady:a']);
    now -= 10 * 60 * SEC;                                                   // clock steps back 10 min
    s = reduce(s.state, obs(true, [['a', true]]), cfg(), now);             // settle -> silent
    assert.deepEqual(s.actions, []);
});

test('restart dedup: a persisted firing node does not re-notify on a quick relog', () => {
    const first = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
    ]);
    // Simulate shell restart: serialize -> deserialize -> resume shortly after.
    const persisted = serializeState(first.state);
    const loaded = deserializeState(persisted);
    assert.ok(loaded);
    assert.equal(loaded.alerts['NodeNotReady:a'].phase, 'firing');
    const resumed = reduce(loaded, obs(true, [['a', false]]), cfg(), first.now + 5 * SEC);
    assert.deepEqual(resumed.actions, []);   // still down, already told: no replay
});

test('deserializeState rejects empty, corrupt, and version-mismatched blobs', () => {
    assert.equal(deserializeState(''), null);
    assert.equal(deserializeState('not json'), null);
    assert.equal(deserializeState(JSON.stringify({v: 999, context: CTX, lastObservedAt: 0, alerts: {}})), null);
    assert.ok(deserializeState(JSON.stringify({v: 1, context: CTX, lastObservedAt: 0, alerts: {}})));
});

test('context switch is a cold start: alerts reset, silent baseline', () => {
    const {state, out} = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},                 // a firing in ctx
        {dt: 10 * SEC, obs: obs(true, [['a', false]], {context: 'other'})}, // switch: cold
    ]);
    assert.equal(state.context, 'other');
    assert.deepEqual(out[2], []);                              // no fire on the switch
    assert.equal(state.alerts['NodeNotReady:a'].phase, 'pending');   // re-baselined
});

test('batching: several nodes flipping at once yield several actions in one step', () => {
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', false], ['b', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false], ['b', false]])},   // both fire
    ]);
    assert.deepEqual(types(out[1]).sort(), ['fire:NodeNotReady:a', 'fire:NodeNotReady:b']);
});

test('toggle gating: disabled advances the lifecycle silently and never replays when re-enabled', () => {
    const off = cfg({nodeEnabled: false});
    const on = cfg({nodeEnabled: true});
    const {out, state} = run([
        {dt: 0, obs: obs(true, [['a', false]]), config: off},
        {dt: 35 * SEC, obs: obs(true, [['a', false]]), config: off},   // would fire, but disabled
        {dt: 10 * SEC, obs: obs(true, [['a', false]]), config: on},    // re-enabled, still down
    ]);
    assert.deepEqual(out.flat(), []);                          // never notified
    assert.equal(state.alerts['NodeNotReady:a'].phase, 'firing');   // lifecycle advanced
    assert.equal(state.alerts['NodeNotReady:a'].lastStatus, 'firing');
});

test('node GC: a node dropping out of the list while firing resolves then is forgotten', () => {
    const {out, state} = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // a fires
        {dt: 10 * SEC, obs: obs(true, [])},               // a gone: hold starts
        {dt: 70 * SEC, obs: obs(true, [])},               // past hold: resolve + drop
    ]);
    assert.deepEqual(types(out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(types(out[3]), ['resolve:NodeNotReady:a']);
    assert.equal(state.alerts['NodeNotReady:a'], undefined);
});

test('silence: a fire is withheld while muted and delivered once the silence expires', () => {
    const muteUntil = T0 + 100 * SEC;
    const c = cfg({silencedUntilMs: muteUntil});
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), c, now);            // cold pending
    assert.deepEqual(s.actions, []);
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), c, now);            // would fire, but muted
    assert.deepEqual(s.actions, []);
    assert.equal(s.state.alerts['NodeNotReady:a'].phase, 'firing');    // lifecycle still advanced
    now = muteUntil + 5 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), c, now);            // silence expired, still down
    assert.deepEqual(types(s.actions), ['fire:NodeNotReady:a']);
});

test('silence: a resolve is withheld while muted', () => {
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);        // fire (not muted)
    assert.deepEqual(types(s.actions), ['fire:NodeNotReady:a']);
    const c = cfg({silencedUntilMs: now + 1000 * SEC});
    now += 10 * SEC;
    s = reduce(s.state, obs(true, [['a', true]]), c, now);            // recovered, hold starts, muted
    now += 70 * SEC;
    s = reduce(s.state, obs(true, [['a', true]]), c, now);            // past hold but muted -> no resolve
    assert.deepEqual(s.actions, []);
});

test('needsPersist ignores the advancing stamp so a steady cluster does not churn storage', () => {
    const TOL = 300 * SEC;
    // Two ticks 10s apart with a firing node: identical records, stamp advanced.
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);   // fires
    const persisted = s.state;
    now += 10 * SEC;
    const next = reduce(persisted, obs(true, [['a', false]]), cfg(), now).state;
    assert.notEqual(next.lastObservedAt, persisted.lastObservedAt);   // stamp did move
    assert.equal(needsPersist(persisted, next, TOL), false);          // ...but no write

    // Once the stamp has drifted past the tolerance, refresh it.
    const drifted = {...next, lastObservedAt: persisted.lastObservedAt + TOL};
    assert.equal(needsPersist(persisted, drifted, TOL), true);
});

test('needsPersist writes whenever the records, context or version change', () => {
    const TOL = 300 * SEC;
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);
    const persisted = s.state;

    // A node recovering clears its record -> must be written.
    now += 100 * SEC;
    const cleared = reduce(persisted, obs(true, [['a', true]]), cfg(), now).state;
    assert.equal(needsPersist(persisted, cleared, TOL), true);
    assert.equal(needsPersist(persisted, {...persisted, context: 'other'}, TOL), true);
    assert.equal(needsPersist(persisted, {...persisted, v: 99}, TOL), true);
    // Record order must not matter.
    const two = reduce(null, obs(true, [['a', false], ['b', false]]), cfg(), T0).state;
    const reordered = {...two, alerts: Object.fromEntries(Object.entries(two.alerts).reverse())};
    assert.equal(needsPersist(two, reordered, TOL), false);
});

test('needsPersist skips storage entirely while there is nothing to remember', () => {
    const TOL = 300 * SEC;
    const healthy = reduce(null, obs(true, [['a', true]]), cfg(), T0).state;
    assert.deepEqual(healthy.alerts, {});
    assert.equal(needsPersist(null, healthy, TOL), false);      // healthy cold start: no write
    const later = reduce(healthy, obs(true, [['a', true]]), cfg(), T0 + 10 * SEC).state;
    assert.equal(needsPersist(healthy, later, TOL), false);     // still nothing on the books
    assert.equal(needsPersist(healthy, null, TOL), true);       // clearing a stored blob
    assert.equal(needsPersist(null, null, TOL), false);
});

test('the tracked-alert map is capped, keeping the cluster alert and firing nodes', () => {
    // 400 nodes all NotReady: more than the 200 cap.
    const many = Array.from({length: 400}, (_, i) => [`node-${String(i).padStart(3, '0')}`, false]);
    let now = T0;
    let s = reduce(null, obs(true, many), cfg(), now);          // cold -> all pending
    now += 35 * SEC;
    s = reduce(s.state, obs(true, many), cfg(), now);           // all fire
    const keys = Object.keys(s.state.alerts);
    assert.equal(keys.length, 200);                            // capped
    assert.ok(keys.every(k => s.state.alerts[k].phase === 'firing'));
    // Serialized state stays small enough for a settings key.
    assert.ok(serializeState(s.state).length < 40_000, serializeState(s.state).length);

    // The cluster alert is never the one shed.
    const err = {title: "Can't reach the cluster", detail: ''};
    let u = reduce(null, obs(false, [], {error: err}), cfg(), T0);
    u = reduce(u.state, obs(false, [], {error: err}), cfg(), T0 + 35 * SEC);
    assert.ok(u.state.alerts[CLUSTER_KEY]);
});

test('deserializeState drops records that do not typecheck', () => {
    const good = {phase: 'firing', since: 1, lastNotifiedAt: 1, resolveSince: 0, lastStatus: 'firing'};
    /** @param {object} alerts */
    const load = alerts => deserializeState(JSON.stringify(
        {v: 1, context: CTX, lastObservedAt: T0, alerts}));

    assert.deepEqual(Object.keys(load({'NodeNotReady:a': good}).alerts), ['NodeNotReady:a']);
    // Every invalid shape a crafted dconf value could take.
    assert.deepEqual(load({'NodeNotReady:a': {...good, phase: 'inactive'}}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': {...good, phase: 'bogus'}}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': {...good, since: NaN}}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': {...good, lastNotifiedAt: 'x'}}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': {...good, resolveSince: Infinity}}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': {...good, lastStatus: 'nope'}}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': null}).alerts, {});
    assert.deepEqual(load({'NodeNotReady:a': 'a string'}).alerts, {});
    // Keys outside the alert namespace are refused, so one cannot become a title.
    assert.deepEqual(load({'evil<b>key': good}).alerts, {});
    // A non-finite lastObservedAt invalidates the whole blob.
    assert.equal(deserializeState(JSON.stringify(
        {v: 1, context: CTX, lastObservedAt: NaN, alerts: {}})), null);
});

test('the alert cap keeps the cluster record regardless of sort order', () => {
    // Exercises both comparator arms: the cluster key reached as a and as b.
    const err = {title: "Can't reach the cluster", detail: ''};
    const many = Array.from({length: 250}, (_, i) => [`node-${String(i).padStart(3, '0')}`, false]);
    let now = T0;
    // Cluster alert fires first, then the cluster comes back with 250 bad nodes.
    let s = reduce(null, obs(false, [], {error: err}), cfg(), now);
    now += 35 * SEC;
    s = reduce(s.state, obs(false, [], {error: err}), cfg(), now);
    assert.ok(s.state.alerts[CLUSTER_KEY]);
    now += 5 * SEC;
    s = reduce(s.state, obs(true, many), cfg(), now);        // recovery edge: nodes pend
    now += 35 * SEC;
    s = reduce(s.state, obs(true, many), cfg(), now);        // nodes fire, cap applies
    const keys = Object.keys(s.state.alerts);
    assert.equal(keys.length, 200);
    assert.ok(keys.includes(CLUSTER_KEY), 'cluster record must never be the one shed');
});

test('groupActions coalesces simultaneous fires into one high-urgency banner', () => {
    const mk = (type, label, title) => ({type, key: label, label, title, body: ''});
    assert.deepEqual(groupActions([]), []);
    assert.deepEqual(groupActions([mk('fire', 'a', 'a is down')]),
        [{kind: 'fire', title: 'a is down', body: '', urgency: 'high'}]);
    const many = groupActions([
        mk('fire', 'a', 'a is down'), mk('fire', 'b', 'b is down'), mk('fire', 'cluster', "Can't reach the cluster"),
    ]);
    assert.deepEqual(many,
        [{kind: 'fire', title: '3 alerts firing', body: 'a, b, cluster', urgency: 'high'}]);
});

test('offline: an unreachable stretch while the machine is offline never fires', () => {
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', true]])},               // healthy baseline
        {dt: 10 * SEC, obs: obs(false, [], {offline: true})},  // the machine lost its network
        {dt: 60 * SEC, obs: obs(false, [], {offline: true})},  // far past clusterForSec by now
        {dt: 120 * SEC, obs: obs(false, [], {offline: true})},
    ]);
    assert.deepEqual(out.flat(), [], 'a local outage must not read as a cluster alert');
});

test('offline: a firing cluster alert survives the stretch and resolves once back', () => {
    const {out} = run([
        {dt: 0, obs: obs(false, [])},                          // cold start: pending
        {dt: 35 * SEC, obs: obs(false, [])},                    // real outage fires
        {dt: 10 * SEC, obs: obs(false, [], {offline: true})},   // then the machine drops offline
        {dt: 10 * SEC, obs: obs(true, [['a', true]])},          // back online, cluster answers
        {dt: 65 * SEC, obs: obs(true, [['a', true]])},          // keep_firing_for elapses
    ]);
    assert.deepEqual(types(out[1]), [`fire:${CLUSTER_KEY}`]);
    assert.deepEqual(out[2], [], 'offline neither re-fires nor resolves it');
    assert.deepEqual(types(out[4]), [`resolve:${CLUSTER_KEY}`],
        'the episode still closes with a recovery notice');
});

test('rollbackDelivery re-arms an undelivered fire so the next tick notifies again', () => {
    // Fire, but pretend teardown happened before the banner was dispatched.
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);
    assert.deepEqual(types(s.actions), ['fire:NodeNotReady:a']);

    const rolledBack = rollbackDelivery(s.state, s.actions);
    // The outage start is preserved; only the delivery bookkeeping is reset.
    assert.equal(rolledBack.alerts['NodeNotReady:a'].phase, 'firing');
    assert.equal(rolledBack.alerts['NodeNotReady:a'].since, s.state.alerts['NodeNotReady:a'].since);
    assert.equal(rolledBack.alerts['NodeNotReady:a'].lastStatus, 'resolved');

    // Next observation after re-enable: the user finally gets the banner.
    now += 5 * SEC;
    const resumed = reduce(rolledBack, obs(true, [['a', false]]), cfg(), now);
    assert.deepEqual(types(resumed.actions), ['fire:NodeNotReady:a']);
});

test('rollbackDelivery is a no-op for resolves, empty batches and null state', () => {
    assert.equal(rollbackDelivery(null, []), null);
    let now = T0;
    let s = reduce(null, obs(true, [['a', false]]), cfg(), now);
    now += 35 * SEC;
    s = reduce(s.state, obs(true, [['a', false]]), cfg(), now);
    assert.equal(rollbackDelivery(s.state, []), s.state);   // same object, nothing changed
    // A resolve has no record left to re-arm, so the state is untouched.
    const resolveAction = [{type: 'resolve', key: 'NodeNotReady:a', label: 'a', title: '', body: ''}];
    assert.equal(rollbackDelivery(s.state, resolveAction), s.state);
});

test('groupActions splits fires (high) and resolves (normal) into two banners', () => {
    const mk = (type, label, title) => ({type, key: label, label, title, body: ''});
    const out = groupActions([
        mk('fire', 'a', 'a is down'), mk('resolve', 'b', 'b recovered'), mk('resolve', 'c', 'c recovered'),
    ]);
    assert.deepEqual(out, [
        {kind: 'fire', title: 'a is down', body: '', urgency: 'high'},
        {kind: 'resolve', title: '2 alerts recovered', body: 'b, c', urgency: 'normal'},
    ]);
});
