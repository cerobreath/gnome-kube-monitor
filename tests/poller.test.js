// Tests for the poll loop. The fake GLib clock only moves when a test says so,
// so cadence, backoff, the watchdog and the teardown guards are all assertable.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {KubePoller} from '../lib/poller.js';

const HEALTH_OUT = 'n1\tfalse\tReady=True,\nn2\tfalse\tReady=False,\n';
const DETAIL_OUT = JSON.stringify({
    items: [{metadata: {name: 'n1', creationTimestamp: '2026-01-01T00:00:00Z'},
        status: {conditions: [{type: 'Ready', status: 'True'}], capacity: {cpu: '2', memory: '1Ki'}},
        spec: {}}],
});

/**
 * Answer a kubectl invocation the way a healthy cluster would.
 * @param {string[]} argv
 */
function answerFor(argv) {
    if (argv.includes('--raw'))
        return {stdout: JSON.stringify({items: []})};          // metrics
    if (argv.includes('pods'))
        return {stdout: 'Running|\n'};
    if (argv.includes('nodes') && argv.includes('json'))
        return {stdout: DETAIL_OUT};                           // detail tier
    if (argv.includes('nodes'))
        return {stdout: HEALTH_OUT};                           // health tier
    return {stdout: ''};
}

/**
 * A poller wired to recording callbacks and a default spawn handler.
 * @param {object} [over]
 */
function harness(over = {}) {
    Gio.__reset();
    GLib.__reset();
    /** @type {any[]} */
    const states = [];
    /** @type {any[]} */
    const observations = [];
    let menuOpen = false;

    // Match exact argv elements: -o jsonpath=… contains the substring "-o json",
    // so a loose check would answer the pods query with node JSON.
    Gio.__setSpawn(({argv}) => answerFor(argv));

    const poller = new KubePoller({
        getOpts: () => ({kubectlPath: '', kubeconfig: '', context: ''}),
        getIntervalSec: () => 10,
        getContextLabel: () => 'ctx',
        onState: s => states.push(s),
        onObservation: o => observations.push(o),
        ...over,
    });
    return {
        poller, states, observations,
        setMenuOpen: (/** @type {boolean} */ v) => {
            menuOpen = v;
            poller.setMenuOpen(v);
        },
        get menuOpen() {
            return menuOpen;
        },
    };
}

/** Let the in-flight promise chain finish without moving the clock. */
const settle = () => GLib.__settle();

test('start polls immediately, then self-schedules at the base interval', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.equal(h.states.length, 1, 'one poll on start');
    assert.equal(h.observations.length, 1);
    assert.equal(h.observations[0].offline, false, 'a success is by definition not offline');

    await GLib.__advance(9_000);
    assert.equal(h.states.length, 1, 'nothing before the interval elapses');
    await GLib.__advance(1_500);
    assert.equal(h.states.length, 2, 'and one more after it');
    h.poller.stop();
});

test('menu closed uses the cheap health tier; opening it pulls detail at once', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.equal(h.states[0].tier, 'health');
    assert.equal(Gio.__calls().length, 1, 'health tier is a single spawn');

    h.poller.setMenuOpen(true);          // must not wait for the next tick
    await settle();
    await GLib.__advance(50);
    await settle();
    const detail = h.states.find(s => s.tier === 'detail');
    assert.ok(detail, 'opening the menu triggers a detail poll');
    assert.ok(Gio.__calls().length >= 4, 'detail tier fans out to nodes+metrics+pods');
    h.poller.stop();
});

test('setMenuOpen is idempotent and does not re-poll on a repeat', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    h.poller.setMenuOpen(true);
    await settle();
    await GLib.__advance(50);
    await settle();
    const before = h.states.length;
    h.poller.setMenuOpen(true);          // same value
    await settle();
    assert.equal(h.states.length, before);
    h.poller.stop();
});

test('metrics and pods are best-effort: their failure never blanks the menu', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('--raw') || argv.includes('pods'))
            return {stdout: '', stderr: 'Forbidden', ok: false};
        return answerFor(argv);
    });
    h.poller.setMenuOpen(true);
    h.poller.start();
    await settle();
    await GLib.__advance(50);
    await settle();
    const detail = h.states.find(s => s.tier === 'detail');
    assert.ok(detail);
    assert.equal(detail.error, null, 'a metrics/pods failure is not an error state');
    assert.equal(detail.total, 1);
    assert.equal(detail.pods, null);
    h.poller.stop();
});

test('a failing poll reports a classified error and an unreachable observation', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({
        stdout: '', ok: false,
        stderr: 'The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?',
    }));
    h.poller.start();
    await settle();

    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].level, 'error');
    assert.equal(h.states[0].error.title, "Can't reach the cluster");
    assert.equal(h.observations.length, 1);
    assert.equal(h.observations[0].reachable, false, 'the alert machine must see the outage');
    assert.equal(h.observations[0].nodes.length, 0);
    h.poller.stop();
});

test('consecutive failures back off, and a success resets the cadence', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false}));
    h.poller.start();
    await settle();
    assert.equal(h.states.length, 1);

    // backoffDelaySec = base * 2^min(failures, 6), so one failure already means
    // 10s * 2 = 20s: nothing at 10.5s, the retry at 20.5s.
    await GLib.__advance(10_500);
    await settle();
    assert.equal(h.states.length, 1, 'the retry is already backed off to 20s');
    await GLib.__advance(10_500);
    await settle();
    assert.equal(h.states.length, 2);

    // Two failures -> 40s. Nothing at +20s, the retry at +40.5s.
    await GLib.__advance(20_000);
    await settle();
    assert.equal(h.states.length, 2, 'the delay grew again');
    await GLib.__advance(21_000);
    await settle();
    assert.equal(h.states.length, 3);

    // Recover: failures resets, so the next delay is the plain base interval.
    Gio.__setSpawn(({argv}) => answerFor(argv));
    await GLib.__advance(81_000);       // outlast the grown delay (3 failures -> 80s)
    await settle();
    const afterRecovery = h.states.length;
    assert.equal(h.states[afterRecovery - 1].error, null, 'the cluster is healthy again');
    await GLib.__advance(10_500);
    await settle();
    assert.equal(h.states.length, afterRecovery + 1, 'cadence is back to the base interval');
    h.poller.stop();
});

test('the watchdog rescues a hung kubectl and keeps the loop alive', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();
    assert.equal(h.states.length, 0, 'nothing delivered while it hangs');

    await GLib.__advance(12_500);       // POLL_TIMEOUT_SECONDS = 12
    await settle();
    assert.equal(h.states.length, 1, 'the watchdog delivered a timeout state');
    assert.equal(h.states[0].error.title, "The cluster didn't answer in time");
    assert.equal(h.observations[0].reachable, false);
    assert.equal(Gio.__killCount(), 1, 'the hung child was killed');

    // The loop continues; the timeout counted as a failure, so the retry is 20s.
    Gio.__setSpawn(({argv}) => answerFor(argv));
    await GLib.__advance(21_000);
    await settle();
    assert.ok(h.states.length >= 2, 'polling resumed after the timeout');
    assert.equal(h.states[h.states.length - 1].error, null);
    h.poller.stop();
});

test('polls never overlap: a tick during an in-flight poll is dropped', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();
    assert.equal(Gio.__calls().length, 1);

    h.poller.refreshNow();               // in-flight -> should not spawn a second now
    await settle();
    assert.equal(Gio.__calls().length, 1, 'no second spawn while one is in flight');
    h.poller.stop();
});

test('a poll finishing after stop() delivers nothing (no cross-cycle bleed)', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();

    h.poller.stop();                     // cancels the in-flight poll
    await settle();
    assert.equal(h.states.length, 0, 'no state after teardown');
    assert.equal(h.observations.length, 0,
        'crucially, no bogus unreachable observation into the next enable cycle');
});

test('a poll superseded by a context switch delivers nothing either', async () => {
    let context = '';
    const h = harness({getOpts: () => ({kubectlPath: '', kubeconfig: '', context})});
    // A plain Error, not a cancellation: the path that once reported a false outage.
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();

    context = 'other';                   // a real switch changes the options
    h.poller.refreshNow();               // marks the in-flight poll as superseded
    await settle();
    assert.equal(h.observations.length, 0, 'the abandoned poll must stay silent');

    // The replacement poll runs and does report.
    Gio.__setSpawn(() => ({stdout: HEALTH_OUT}));
    await GLib.__advance(50);
    await settle();
    assert.ok(h.observations.length >= 1);
    assert.equal(h.observations[h.observations.length - 1].reachable, true);
    h.poller.stop();
});

test('a refresh identical to the in-flight poll coalesces into it', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => ({...answerFor(argv), defer: true}));
    h.poller.start();
    await settle();
    assert.equal(Gio.__calls().length, 1);

    h.poller.refreshNow();               // same tier, same options
    await settle();
    assert.equal(Gio.__killCount(), 0, 'the in-flight kubectl is left to answer');

    Gio.__release();
    await settle();
    assert.equal(h.states.length, 1, 'and its result is delivered, not discarded');
    assert.equal(Gio.__calls().length, 1, 'no wasted respawn of an identical poll');
    h.poller.stop();
});

test('a forced refresh restarts even an identical in-flight poll', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();

    h.poller.refreshNow(true);           // the network flipped: that socket is dead
    await settle();
    assert.equal(Gio.__killCount(), 1, 'the doomed poll is put down at once');

    Gio.__setSpawn(({argv}) => answerFor(argv));
    await GLib.__advance(50);
    await settle();
    assert.equal(h.states.length, 1, 'the replacement poll delivered');
    assert.equal(h.states[0].error, null);
    h.poller.stop();
});

test('a failing poll while offline is classified and observed as offline', async () => {
    const h = harness({isOffline: () => true});
    Gio.__setSpawn(() => ({stdout: '', stderr: 'dial tcp: lookup api: no such host', ok: false}));
    h.poller.start();
    await settle();

    assert.equal(h.states[0].error.key, 'offline');
    assert.equal(h.states[0].error.title, 'No internet connection');
    assert.equal(h.observations[0].reachable, false);
    assert.equal(h.observations[0].offline, true,
        'the alert machine needs the flag to inhibit the cluster alert');
    h.poller.stop();
});

test('stop() then start() on one instance keeps polling (cancellable is renewed)', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.equal(h.observations.length, 1);

    h.poller.stop();
    await settle();
    h.poller.start();                    // a cancelled Cancellable never un-cancels
    await settle();
    assert.equal(h.observations.length, 2, 'the restart must actually poll');
    assert.equal(h.observations[1].reachable, true, 'and succeed, not fail as CANCELLED');
    h.poller.stop();
});

test('a SUCCESSFUL poll landing after stop() is discarded', async () => {
    // kubectl finished fine; only the delivery is late, so the cancellation check
    // cannot catch it. Release resolves, then stop() lands before the await.
    const h = harness();
    Gio.__setSpawn(({argv}) => ({...answerFor(argv), defer: true}));
    h.poller.start();
    await settle();
    assert.equal(Gio.__pendingSpawns(), 1);

    Gio.__release();                     // resolved, continuation still queued
    h.poller.stop();                     // ...and teardown wins the race
    await settle();
    assert.equal(h.states.length, 0, 'no state may reach the next cycle\'s indicator');
    assert.equal(h.observations.length, 0);
});

test('a FAILING poll landing after stop() reports no outage', async () => {
    // client.js rejects with a plain Error on non-zero exit, so err.matches() is
    // false and only the staleness guard stops a false "cluster unreachable".
    const h = harness();
    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false, defer: true}));
    h.poller.start();
    await settle();

    Gio.__release();
    h.poller.stop();
    await settle();
    assert.equal(h.observations.length, 0, 'teardown must never look like an outage');
    assert.equal(h.states.length, 0);
});

test('a poll landing after a context switch is discarded too', async () => {
    let context = '';
    const h = harness({getOpts: () => ({kubectlPath: '', kubeconfig: '', context})});
    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false, defer: true}));
    h.poller.start();
    await settle();

    Gio.__release();
    context = 'other';                   // a real switch changes the options
    h.poller.refreshNow();               // supersede it before it can deliver
    await settle();
    assert.equal(h.observations.length, 0, 'the superseded poll stays silent');
    h.poller.stop();
});

test('reentrancy: a second start() while a poll is in flight does not overlap it', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => ({...answerFor(argv), defer: true}));
    h.poller.start();
    await settle();
    assert.equal(Gio.__calls().length, 1);

    h.poller.start();                    // start() does not itself check _polling
    await settle();
    assert.equal(Gio.__calls().length, 1, '_tick must refuse to run concurrently');

    Gio.__release();
    await settle();
    assert.equal(h.states.length, 1, 'and only one result is delivered');
    h.poller.stop();
});

test('a tick that somehow fires after stop() does nothing (white-box guard check)', async () => {
    // Not reachable through the public API today, since stop() clears the timers.
    const h = harness();
    h.poller.stop();
    await h.poller._tick();
    await settle();
    assert.equal(Gio.__calls().length, 0);
    assert.equal(h.states.length, 0);
});

test('opening the menu mid-poll abandons the health poll and goes straight to detail', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => ({...answerFor(argv), defer: true}));
    h.poller.start();                    // health tier, in flight
    await settle();
    h.poller.setMenuOpen(true);          // cancels it and marks a refresh pending
    await settle();

    Gio.__release();                     // the abandoned health poll unwinds
    await settle();
    assert.ok(!h.states.some(s => s.tier === 'health'),
        'the cancelled health poll must not deliver');

    // The re-poll is queued with no delay and picks the detail tier.
    Gio.__setSpawn(({argv}) => answerFor(argv));
    await GLib.__advance(50);
    await settle();
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].tier, 'detail',
        'detail must follow at once rather than waiting for the next tick');
    h.poller.stop();
});

test('stop() is idempotent and leaves no timers armed', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    h.poller.stop();
    h.poller.stop();
    assert.equal(GLib.__pendingTimers(), 0, 'no orphaned GLib sources');
    await GLib.__advance(60_000);
    await settle();
    assert.equal(h.states.length, 1, 'a stopped poller stays stopped');
});

test('refreshNow on a stopped poller does nothing', async () => {
    const h = harness();
    h.poller.stop();
    h.poller.refreshNow();
    await settle();
    assert.equal(Gio.__calls().length, 0);
});

test('intervalChanged re-arms the timer without forcing a poll', async () => {
    let interval = 10;
    const h = harness({getIntervalSec: () => interval});
    h.poller.start();
    await settle();
    assert.equal(h.states.length, 1);

    interval = 2;
    h.poller.intervalChanged();
    await settle();
    assert.equal(h.states.length, 1, 'no immediate poll');
    await GLib.__advance(2_500);
    await settle();
    assert.equal(h.states.length, 2, 'the shorter interval took effect');
    h.poller.stop();
});

test('intervalChanged during an in-flight poll is ignored (the finally re-arms)', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();
    h.poller.intervalChanged();          // _polling -> early return
    await settle();
    assert.equal(Gio.__calls().length, 1);
    h.poller.stop();
});

test('a thrown non-Error is still classified rather than crashing the loop', async () => {
    // GJS can surface failures that are not Error instances, so err?.message ?? err
    // has to hold up: the loop must classify it and keep polling.
    const h = harness();
    Gio.__setSpawn(() => ({throws: 'plain string failure'}));
    h.poller.start();
    await settle();
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].level, 'error');
    assert.equal(h.states[0].error.detail, 'plain string failure');
    assert.equal(h.observations[0].reachable, false);
    h.poller.stop();
});

test('onState and onObservation really are optional', async () => {
    // The typedef marks both as optional, so a poller built without them must run
    // and fail cleanly rather than throwing inside the loop.
    Gio.__reset();
    GLib.__reset();
    Gio.__setSpawn(({argv}) => answerFor(argv));
    const bare = new KubePoller({
        getOpts: () => ({kubectlPath: '', kubeconfig: '', context: ''}),
        getIntervalSec: () => 10,
        getContextLabel: () => 'ctx',
    });

    bare.start();                        // success path with no callbacks
    await settle();
    assert.equal(Gio.__calls().length, 1);

    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false}));
    await GLib.__advance(10_500);        // error path with no callbacks
    await settle();
    assert.equal(Gio.__calls().length, 2);
    bare.stop();
});

test('the delivered state carries a monotonic stamp for the "updated N ago" label', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.equal(typeof h.states[0].monotonic, 'number');
    h.poller.stop();
});
