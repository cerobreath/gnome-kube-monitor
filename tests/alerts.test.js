// Unit tests for the pure alert state machine. Run with `npm test` (node --test)
// -- no deps, no gnome-shell. A fake, explicit clock (nowMs) drives every step,
// so the whole lifecycle is deterministic.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {reduce, groupActions, serializeState, deserializeState, CLUSTER_KEY} from '../lib/alerts.js';

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
        context: opts.context ?? CTX,
        nodes: nodeSpecs.map(([name, ready]) => ({name, ready})),
        error: opts.error ?? null,
    };
}

/**
 * Drive a sequence of steps through the reducer, threading state + wall clock.
 * Each step: {dt, obs, config?}. dt is ms added to the clock before the reduce.
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
    // Fire, recover, flap back down before keep_firing_for, then recover for good.
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
    assert.equal(out[1][0].body, 'connection refused');
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
    // node b was mid-pending when the cluster went unreachable; node a is Ready throughout.
    const {out} = run([
        {dt: 0, obs: obs(true, [['a', true], ['b', false]])},     // cold: b pending
        {dt: 20 * SEC, obs: obs(true, [['a', true], ['b', false]])}, // b 20s into `for`
        {dt: 30 * SEC, obs: obs(false, [], {error: err})},        // unreachable (b frozen)
        {dt: 20 * SEC, obs: obs(true, [['a', true], ['b', false]])}, // reconnect: b re-anchored
        {dt: 20 * SEC, obs: obs(true, [['a', true], ['b', false]])}, // only 20s since re-anchor
    ]);
    // a never alerted (always Ready) -> never a resolve; b re-anchored so it hasn't fired yet.
    assert.deepEqual(out.flat(), []);
});

test('settle: a large gap syncs silently -- no re-fire of a still-down node, no stale resolve', () => {
    const bigGap = 20 * 60 * SEC;   // 20 min > 15 min settle window
    // still-down across the gap: preserved firing, no re-fire.
    const stillDown = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
        {dt: bigGap, obs: obs(true, [['a', false]])},     // settle: no action
    ]);
    assert.deepEqual(types(stillDown.out[1]), ['fire:NodeNotReady:a']);
    assert.deepEqual(stillDown.out[2], []);
    assert.equal(stillDown.state.alerts['NodeNotReady:a'].phase, 'firing');

    // recovered across the gap: silently cleared, no stale "recovered".
    const recovered = run([
        {dt: 0, obs: obs(true, [['a', false]])},
        {dt: 35 * SEC, obs: obs(true, [['a', false]])},   // fire
        {dt: bigGap, obs: obs(true, [['a', true]])},      // settle: silent clear
    ]);
    assert.deepEqual(recovered.out[2], []);
    assert.equal(recovered.state.alerts['NodeNotReady:a'], undefined);
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

test('groupActions coalesces simultaneous fires into one critical banner', () => {
    const mk = (type, label, title) => ({type, key: label, label, title, body: ''});
    assert.deepEqual(groupActions([]), []);
    assert.deepEqual(groupActions([mk('fire', 'a', 'a is down')]),
        [{title: 'a is down', body: '', urgency: 'critical'}]);
    const many = groupActions([
        mk('fire', 'a', 'a is down'), mk('fire', 'b', 'b is down'), mk('fire', 'cluster', "Can't reach the cluster"),
    ]);
    assert.deepEqual(many, [{title: '3 firing', body: 'a, b, cluster', urgency: 'critical'}]);
});

test('groupActions splits fires (critical) and resolves (normal) into two banners', () => {
    const mk = (type, label, title) => ({type, key: label, label, title, body: ''});
    const out = groupActions([
        mk('fire', 'a', 'a is down'), mk('resolve', 'b', 'b recovered'), mk('resolve', 'c', 'c recovered'),
    ]);
    assert.deepEqual(out, [
        {title: 'a is down', body: '', urgency: 'critical'},
        {title: '2 recovered', body: 'b, c', urgency: 'normal'},
    ]);
});
