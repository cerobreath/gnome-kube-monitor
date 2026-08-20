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
    if (argv.includes('--watch'))
        return {stream: true};             // stays open; watch tests drive it
    if (argv.includes('--raw'))
        return {stdout: JSON.stringify({items: []})};          // metrics
    if (argv.includes('pods'))
        return {stdout: 'Running|\n'};
    if (argv.includes('nodes') && argv.includes('json'))
        return {stdout: DETAIL_OUT};                           // detail tier
    if (argv.includes('nodes') && argv.includes('--no-headers'))
        return {stdout: 'n1   Ready   <none>   1d   v1.35\nn2   NotReady   <none>   1d   v1.35\n'};
    if (argv.includes('nodes'))
        return {stdout: HEALTH_OUT};                           // health tier
    return {stdout: ''};
}

// kubectl polls only: the health watch spawned by start() is asserted separately.
const pollCalls = () => Gio.__calls().filter(c => !c.argv.includes('--watch'));

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
    assert.equal(h.states[0].failures, 0);
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
    assert.equal(pollCalls().length, 1, 'health tier is a single spawn');

    h.poller.setMenuOpen(true);          // must not wait for the next tick
    await settle();
    await GLib.__advance(50);
    await settle();
    const detail = h.states.find(s => s.tier === 'detail');
    assert.ok(detail, 'opening the menu triggers a detail poll');
    assert.ok(pollCalls().length >= 4, 'detail tier fans out to nodes+metrics+pods');
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
    assert.equal(h.states[0].failures, 1, 'the view needs the count to soften a first blip');
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
    assert.equal(pollCalls().length, 1);

    h.poller.refreshNow();               // in-flight -> should not spawn a second now
    await settle();
    assert.equal(pollCalls().length, 1, 'no second spawn while one is in flight');
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
    assert.equal(pollCalls().length, 1);

    h.poller.refreshNow();               // same tier, same options
    await settle();
    assert.equal(Gio.__killCount(), 0, 'the in-flight kubectl is left to answer');

    Gio.__release();
    await settle();
    assert.equal(h.states.length, 1, 'and its result is delivered, not discarded');
    assert.equal(pollCalls().length, 1, 'no wasted respawn of an identical poll');
    h.poller.stop();
});

test('a forced refresh restarts even an identical in-flight poll', async () => {
    const h = harness();
    Gio.__setSpawn(() => ({hang: true}));
    h.poller.start();
    await settle();

    h.poller.refreshNow(true);           // the network flipped: that socket is dead
    await settle();
    assert.equal(Gio.__killCount(), 2, 'the doomed poll and the stale watch are put down at once');

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
    assert.equal(pollCalls().length, 1);

    h.poller.start();                    // start() does not itself check _polling
    await settle();
    assert.equal(pollCalls().length, 1, '_tick must refuse to run concurrently');

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
    assert.equal(pollCalls().length, 1);
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
    assert.equal(pollCalls().length, 1);

    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false}));
    await GLib.__advance(10_500);        // error path with no callbacks
    await settle();
    assert.equal(pollCalls().length, 2);
    bare.stop();
});

test('the delivered state carries a monotonic stamp for the "updated N ago" label', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.equal(typeof h.states[0].monotonic, 'number');
    h.poller.stop();
});

// The watch tier

/** The watch child spawned at start(); answerFor scripts it as a silent stream. */
const watchProc = () => Gio.__lastStreamProc();

/** Feed the initial ADDED burst and let the coalescing window flush it. */
async function activateWatch(lines = ['ADDED|n1||Ready|True', 'ADDED|n2||Ready|True']) {
    const proc = watchProc();
    for (const line of lines)
        proc.__pushLine(line);
    await settle();
    await GLib.__advance(300);           // WATCH_QUIET_MS elapses, snapshot flushes
    await settle();
    return proc;
}

test('the initial burst coalesces into one complete snapshot', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.equal(h.states.length, 1, 'the bridging poll delivered first');

    const proc = watchProc();
    proc.__pushLine('ADDED|n1||Ready|True');
    await settle();
    assert.equal(h.states.length, 1, 'a half-listed cluster is never delivered');
    proc.__pushLine('ADDED|n2||Ready|False');
    await settle();
    await GLib.__advance(300);
    await settle();

    assert.equal(h.states.length, 2, 'exactly one snapshot for the whole burst');
    const snap = h.states[1];
    assert.equal(snap.tier, 'health');
    assert.equal(snap.total, 2);
    assert.equal(snap.readyCount, 1);
    assert.deepEqual(h.observations[h.observations.length - 1].nodes.map(n => n.name),
        ['n1', 'n2']);
    h.poller.stop();
});

test('an active watch suspends health polling and events keep the state fresh', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();
    const polls = pollCalls().length;

    await GLib.__advance(60_000);        // six base intervals
    await settle();
    assert.equal(pollCalls().length, polls, 'no health polls while the watch is active');

    proc.__pushLine('MODIFIED|n2||Ready|False');
    await settle();
    await GLib.__advance(300);
    await settle();
    const last = h.states[h.states.length - 1];
    assert.equal(last.readyCount, 1, 'the event reshaped the delivered state');
    assert.equal(last.level, 'error');
    assert.equal(pollCalls().length, polls, 'still without a single poll');
    h.poller.stop();
});

test('a DELETED event removes the node from the snapshot', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();

    proc.__pushLine('DELETED|n2||Ready|True');
    await settle();
    await GLib.__advance(300);
    await settle();
    const last = h.states[h.states.length - 1];
    assert.equal(last.total, 1);
    assert.deepEqual(last.nodes.map(n => n.name), ['n1']);
    h.poller.stop();
});

test('a busy stream still snapshots at the coalescing ceiling', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = watchProc();

    // An event every 100ms keeps the quiet window from ever expiring.
    for (let i = 0; i < 16; i++) {
        proc.__pushLine(`MODIFIED|churner||Ready|${i % 2 ? 'True' : 'False'}`);
        await settle();
        await GLib.__advance(100);
    }
    await settle();
    // Only a watch snapshot can carry this node; the bridging poll cannot.
    const snapshots = h.states.filter(s => s.nodes.some(n => n.name === 'churner'));
    assert.ok(snapshots.length >= 1, 'the 1500ms ceiling forced a flush mid-churn');
    h.poller.stop();
});

test('the heartbeat re-observes at the base interval without spawning kubectl', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();
    const calls = Gio.__calls().length;
    const observed = h.observations.length;

    await GLib.__advance(10_500);
    await settle();
    assert.equal(h.observations.length, observed + 1, 'one heartbeat observation');
    assert.equal(h.observations[h.observations.length - 1].reachable, true);
    assert.equal(Gio.__calls().length, calls, 'and not a single spawn for it');

    await GLib.__advance(10_000);
    await settle();
    assert.equal(h.observations.length, observed + 2, 'and it keeps its cadence');
    h.poller.stop();
});

test('a watch death after activation falls back to polling and respawns with backoff', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();
    const polls = pollCalls().length;
    const watches = Gio.__calls().length - polls;

    GLib.__setClock(GLib.__now() + 30_000);   // lifetime 30s < stable
    proc.__exit({ok: false});
    await settle();
    await GLib.__advance(50);
    await settle();
    assert.equal(pollCalls().length, polls + 1, 'an immediate poll re-establishes truth');

    await GLib.__advance(4_500);         // first quick death respawns after 4s
    await settle();
    assert.equal(Gio.__calls().length - pollCalls().length, watches + 1,
        'the watch respawned on the backoff schedule');
    h.poller.stop();
});

test('a stable watch death respawns at once, with no bridging poll', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();
    const polls = pollCalls().length;
    const watches = Gio.__calls().length - polls;

    GLib.__setClock(GLib.__now() + 1_800_000);   // the server closed it after 30min
    proc.__exit({ok: true});
    await settle();
    assert.equal(Gio.__calls().length - pollCalls().length, watches + 1,
        'respawned immediately');
    assert.equal(pollCalls().length, polls, 'without waking the poll loop');

    // The fresh stream re-lists and re-activates.
    await activateWatch();
    await GLib.__advance(30_000);
    await settle();
    assert.equal(pollCalls().length, polls, 'polling stays suspended');
    h.poller.stop();
});

test('three quick deaths park the watch and polling carries the load', async () => {
    const h = harness();
    h.poller.start();
    await settle();

    // The initial watch never activates; kill it thrice through the backoff.
    for (const delay of [4_500, 8_500]) {
        watchProc().__exit({ok: false});
        await settle();
        await GLib.__advance(delay);
        await settle();
    }
    watchProc().__exit({ok: false});     // third quick death -> parked for 300s
    await settle();
    const watches = Gio.__calls().length - pollCalls().length;

    await GLib.__advance(200_000);
    await settle();
    assert.equal(Gio.__calls().length - pollCalls().length, watches,
        'no watch attempt before the slow retry');
    assert.ok(pollCalls().length > 3, 'polling kept the data flowing meanwhile');

    await GLib.__advance(105_000);       // past the 300s retry
    await settle();
    assert.equal(Gio.__calls().length - pollCalls().length, watches + 1,
        'the slow retry finally re-attempted the watch');
    h.poller.stop();
});

test('the startup watchdog kills a watch that never produces a snapshot', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    assert.ok(watchProc(), 'a watch was spawned');

    await GLib.__advance(30_500);        // WATCH_STARTUP_SECONDS with no output
    await settle();
    assert.ok(Gio.__killCount() >= 1, 'the silent watch was put down');
    // It counted as a quick death, so a respawn is already scheduled.
    await GLib.__advance(4_500);
    await settle();
    assert.ok(Gio.__streamProcs().length >= 2, 'and the watch was re-attempted');
    h.poller.stop();
});

test('the reconcile cross-checks with a table poll and restarts the watch on drift', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();               // map: n1 Ready, n2 Ready
    const watchesBefore = Gio.__streamProcs().length;

    // answerFor's table says n1 Ready, n2 NotReady: that is drift.
    await GLib.__advance(300_500);       // RECONCILE_SECONDS
    await settle();
    const table = pollCalls().filter(c => c.argv.includes('--no-headers'));
    assert.equal(table.length, 1, 'one server-printed table poll');
    assert.equal(Gio.__streamProcs().length, watchesBefore + 1,
        'the stale watch was restarted');
    h.poller.stop();
});

test('a clean reconcile leaves the watch alone and re-arms itself', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('--no-headers'))
            return {stdout: 'n1   Ready   <none>   1d   v1.35\nn2   Ready   <none>   1d   v1.35\n'};
        return answerFor(argv);
    });
    h.poller.start();
    await settle();
    await activateWatch();               // map matches the table above
    const watches = Gio.__streamProcs().length;

    await GLib.__advance(300_500);
    await settle();
    assert.equal(Gio.__streamProcs().length, watches, 'no restart without drift');

    await GLib.__advance(300_500);
    await settle();
    const tables = pollCalls().filter(c => c.argv.includes('--no-headers'));
    assert.equal(tables.length, 2, 'the reconcile keeps its cadence');
    h.poller.stop();
});

test('two consecutive reconcile failures restart the watch', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('--no-headers'))
            return {stdout: '', stderr: 'connection refused', ok: false};
        return answerFor(argv);
    });
    h.poller.start();
    await settle();
    await activateWatch();
    const watches = Gio.__streamProcs().length;

    await GLib.__advance(300_500);       // first miss: tolerated
    await settle();
    assert.equal(Gio.__streamProcs().length, watches);
    await GLib.__advance(300_500);       // second miss: the stream is suspect
    await settle();
    assert.equal(Gio.__streamProcs().length, watches + 1);
    h.poller.stop();
});

test('a forced refresh restarts the watch; changed options do too', async () => {
    let context = '';
    const h = harness({getOpts: () => ({kubectlPath: '', kubeconfig: '', context})});
    h.poller.start();
    await settle();
    await activateWatch();
    const watches = Gio.__streamProcs().length;

    h.poller.refreshNow(true);           // network flip: sockets are dead
    await settle();
    assert.equal(Gio.__streamProcs().length, watches + 1);

    context = 'other';
    h.poller.refreshNow();               // context switch reaches the watch too
    await settle();
    assert.equal(Gio.__streamProcs().length, watches + 2);
    const argv = Gio.__calls().filter(c => c.argv.includes('--watch')).pop().argv;
    assert.ok(argv.includes('--context=other'), 'the new stream uses the new options');
    h.poller.stop();
});

test('with the menu open, events observe but never repaint the detail view', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();

    h.poller.setMenuOpen(true);
    await settle();
    await GLib.__advance(50);
    await settle();
    assert.equal(h.states[h.states.length - 1].tier, 'detail');
    const states = h.states.length;
    const observed = h.observations.length;

    proc.__pushLine('MODIFIED|n2||Ready|False');
    await settle();
    await GLib.__advance(300);
    await settle();
    assert.equal(h.states.length, states, 'no health state under an open menu');
    assert.ok(h.observations.length > observed, 'but the alert machine heard it');

    // Closing the menu swaps the stale detail view for a live snapshot.
    h.poller.setMenuOpen(false);
    await settle();
    const last = h.states[h.states.length - 1];
    assert.equal(last.tier, 'health');
    assert.equal(last.readyCount, 1);

    // And the leftover detail cadence is gone: no further polls.
    const polls = pollCalls().length;
    await GLib.__advance(30_000);
    await settle();
    assert.equal(pollCalls().length, polls);
    h.poller.stop();
});

test('watch lines arriving after stop() are ignored', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();
    const states = h.states.length;

    h.poller.stop();
    proc.__pushLine('MODIFIED|n1||Ready|False');
    await settle();
    await GLib.__advance(2_000);
    await settle();
    assert.equal(h.states.length, states, 'a stopped poller stays silent');
    assert.equal(GLib.__pendingTimers(), 0, 'and holds no timers');
});

test('a watch exit after stop() schedules nothing', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = watchProc();
    h.poller.stop();
    proc.__exit({ok: false});
    await settle();
    assert.equal(GLib.__pendingTimers(), 0, 'no respawn timer after teardown');
});

test('a watch exit releases every source the stream owned', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = await activateWatch();
    proc.__pushLine('MODIFIED|n1||Ready|False');
    await settle();

    proc.__exit({ok: false});
    await settle();
    assert.equal(h.poller._heartbeatId, 0, 'heartbeat');
    assert.equal(h.poller._reconcileId, 0, 'reconcile');
    assert.equal(h.poller._coalesceId, 0, 'pending flush');
    assert.equal(h.poller._watchStartupId, 0, 'startup budget');
    h.poller.stop();
    assert.equal(GLib.__pendingTimers(), 0, 'and the retry with them');
});

test('garbage lines on the watch stream are ignored', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    const proc = watchProc();
    proc.__pushLine('some stray warning kubectl printed');
    await settle();
    await GLib.__advance(1_000);
    await settle();
    assert.equal(h.states.length, 1, 'only the bridging poll delivered');
    proc.__pushLine('ADDED|n1||Ready|True');
    await settle();
    await GLib.__advance(300);
    await settle();
    assert.equal(h.states.length, 2, 'real events still work afterwards');
    h.poller.stop();
});

test('intervalChanged re-arms the heartbeat at the new cadence', async () => {
    let interval = 10;
    const h = harness({getIntervalSec: () => interval});
    h.poller.start();
    await settle();
    await activateWatch();
    const observed = h.observations.length;

    interval = 2;
    h.poller.intervalChanged();
    await settle();
    await GLib.__advance(2_500);
    await settle();
    assert.equal(h.observations.length, observed + 1,
        'the heartbeat follows the new interval');
    h.poller.stop();
});

test('intervalChanged on a stopped poller does nothing', async () => {
    const h = harness();
    h.poller.stop();
    h.poller.intervalChanged();
    await settle();
    assert.equal(GLib.__pendingTimers(), 0);
});

test('stop() during a coalescing window clears the pending flush', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    watchProc().__pushLine('ADDED|n1||Ready|True');
    await settle();                      // event queued, quiet window armed
    const states = h.states.length;
    h.poller.stop();
    assert.equal(GLib.__pendingTimers(), 0, 'the flush timer is gone');
    await GLib.__advance(2_000);
    await settle();
    assert.equal(h.states.length, states, 'the pending snapshot never delivered');
});

test('a line from a superseded watcher is ignored (white-box guard check)', async () => {
    // Not reachable through the stub, whose cancelled reads never deliver, but
    // real GJS could land a queued read after a restart swapped the watcher.
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();
    const states = h.states.length;
    h.poller._onWatchLine(/** @type {any} */ ({}), 'MODIFIED|n1||Ready|False');
    await GLib.__advance(2_000);
    await settle();
    assert.equal(h.states.length, states, 'the stale line must not flush');
});

test('an exit from a superseded watcher schedules nothing (white-box guard check)', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();
    const timers = GLib.__pendingTimers();
    h.poller._onWatchExit(/** @type {any} */ ({}), {ok: false, detail: '', lifetimeMs: 0});
    assert.equal(GLib.__pendingTimers(), timers, 'no respawn for a watcher we replaced');
    h.poller.stop();
});

test('a reconcile firing mid-poll defers to the poll (white-box guard check)', async () => {
    // Aligning the 300s reconcile with an in-flight detail poll through the
    // clock alone is timing soup; the guard is asserted directly instead.
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();
    const tablesBefore = pollCalls().filter(c => c.argv.includes('--no-headers')).length;
    h.poller._polling = true;            // a detail poll is on the wire
    await h.poller._reconcile();
    h.poller._polling = false;
    const tablesAfter = pollCalls().filter(c => c.argv.includes('--no-headers')).length;
    assert.equal(tablesAfter, tablesBefore, 'no table poll on top of a live poll');
    h.poller.stop();
});

test('a reconcile landing after the watch died is discarded', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => argv.includes('--no-headers')
        ? {stdout: 'n1   Ready   <none>   1d   v1.35\n', defer: true}
        : answerFor(argv));
    h.poller.start();
    await settle();
    const proc = await activateWatch();

    await GLib.__advance(300_500);       // the table poll is now in flight
    await settle();
    proc.__exit({ok: false});            // and the watch dies under it
    await settle();
    const watches = Gio.__streamProcs().length;

    Gio.__release();                     // the late table answer lands
    await settle();
    assert.equal(Gio.__streamProcs().length, watches,
        'a stale reconcile must not restart anything');
    h.poller.stop();
});

test('a failing reconcile landing after the watch died is discarded too', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => argv.includes('--no-headers')
        ? {stdout: '', stderr: 'boom', ok: false, defer: true}
        : answerFor(argv));
    h.poller.start();
    await settle();
    const proc = await activateWatch();

    await GLib.__advance(300_500);
    await settle();
    proc.__exit({ok: false});
    await settle();
    const watches = Gio.__streamProcs().length;

    Gio.__release();
    await settle();
    assert.equal(Gio.__streamProcs().length, watches,
        'a stale failure neither counts nor restarts');
    h.poller.stop();
});

test('stop() during a reconcile unwinds it as a quiet cancellation', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => argv.includes('--no-headers')
        ? {stdout: 'n1   Ready   <none>   1d   v1.35\n', defer: true}
        : answerFor(argv));
    h.poller.start();
    await settle();
    await activateWatch();

    await GLib.__advance(300_500);       // reconcile in flight
    await settle();
    h.poller.stop();                     // cancels it mid-air
    await settle();
    assert.equal(GLib.__pendingTimers(), 0, 'teardown left nothing armed');
});

test('a non-Error reconcile failure is still classified and counted', async () => {
    const h = harness();
    Gio.__setSpawn(({argv}) => argv.includes('--no-headers')
        ? {throws: 'plain string failure'}
        : answerFor(argv));
    h.poller.start();
    await settle();
    await activateWatch();
    const watches = Gio.__streamProcs().length;

    await GLib.__advance(300_500);       // first miss
    await settle();
    assert.equal(Gio.__streamProcs().length, watches);
    await GLib.__advance(300_500);       // second miss restarts the watch
    await settle();
    assert.equal(Gio.__streamProcs().length, watches + 1);
    h.poller.stop();
});

test('heartbeat guards: no double-arm, and a raced firing re-arms nothing (white-box)', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();
    const timers = GLib.__pendingTimers();
    h.poller._startHeartbeat();          // already armed -> replaced, not stacked
    assert.equal(GLib.__pendingTimers(), timers);

    // GLib can dispatch an already-queued source in the same iteration that
    // teardown flips the state, so the callback re-checks before observing.
    h.poller._watchActive = false;
    const observed = h.observations.length;
    await GLib.__advance(10_500);
    await settle();
    assert.equal(h.observations.length, observed, 'no observation from a dead watch');
    h.poller._watchActive = true;        // restore for a clean stop
    h.poller.stop();
});

test('a reconcile invoked after teardown does nothing (white-box guard check)', async () => {
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();
    h.poller.stop();
    const calls = Gio.__calls().length;
    await h.poller._reconcile();
    assert.equal(Gio.__calls().length, calls, 'no table poll after stop()');
});

test('a scheduler re-entered replaces its source instead of orphaning one', async () => {
    // The fake GLib throws on removing an unknown id, so a wrong removal fails
    // here just as loudly as the leaked timer this guards against.
    const h = harness();
    h.poller.start();
    await settle();
    await activateWatch();               // heartbeat and reconcile are armed
    const base = GLib.__pendingTimers();

    h.poller._scheduleNext(5);
    h.poller._scheduleNext(5);
    h.poller._armCoalesce(200);
    h.poller._armCoalesce(200);
    h.poller._scheduleWatchRetry(5);
    h.poller._scheduleWatchRetry(5);
    h.poller._startHeartbeat();
    h.poller._startReconcile();
    assert.equal(GLib.__pendingTimers(), base + 3,
        'one poll, one flush and one retry source, each armed exactly once');

    h.poller.stop();
    assert.equal(GLib.__pendingTimers(), 0, 'and stop() removes every one of them');
});
