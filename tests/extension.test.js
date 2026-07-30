// Unit tests for the wiring. This is where the alert machine meets GSettings and
// the notifier, so the things asserted here are the ones that used to be provable
// only by living with the extension for a while: that writing our own state key
// cannot trigger a re-poll, that a steady cluster does not churn dconf, that
// group_wait coalesces banners, and that disable() releases everything.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import KubeMonitorExtension from '../extension.js';
import {isDebugEnabled} from '../lib/log.js';

const HEALTH_ALL_OK = 'n1\tfalse\tReady=True,\n';
const HEALTH_N1_DOWN = 'n1\tfalse\tReady=False,\n';

/** @param {object} [settingsInitial] */
function makeExtension(settingsInitial = {}) {
    Gio.__reset();
    GLib.__reset();
    Main.__reset();
    MessageTray.__setApiGeneration(50);
    // Dispatch on argv: the extension asks kubectl three different questions at
    // enable (health, current-context, get-contexts) and answering them all with
    // node output would put nonsense in the context label.
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('current-context'))
            return {stdout: 'ctx\n'};
        if (argv.includes('get-contexts'))
            return {stdout: 'ctx\n'};
        return {stdout: HEALTH_ALL_OK};
    });

    const ext = new KubeMonitorExtension({
        uuid: 'kube-monitor@cerobreath.dev',
        path: '/ext',
        __settingsInitial: settingsInitial,
    });
    return {ext, settings: ext.getSettings()};
}

const settle = () => GLib.__settle();

/**
 * Run whole poll cycles. Note the lifecycle: the first observation that sees a
 * bad node only *pends* it, so firing always needs a second one -- even with
 * `for` set to 0. That is the debounce working, not an off-by-one.
 * @param {number} count
 */
async function pollCycles(count = 1) {
    for (let i = 0; i < count; i++) {
        await GLib.__advance(10_500);
        await settle();
    }
}

/** Let the group_wait window close so buffered actions become banners. */
async function flushBanners(windowMs = 10) {
    await GLib.__advance(windowMs);
    await settle();
}

/** Titles of every banner posted through our own tray source. */
function banners() {
    return Main.messageTray.sources.flatMap(s => s.notifications.map(n => ({
        title: n.title, body: n.body, urgency: n.urgency,
    })));
}

test('enable installs the indicator and starts polling; disable removes it', async () => {
    const {ext} = makeExtension();
    ext.enable();
    await settle();

    assert.ok(Main.panel.statusArea['kube-monitor@cerobreath.dev'], 'indicator is in the panel');
    assert.ok(Gio.__calls().length >= 1, 'polling started');

    ext.disable();
    assert.equal(Main.panel.statusArea['kube-monitor@cerobreath.dev'], undefined);
    assert.equal(GLib.__pendingTimers(), 0, 'no timers left armed');
    assert.equal(Main.messageTray.sources.length, 0, 'the tray source is gone');
});

test('disable releases the settings handler and the panel style handler', async () => {
    const {ext, settings} = makeExtension();
    const panelBefore = Main.panel.__handlerCount();
    ext.enable();
    await settle();
    assert.ok(settings.__handlerCount() > 0);
    assert.ok(Main.panel.__handlerCount() > panelBefore);

    ext.disable();
    assert.equal(settings.__handlerCount(), 0, 'no GSettings handler survives disable');
    assert.equal(Main.panel.__handlerCount(), panelBefore,
        'else every screen lock would leak one');
});

test('enable/disable cycles (i.e. screen locks) do not accumulate anything', async () => {
    const {ext, settings} = makeExtension();
    const panelBaseline = Main.panel.__handlerCount();
    for (let i = 0; i < 3; i++) {
        ext.enable();
        await settle();
        ext.disable();
    }
    assert.equal(settings.__handlerCount(), 0);
    assert.equal(Main.panel.__handlerCount(), panelBaseline);
    assert.equal(GLib.__pendingTimers(), 0);
    assert.equal(Main.messageTray.sources.length, 0);
    assert.equal(Object.keys(Main.panel.statusArea).length, 0);
});

test('a node going down notifies once, as a sticky critical banner', async () => {
    const {ext} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();                       // cold start: silent baseline
    assert.deepEqual(banners(), []);

    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);                  // pend, then fire
    await flushBanners();

    assert.deepEqual(banners().map(b => b.title), ['n1 is down']);
    assert.equal(banners()[0].urgency, MessageTray.Urgency.CRITICAL,
        'a fire must stick and show under DND');

    // Still down on the next poll: no repeat (repeat-interval defaults to 0).
    await pollCycles(2);
    await flushBanners();
    assert.equal(banners().length, 1, 'dedup: the user is told once');
    ext.disable();
});

test('recovery notifies at normal urgency', async () => {
    const {ext} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();
    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);
    await flushBanners();

    Gio.__setSpawn(() => ({stdout: HEALTH_ALL_OK}));
    await pollCycles(1);
    await flushBanners();

    const titles = banners().map(b => b.title);
    assert.deepEqual(titles, ['n1 is down', 'n1 recovered']);
    assert.equal(banners()[1].urgency, MessageTray.Urgency.NORMAL);
    ext.disable();
});

test('several nodes flipping together are coalesced into one banner', async () => {
    const {ext} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    Gio.__setSpawn(() => ({stdout: 'a\tfalse\tReady=True,\nb\tfalse\tReady=True,\n'}));
    ext.enable();
    await settle();

    Gio.__setSpawn(() => ({stdout: 'a\tfalse\tReady=False,\nb\tfalse\tReady=False,\n'}));
    await pollCycles(2);
    await flushBanners();

    assert.equal(banners().length, 1, 'one banner, not a wall of them');
    assert.equal(banners()[0].title, '2 firing');
    assert.match(banners()[0].body, /a, b/);
    ext.disable();
});

test('group_wait batches alerts that fire in separate polls', async () => {
    const {ext} = makeExtension({
        'alert-node-for': 0, 'alert-keep-firing-for': 0, 'alert-group-wait': 30,
    });
    Gio.__setSpawn(() => ({stdout: 'a\tfalse\tReady=True,\nb\tfalse\tReady=True,\n'}));
    ext.enable();
    await settle();

    Gio.__setSpawn(() => ({stdout: 'a\tfalse\tReady=False,\nb\tfalse\tReady=True,\n'}));
    await pollCycles(2);                  // a pends then fires; the 30s window opens
    assert.deepEqual(banners(), [], 'nothing sent yet: still collecting');

    Gio.__setSpawn(() => ({stdout: 'a\tfalse\tReady=False,\nb\tfalse\tReady=False,\n'}));
    await pollCycles(2);                  // b fires inside the same window
    await flushBanners(40_000);           // window closes

    assert.equal(banners().length, 1, 'both fires arrived in one banner');
    assert.equal(banners()[0].title, '2 firing');
    ext.disable();
});

test('an unreachable cluster notifies without leaking kubectl detail into the body', async () => {
    const {ext} = makeExtension({'alert-cluster-for': 0});
    ext.enable();
    await settle();

    Gio.__setSpawn(() => ({
        stdout: '', ok: false,
        stderr: 'Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused',
    }));
    // A failing poll backs the loop off (10s -> 20s), so the second observation
    // arrives later than a healthy interval would suggest.
    await GLib.__advance(10_500);          // poll fails -> cluster alert pends
    await settle();
    await GLib.__advance(21_000);          // backed-off retry -> fires
    await settle();
    await flushBanners();

    assert.equal(banners().length, 1);
    assert.equal(banners()[0].title, "Can't reach the cluster");
    assert.equal(banners()[0].body, '',
        'the detail can carry credentials and the lock screen shows bodies');
    ext.disable();
});

test('alert state is persisted, and reloaded on the next enable without replaying', async () => {
    const {ext, settings} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();
    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);
    await flushBanners();
    assert.equal(banners().length, 1);

    const persisted = settings.get_string('alert-state');
    assert.match(persisted, /NodeNotReady:n1/, 'the firing record is on disk');
    ext.disable();

    // A screen-lock style warm restart: the node is still down.
    Main.__reset();
    ext.enable();
    await settle();
    await flushBanners();
    assert.deepEqual(banners(), [], 'no replay: the user was already told');
    ext.disable();
});

test('a steady cluster does not rewrite the state key on every poll', async () => {
    const {ext, settings} = makeExtension();
    ext.enable();
    await settle();
    for (let i = 0; i < 5; i++) {
        await GLib.__advance(10_500);
        await settle();
    }
    const stateWrites = settings.writes.filter(k => k === 'alert-state').length;
    assert.equal(stateWrites, 0,
        'nothing is degraded, so there is nothing worth persisting');
    ext.disable();
});

test('writing our own state key never triggers a re-poll', async () => {
    const {ext} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();
    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await GLib.__advance(10_500);
    await settle();
    const callsAfterFire = Gio.__calls().length;

    // The fire persisted alert-state, which emits `changed`. If the handler
    // treated unknown keys as a connection change, this would re-poll forever.
    await settle();
    assert.equal(Gio.__calls().length, callsAfterFire, 'no feedback loop');
    ext.disable();
});

test('a connection change re-polls at once and cold-starts the alert machine', async () => {
    const {ext, settings} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();
    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);
    await flushBanners();
    assert.equal(banners().length, 1);

    // Switching context must not carry the old cluster's alerts over.
    settings.set_string('context', 'other');
    await settle();
    await GLib.__advance(50);
    await settle();
    await flushBanners();
    assert.equal(banners().length, 1, 'the switch itself is silent (cold start)');
    assert.ok(Gio.__lastCall().argv.includes('--context=other'), 'and it re-polled');
    ext.disable();
});

test('changing the interval re-arms the loop instead of re-polling', async () => {
    const {ext, settings} = makeExtension();
    ext.enable();
    await settle();
    const before = Gio.__calls().length;
    settings.set_int('refresh-interval', 2);
    await settle();
    assert.equal(Gio.__calls().length, before, 'no immediate poll');
    await GLib.__advance(2_500);
    await settle();
    assert.equal(Gio.__calls().length, before + 1, 'the shorter interval took effect');
    ext.disable();
});

test('alert tunables are read live, with no re-poll and no restart', async () => {
    const {ext, settings} = makeExtension();
    ext.enable();
    await settle();
    const before = Gio.__calls().length;
    for (const key of ['notify-node-changes', 'notify-cluster-unreachable', 'notify-on-recovery'])
        settings.set_boolean(key, false);
    for (const key of ['alert-node-for', 'alert-keep-firing-for', 'alert-repeat-interval'])
        settings.set_int(key, 5);
    await settle();
    assert.equal(Gio.__calls().length, before);
    ext.disable();
});

test('the copy row posts a transient confirmation from our own source', async () => {
    const {ext} = makeExtension();
    ext.enable();
    await settle();
    const indicator = Main.panel.statusArea['kube-monitor@cerobreath.dev'];
    indicator.emit('node-copied', 'worker-3');

    const posted = banners();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].title, 'Copied to clipboard');
    assert.match(posted[0].body, /kubectl describe node worker-3/);
    assert.equal(Main.messageTray.sources[0].notifications[0].isTransient, true);
    ext.disable();
});

test('snooze writes an absolute deadline and mutes the alert machine', async () => {
    const {ext, settings} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();
    const indicator = Main.panel.statusArea['kube-monitor@cerobreath.dev'];

    indicator.emit('snooze-requested', 900);
    const until = settings.get_int64('alert-silence-until');
    assert.ok(until > Date.now(), 'an absolute wall-clock deadline, so it survives a restart');

    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);
    await flushBanners();
    assert.deepEqual(banners(), [], 'muted: withheld, not dropped');

    // Unmuting delivers the still-firing alert rather than losing it.
    indicator.emit('snooze-requested', 0);
    assert.equal(settings.get_int64('alert-silence-until'), 0);
    await pollCycles(1);
    await flushBanners();
    assert.deepEqual(banners().map(b => b.title), ['n1 is down']);
    ext.disable();
});

test('the mute state is pushed into the menu on enable and on change', async () => {
    const deadline = Date.now() + 30 * 60 * 1000;
    const {ext, settings} = makeExtension({'alert-silence-until': deadline});
    ext.enable();
    await settle();
    const indicator = Main.panel.statusArea['kube-monitor@cerobreath.dev'];
    assert.match(indicator._muteItem.label.text, /Muted/, 'restored from settings at enable');

    settings.set_int64('alert-silence-until', 0);
    await settle();
    assert.equal(indicator._muteItem.label.text, 'Mute alerts', 'and kept in step after');
    ext.disable();
});

test('the refresh row and menu state reach the poller', async () => {
    const {ext} = makeExtension();
    ext.enable();
    await settle();
    const indicator = Main.panel.statusArea['kube-monitor@cerobreath.dev'];
    const before = Gio.__calls().length;

    indicator.emit('refresh-requested');
    await settle();
    assert.equal(Gio.__calls().length, before + 1, 'a manual refresh polls now');

    // Opening the menu switches to the detail tier.
    indicator.emit('menu-open-changed', true);
    await settle();
    await GLib.__advance(50);
    await settle();
    assert.ok(Gio.__calls().some(c => c.argv.includes('json')), 'detail tier was used');
    ext.disable();
});

test('selecting a context writes the setting', async () => {
    const {ext, settings} = makeExtension();
    ext.enable();
    await settle();
    Main.panel.statusArea['kube-monitor@cerobreath.dev'].emit('context-selected', 'staging');
    assert.equal(settings.get_string('context'), 'staging');
    ext.disable();
});

test('the context switcher is populated, resolving the current context when unset', async () => {
    const {ext} = makeExtension();
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('current-context'))
            return {stdout: 'auto-ctx\n'};
        if (argv.includes('get-contexts'))
            return {stdout: 'auto-ctx\nother\n'};
        return {stdout: HEALTH_ALL_OK};
    });
    ext.enable();
    await settle();
    const list = Main.panel.statusArea['kube-monitor@cerobreath.dev']._contextList;
    const texts = list.get_children().map(c => c.__allText().join(' '));
    assert.ok(texts.some(t => t.includes('auto-ctx')));
    assert.ok(texts.some(t => t.includes('other')));
    ext.disable();
});

test('an explicit context skips the current-context lookup', async () => {
    const {ext} = makeExtension({'context': 'prod'});
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('get-contexts'))
            return {stdout: 'prod\n'};
        return {stdout: HEALTH_ALL_OK};
    });
    ext.enable();
    await settle();
    assert.ok(!Gio.__calls().some(c => c.argv.includes('current-context')),
        'no need to ask kubectl which context is current');
    ext.disable();
});

test('a failed context listing leaves the UI alone', async () => {
    const {ext} = makeExtension();
    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false}));
    ext.enable();
    await settle();
    // Nothing threw, and the extension is still usable.
    assert.ok(Main.panel.statusArea['kube-monitor@cerobreath.dev']);
    ext.disable();
});

test('a context lookup landing after disable neither throws nor spawns', async () => {
    const {ext} = makeExtension();
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('current-context'))
            return {stdout: 'auto\n', defer: true};
        return {stdout: HEALTH_ALL_OK};
    });
    ext.enable();
    await settle();
    const callsBefore = Gio.__calls().length;

    ext.disable();
    Gio.__release();                      // the lookup lands after teardown
    await settle();
    assert.equal(Gio.__calls().length, callsBefore,
        'no orphaned get-contexts spawn with a null cancellable');
});

test('buffered banners are re-armed rather than lost when disable interrupts them', async () => {
    const {ext, settings} = makeExtension({
        'alert-node-for': 0, 'alert-keep-firing-for': 0, 'alert-group-wait': 60,
    });
    ext.enable();
    await settle();
    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);                  // fires, but sits in the group window
    assert.deepEqual(banners(), []);

    ext.disable();                        // teardown must not post, and must not drop
    assert.deepEqual(banners(), []);
    const persisted = JSON.parse(settings.get_string('alert-state'));
    assert.equal(persisted.alerts['NodeNotReady:n1'].lastStatus, 'resolved',
        're-armed, so the next enable delivers it');

    Main.__reset();
    ext.enable();
    await settle();
    await pollCycles(1);
    await flushBanners(70_000);
    assert.deepEqual(banners().map(b => b.title), ['n1 is down'], 'the user still gets told');
    ext.disable();
});

test('every poller callback degrades safely if it fires after disable', async () => {
    // These run inside the compositor, so a late callback that throws would land
    // as a JS error in gnome-shell rather than in our own code. The guards are
    // deliberate; this pins them down (white-box by necessity -- the callbacks are
    // only reachable through the poller's dependency object).
    const {ext} = makeExtension({'refresh-interval': 42});
    ext.enable();
    await settle();
    const deps = ext._poller._deps;

    assert.equal(deps.getIntervalSec(), 42);
    assert.equal(deps.getContextLabel(), 'ctx', 'resolved from kubectl current-context');
    ext.disable();

    assert.equal(deps.getIntervalSec(), 10, 'falls back to the schema default');
    assert.deepEqual(deps.getOpts(), {kubectlPath: '', kubeconfig: '', context: ''});
    // The resolved label deliberately outlives disable(), so a re-enable shows the
    // cluster name instead of flashing a placeholder; enable() re-reads it anyway.
    assert.equal(deps.getContextLabel(), 'ctx');
    ext._context = '';
    assert.equal(deps.getContextLabel(), 'kubectl', 'last-resort label');
    // Delivering state or an observation after teardown must be inert.
    deps.onState({tier: 'health', context: 'x', level: 'ok', nodes: [], readyCount: 0, total: 0});
    deps.onObservation({reachable: true, context: 'x', nodes: [], error: null});
    assert.deepEqual(banners(), []);
});

test('the extension\'s own helpers are inert after disable', async () => {
    const {ext} = makeExtension();
    ext.enable();
    await settle();
    ext.disable();

    // Each of these is reachable from a stale timer or promise continuation.
    ext._onObservation({reachable: false, context: 'x', nodes: [], error: null});
    ext._persistAlertState();
    ext._refreshContextInfo();
    ext._armGroupTimer();
    ext._flushGroup();
    await settle();
    assert.deepEqual(banners(), [], 'nothing is posted after teardown');
    assert.equal(GLib.__pendingTimers(), 0, 'and no timer is armed by a late call');
});

test('the config falls back to schema defaults when settings are gone', async () => {
    const {ext} = makeExtension();
    ext.enable();
    await settle();
    const live = ext._alertConfig();
    assert.equal(live.nodeForSec, 30);
    assert.equal(live.clusterEnabled, true);

    ext.disable();
    const fallback = ext._alertConfig();
    assert.deepEqual(fallback, {
        nodeEnabled: true, clusterEnabled: true, resolveNotify: true,
        nodeForSec: 30, clusterForSec: 30, keepFiringForSec: 60,
        repeatIntervalSec: 0, intervalSec: 10, settleFactor: 3, silencedUntilMs: 0,
    });
});

test('a settings change arriving after disable is ignored', async () => {
    const {ext, settings} = makeExtension();
    ext.enable();
    await settle();
    ext.disable();
    // The handler is disconnected, but prove a stray emission is harmless too.
    settings.emit('changed', 'context');
    settings.emit('changed', 'refresh-interval');
    settings.emit('changed', 'alert-silence-until');
    await settle();
    assert.equal(GLib.__pendingTimers(), 0);
});

test('the debug-logging switch turns diagnostics on and off, and disable stops them', async () => {
    const {ext, settings} = await Promise.resolve(makeExtension());
    ext.enable();
    await settle();
    assert.equal(isDebugEnabled(), false, 'off by default: the journal is shared');

    settings.set_boolean('debug-logging', true);
    await settle();
    assert.equal(isDebugEnabled(), true);

    settings.set_boolean('debug-logging', false);
    await settle();
    assert.equal(isDebugEnabled(), false);

    // On again, then torn down: logging must not outlive the extension.
    settings.set_boolean('debug-logging', true);
    await settle();
    ext.disable();
    assert.equal(isDebugEnabled(), false);
});

test('an extension enabled with debug-logging already on starts logging at once', async () => {
    const {ext} = makeExtension({'debug-logging': true});
    ext.enable();
    await settle();
    assert.equal(isDebugEnabled(), true);
    ext.disable();
});

test('disable() without a prior enable() is harmless', () => {
    // The shell calls disable() even when enable() bailed out, so nothing here
    // may assume enable() ran.
    const {ext} = makeExtension();
    ext.disable();
    assert.equal(GLib.__pendingTimers(), 0);
    assert.equal(Object.keys(Main.panel.statusArea).length, 0);
});

test('a context lookup cancelled mid-flight does not list contexts', async () => {
    const {ext} = makeExtension();
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('current-context'))
            return {stdout: 'auto\n', defer: true};
        if (argv.includes('get-contexts'))
            return {stdout: 'auto\nother\n'};
        return {stdout: HEALTH_ALL_OK};
    });
    ext.enable();
    await settle();
    const indicator = Main.panel.statusArea['kube-monitor@cerobreath.dev'];
    const before = indicator._contextList.get_children().length;

    ext._cancellable.cancel();            // e.g. teardown began
    Gio.__release();                      // the lookup lands afterwards
    await settle();
    assert.equal(indicator._contextList.get_children().length, before,
        'a cancelled lookup must not repopulate the switcher');
    ext.disable();
});

test('clearing the alert state writes an empty key rather than stale JSON', async () => {
    const {ext, settings} = makeExtension({'alert-node-for': 0, 'alert-keep-firing-for': 0});
    ext.enable();
    await settle();
    Gio.__setSpawn(() => ({stdout: HEALTH_N1_DOWN}));
    await pollCycles(2);
    await flushBanners();
    assert.match(settings.get_string('alert-state'), /NodeNotReady/);

    // A connection change drops the machine's state. If no observation lands
    // before teardown, the persist must CLEAR the key rather than leave the
    // previous cluster's alerts on disk for the next enable to load.
    Gio.__setSpawn(() => ({hang: true}));   // the re-poll never completes
    settings.set_string('kubectl-path', '/usr/bin/kubectl');
    await settle();
    ext.disable();
    assert.equal(settings.get_string('alert-state'), '');
});

test('a corrupt persisted state is discarded rather than trusted', async () => {
    const {ext} = makeExtension({'alert-state': '{not json'});
    ext.enable();
    await settle();
    assert.ok(Main.panel.statusArea['kube-monitor@cerobreath.dev'], 'enable still succeeds');
    ext.disable();
});
