// Unit tests for the view. Runs under node against the St/Clutter/PopupMenu
// fakes, so the parts that used to be verifiable only by opening the menu on a
// real desktop -- row reuse, the row cap, accessibility names, the mute submenu,
// width bounding -- are now regression-tested.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import St from 'gi://St';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KubeIndicator} from '../lib/indicator.js';
import {NodeLevel} from '../lib/model.js';

/** @param {object} [ext] */
function makeIndicator(ext = {}) {
    Main.__reset();
    GLib.__reset();
    St.__resetClipboard();
    let prefsOpened = 0;
    const indicator = new KubeIndicator({
        path: '/ext',
        openPreferences: () => {
            prefsOpened++;
        },
        ...ext,
    });
    return {indicator, prefsOpened: () => prefsOpened};
}

/**
 * A detail-tier node, defaulting to healthy.
 * @param {object} [over]
 */
function node(over = {}) {
    return {
        name: 'n1', roles: ['worker'], ready: true, statusText: 'Ready', issues: [],
        unschedulable: false, level: NodeLevel.OK, since: '3d', age: '30d',
        version: 'v1.34.0', cpuCapacityMilli: 4000, memCapacityBytes: 8e9,
        cpuPct: null, memPct: null, ...over,
    };
}

/** @param {object} [over] */
function detailState(over = {}) {
    return {
        tier: 'detail', context: 'ctx', level: NodeLevel.OK, nodes: [node()],
        readyCount: 1, total: 1, pods: null, error: null, monotonic: 0, ...over,
    };
}

/** Collect every style class present anywhere under an actor. */
function classesUnder(actor) {
    const own = actor.__classes ?? [];
    return own.concat(...actor.get_children().map(classesUnder));
}

/**
 * Depth-first search over the indicator AND its menu. The popup is a sibling
 * actor tree, not a child of the panel button, so a search rooted only at the
 * button misses everything in the menu.
 * @param {any} indicator
 * @param {(a: any) => boolean} pred
 */
function findActor(indicator, pred) {
    const walk = a => {
        if (!a)
            return null;
        if (pred(a))
            return a;
        for (const child of a.get_children?.() ?? []) {
            const hit = walk(child);
            if (hit)
                return hit;
        }
        return null;
    };
    return walk(indicator) ?? walk(indicator.menu);
}

/**
 * Every actor under the indicator or its menu matching a predicate.
 * @param {any} indicator
 * @param {(a: any) => boolean} pred
 */
function findAllActors(indicator, pred) {
    /** @type {any[]} */
    const hits = [];
    const walk = a => {
        if (!a)
            return;
        if (pred(a))
            hits.push(a);
        for (const child of a.get_children?.() ?? [])
            walk(child);
    };
    walk(indicator);
    walk(indicator.menu);
    return hits;
}

const menuOf = ind => /** @type {any} */ (ind.menu);

test('the panel shows the helm icon plus a status dot, and starts unknown', () => {
    const {indicator} = makeIndicator();
    const classes = classesUnder(indicator);
    assert.ok(classes.includes('kube-panel-icon'));
    assert.ok(classes.includes('kube-dot-unknown'), 'no data yet -> unknown');
    assert.match(indicator.accessible_name, /Kube Node Monitor/);
});

test('the panel dot and its spoken name follow the cluster level', () => {
    const {indicator} = makeIndicator();
    /** @type {[string, string][]} */
    const cases = [
        [NodeLevel.OK, 'healthy'],
        [NodeLevel.WARNING, 'degraded'],
        [NodeLevel.ERROR, 'critical'],
        [NodeLevel.UNKNOWN, 'status unknown'],
    ];
    for (const [level, word] of cases) {
        indicator.update(detailState({level, readyCount: 2, total: 3}));
        assert.ok(classesUnder(indicator).includes(`kube-dot-${level}`), level);
        assert.equal(indicator.accessible_name,
            `Kube Node Monitor: ${word}, 2 of 3 nodes ready`,
            'state must be available to a screen reader, not only as a colour');
    }
});

test('an undefined level falls back to unknown rather than breaking the class', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({level: undefined}));
    assert.ok(classesUnder(indicator).includes('kube-dot-unknown'));
});

test('an error state replaces the node list with a headline plus kubectl detail', () => {
    const {indicator} = makeIndicator();
    indicator.update({
        tier: 'health', context: 'ctx', level: NodeLevel.ERROR, nodes: [], readyCount: 0,
        total: 0, pods: null, monotonic: 0,
        error: {title: "Can't reach the cluster", detail: 'connection refused'},
    });

    const texts = menuOf(indicator).__itemTexts().join(' | ');
    assert.match(texts, /Can't reach the cluster/);
    assert.match(texts, /connection refused/);
    assert.ok(classesUnder(indicator).includes('kube-dot-error'));
    assert.equal(indicator.accessible_name, "Kube Node Monitor: Can't reach the cluster");
});

test('error labels wrap at WORD_CHAR so a long line cannot stretch the menu', () => {
    const {indicator} = makeIndicator();
    indicator.update({
        tier: 'health', context: 'ctx', level: NodeLevel.ERROR, nodes: [], readyCount: 0,
        total: 0, pods: null, monotonic: 0,
        error: {title: 'x'.repeat(120), detail: 'https://very.long.host.example/api?timeout=5s'},
    });
    const wrapped = findAllActors(indicator,
        a => a.__classes?.some(c => c === 'kube-error-title' || c === 'kube-error-detail'));
    assert.equal(wrapped.length, 2, 'headline and detail');
    for (const label of wrapped) {
        assert.equal(label.clutter_text.line_wrap, true);
        assert.equal(label.clutter_text.line_wrap_mode, Pango.WrapMode.WORD_CHAR);
    }
});

test('an error with no detail renders the headline alone', () => {
    const {indicator} = makeIndicator();
    indicator.update({
        tier: 'health', context: 'ctx', level: NodeLevel.ERROR, nodes: [], readyCount: 0,
        total: 0, pods: null, monotonic: 0,
        error: {title: "The cluster didn't answer in time", detail: ''},
    });
    const texts = menuOf(indicator).__itemTexts().join(' ');
    assert.match(texts, /didn't answer in time/);
});

test('the context title ellipsizes instead of widening the header', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({context: 'gke_some-project_europe-west1_prod-cluster'}));
    assert.equal(indicator._titleLabel.clutter_text.ellipsize, Pango.EllipsizeMode.END);
    assert.equal(indicator._titleLabel.text, 'gke_some-project_europe-west1_prod-cluster');
});

test('a down node says so in text, not just with a red dot', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({
        level: NodeLevel.ERROR, readyCount: 0,
        nodes: [node({ready: false, statusText: 'NotReady', level: NodeLevel.ERROR, since: '3m'})],
    }));
    const row = menuOf(indicator).__itemTexts().join(' ');
    assert.match(row, /NotReady/, 'the only textual signal that the node is down');
    assert.match(row, /↓ 3m/);
});

test('each node row carries a spoken summary including its meters', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({
        nodes: [node({name: 'worker-1', cpuPct: 41, memPct: 62})],
    }));
    const row = indicator._nodeRows.get('worker-1');
    assert.equal(row.item.accessible_name, 'worker-1, worker, up 3d, CPU 41%, memory 62%');
});

test('a down node with no qualifier still names its state for a reader', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({
        nodes: [node({name: 'w', ready: false, statusText: '', level: NodeLevel.ERROR})],
    }));
    assert.equal(indicator._nodeRows.get('w').item.accessible_name, 'w, NotReady, down 3d');
});

test('rows are reused while the signature holds, and rebuilt when it changes', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({nodes: [node({name: 'a'}), node({name: 'b'})]}));
    const firstA = indicator._nodeRows.get('a').item;

    // Same names and levels: only the dynamic bits update, no teardown churn.
    indicator.update(detailState({nodes: [node({name: 'a', since: '4d'}), node({name: 'b'})]}));
    assert.equal(indicator._nodeRows.get('a').item, firstA, 'the same actor must be reused');
    assert.match(indicator._nodeRows.get('a').durationLabel.text, /4d/);

    // A level change alters the signature, so the rows are rebuilt.
    indicator.update(detailState({
        level: NodeLevel.ERROR,
        nodes: [node({name: 'a', ready: false, level: NodeLevel.ERROR}), node({name: 'b'})],
    }));
    assert.notEqual(indicator._nodeRows.get('a').item, firstA);
});

test('rows are ordered most-severe-first', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({
        nodes: [
            node({name: 'ok-1'}),
            node({name: 'down-1', ready: false, statusText: 'NotReady', level: NodeLevel.ERROR}),
            node({name: 'warn-1', issues: ['MemoryPressure'], level: NodeLevel.WARNING}),
        ],
    }));
    assert.deepEqual([...indicator._nodeRows.keys()], ['down-1', 'warn-1', 'ok-1']);
});

test('the row count is capped and the remainder is summarised, never dropped silently', () => {
    const {indicator} = makeIndicator();
    const many = Array.from({length: 60}, (_, i) => node({name: `n${String(i).padStart(2, '0')}`}));
    indicator.update(detailState({nodes: many, readyCount: 60, total: 60}));

    assert.equal(indicator._nodeRows.size, 50, 'bounded so the compositor stays responsive');
    const texts = menuOf(indicator).__itemTexts().join(' | ');
    assert.match(texts, /and 10 more nodes/);
});

test('the summary row uses the singular for one hidden node', () => {
    const {indicator} = makeIndicator();
    const many = Array.from({length: 51}, (_, i) => node({name: `n${i}`}));
    indicator.update(detailState({nodes: many, readyCount: 51, total: 51}));
    assert.match(menuOf(indicator).__itemTexts().join(' | '), /and 1 more node\b/);
});

test('duplicate node names cannot force a rebuild on every poll', () => {
    const {indicator} = makeIndicator();
    const dupes = [node({name: 'same'}), node({name: 'same'})];
    indicator.update(detailState({nodes: dupes, readyCount: 2, total: 2}));
    const first = indicator._nodeRows.get('same').item;
    assert.equal(indicator._nodeRows.size, 1);

    indicator.update(detailState({nodes: dupes, readyCount: 2, total: 2}));
    assert.equal(indicator._nodeRows.get('same').item, first, 'fast path must still hold');
});

test('an empty cluster says so', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({nodes: [], readyCount: 0, total: 0}));
    assert.match(menuOf(indicator).__itemTexts().join(' '), /No nodes/);
});

test('meters appear only with metrics, and colour by load', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({nodes: [node({name: 'a'})]}));
    let row = indicator._nodeRows.get('a');
    assert.equal(row.meters.visible, false, 'no metrics-server -> no meters');

    indicator.update(detailState({nodes: [node({name: 'a', cpuPct: 10, memPct: 95})]}));
    row = indicator._nodeRows.get('a');
    assert.equal(row.meters.visible, true);
    assert.equal(row.cpu.value.text, '10%');
    assert.ok(row.cpu.fill.__classes.includes('kube-meter-ok'));
    assert.ok(row.mem.fill.__classes.includes('kube-meter-error'), '95% is critical');
    assert.match(row.cpu.fill.get_style(), /width: \d+px/);

    // Only one of the two present: the other stays hidden.
    indicator.update(detailState({nodes: [node({name: 'a', cpuPct: 50, memPct: null})]}));
    row = indicator._nodeRows.get('a');
    assert.equal(row.cpu.box.visible, true);
    assert.equal(row.mem.box.visible, false);
});

test('meter width is clamped, so a bogus percentage cannot draw outside the track', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({nodes: [node({name: 'a', cpuPct: 500, memPct: -20})]}));
    const row = indicator._nodeRows.get('a');
    const width = s => Number(/width: (\d+)px/.exec(s)?.[1]);
    assert.ok(width(row.cpu.fill.get_style()) <= 64, row.cpu.fill.get_style());
    assert.ok(width(row.mem.fill.get_style()) >= 2, 'a floor keeps the fill visible');
});

test('the pods summary shows only the states that are non-zero', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({
        pods: {total: 10, running: 8, pending: 0, failed: 0, succeeded: 2, crashloop: 0},
    }));
    let texts = menuOf(indicator).__itemTexts().join(' | ');
    assert.match(texts, /8 running/);
    assert.ok(!texts.includes('pending'), 'zero counts stay hidden');

    indicator.update(detailState({
        pods: {total: 10, running: 5, pending: 2, failed: 1, succeeded: 0, crashloop: 3},
    }));
    texts = menuOf(indicator).__itemTexts().join(' | ');
    for (const expected of [/5 running/, /2 pending/, /3 crashing/, /1 failed/])
        assert.match(texts, expected);
});

test('the pods row hides itself when there is no pod data', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({pods: null}));
    assert.equal(indicator._podsItem.visible, false);
    assert.equal(indicator._podsSeparator.visible, false);
});

test('the health tier leaves the node list alone', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({nodes: [node({name: 'a'})]}));
    assert.equal(indicator._nodeRows.size, 1);
    // A cheap health poll only drives the dot; it must not wipe the open menu.
    indicator.update({
        tier: 'health', context: 'ctx', level: NodeLevel.OK,
        nodes: [{name: 'a', ready: true}], readyCount: 1, total: 1, error: null, monotonic: 0,
    });
    assert.equal(indicator._nodeRows.size, 1, 'rows survive a health-tier update');
});

test('the context list marks the current one for both eye and reader', () => {
    const {indicator} = makeIndicator();
    indicator.setContexts(['dev', 'prod'], 'prod');
    const rows = indicator._contextList.get_children();
    const prod = rows.find(r => r.__allText().includes('prod'));
    const dev = rows.find(r => r.__allText().includes('dev'));
    assert.equal(prod.accessible_name, 'prod, current');
    assert.equal(dev.accessible_name, 'dev', 'opacity alone would say nothing to a reader');
    // The checkmark column stays laid out either way.
    assert.equal(prod.get_children()[0].get_children()[0].opacity, 255);
    assert.equal(dev.get_children()[0].get_children()[0].opacity, 0);
});

test('the context list is reactive but not activatable, so the theme cannot grey it out', () => {
    // St ties its `:insensitive` pseudo-class to an actor's reactivity, and the
    // shell's theme paints `.popup-inactive-menu-item:insensitive` in its
    // disabled grey -- which this container then passes down to the live buttons
    // inside it, so the cluster switcher rendered as though it were unavailable.
    // Measured in a real shell: with `reactive: false` every label resolved to
    // #9b9b9d on dark and #78787b on light; this way they resolve to #ffffff and
    // #222226, the theme's own foreground, with no colour of ours involved --
    // which is what keeps the Light style from going white-on-white.
    const {indicator} = makeIndicator();
    const item = indicator._contextItem;
    assert.equal(item.reactive, true, 'reactive:false is what marks it insensitive');
    assert.equal(item.activate, false, 'but it must not become an activatable menu item');
    assert.equal(item.hover, false, 'nor take the hover highlight of one');
    assert.equal(item.can_focus, false, 'the rows inside it are the focusable things');
});

test('the rows highlight on hover but the block around them never does', () => {
    const {indicator} = makeIndicator();
    // PopupBaseMenuItem hands `track_hover: params.reactive` straight to St, so
    // the reactive container would otherwise have the theme paint
    // `.popup-menu-item:hover` (#535359, measured) across the whole list, behind
    // whichever row the pointer is actually on. A fill that size marks nothing.
    assert.equal(indicator._contextItem.track_hover, false,
        'the list container must never take a hover highlight of its own');
    // The rows are the things being pointed at, and they are St.Buttons, which
    // track hover themselves -- `.kube-context-row:hover` in the stylesheet is
    // what makes that visible.
    indicator.setContexts(['a', 'b'], 'a');
    for (const row of indicator._contextList.get_children())
        assert.equal(row.track_hover ?? true, true, 'every row must respond to the pointer');
});

test('the context list always offers a way into preferences', () => {
    const {indicator, prefsOpened} = makeIndicator();
    indicator.setContexts([], '');
    const texts = indicator._contextList.get_children().map(c => c.__allText().join(' '));
    assert.ok(texts.some(t => /No contexts/.test(t)));
    const add = indicator._contextList.get_children().find(c => /Add connection/.test(c.__allText().join(' ')));
    add.emit('clicked');
    assert.equal(prefsOpened(), 1);
});

test('selecting a context emits it, collapses the list and shows a loading state', () => {
    const {indicator} = makeIndicator();
    /** @type {string[]} */
    const picked = [];
    indicator.connect('context-selected', (_i, ctx) => picked.push(ctx));
    indicator.update(detailState({nodes: [node({name: 'a'})]}));
    indicator.setContexts(['dev', 'prod'], 'dev');
    indicator._setContextsExpanded(true);

    const prod = indicator._contextList.get_children()
        .find(r => r.__allText().includes('prod'));
    prod.emit('clicked');

    assert.deepEqual(picked, ['prod']);
    assert.equal(indicator._contextsExpanded, false, 'the list closes after a pick');
    assert.equal(indicator._titleLabel.text, 'prod', 'instant feedback before the poll lands');
    assert.equal(indicator._nodeRows.size, 0, 'stale rows are cleared');
    assert.match(menuOf(indicator).__itemTexts().join(' '), /Loading…/);
});

test('the switcher announces whether it is expanded', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({context: 'prod'}));
    indicator._contextButton.emit('clicked');
    assert.equal(indicator._contextsExpanded, true);
    assert.match(indicator._contextButton.accessible_name, /prod, expanded, cluster switcher/);
    assert.equal(indicator._contextItem.visible, true);
    assert.equal(indicator._caret.icon_name, 'pan-down-symbolic');

    indicator._contextButton.emit('clicked');
    assert.match(indicator._contextButton.accessible_name, /collapsed/);
    assert.equal(indicator._caret.icon_name, 'pan-end-symbolic');
});

test('closing the menu collapses the switcher and reports open state', () => {
    const {indicator} = makeIndicator();
    /** @type {boolean[]} */
    const openStates = [];
    indicator.connect('menu-open-changed', (_i, open) => openStates.push(open));
    indicator._setContextsExpanded(true);

    menuOf(indicator).__setOpen(true);
    assert.deepEqual(openStates, [true]);
    menuOf(indicator).__setOpen(false);
    assert.deepEqual(openStates, [true, false]);
    assert.equal(indicator._contextsExpanded, false);
});

test('the refresh button is reachable by keyboard, named, and emits a refresh', () => {
    const {indicator} = makeIndicator();
    let refreshes = 0;
    indicator.connect('refresh-requested', () => refreshes++);
    // Find it by its accessible name rather than by tree position.
    const btn = findActor(indicator, a => a.accessible_name === 'Refresh now');
    assert.ok(btn, 'the refresh control must be discoverable');
    assert.equal(btn.can_focus, true, 'St defaults can_focus to false');
    btn.emit('clicked');
    assert.equal(refreshes, 1);
});

test('activating a node row copies its describe command and asks for a toast', () => {
    const {indicator} = makeIndicator();
    /** @type {string[]} */
    const copied = [];
    indicator.connect('node-copied', (_i, name) => copied.push(name));
    indicator.update(detailState({nodes: [node({name: 'worker-7'})]}));

    indicator._nodeRows.get('worker-7').item.emit('activate');
    assert.deepEqual(St.__clipboard(), [
        {type: St.ClipboardType.CLIPBOARD, text: 'kubectl describe node worker-7'},
    ]);
    assert.deepEqual(copied, ['worker-7'], 'the extension owns notifications, not the view');
});

test('the mute submenu offers durations and reports them in seconds', () => {
    const {indicator} = makeIndicator();
    /** @type {number[]} */
    const snoozes = [];
    indicator.connect('snooze-requested', (_i, secs) => snoozes.push(secs));
    const rows = indicator._muteItem.menu.__items;
    const labelled = rows.map(r => r.__allText().join(' '));
    assert.deepEqual(labelled, ['For 15 minutes', 'For 1 hour', 'For 8 hours', 'Turn muting off']);

    for (const r of rows)
        r.emit('activate');
    assert.deepEqual(snoozes, [900, 3600, 28800, 0]);
});

test('the mute label shows the time remaining and hides "off" when not muted', () => {
    const {indicator} = makeIndicator();
    assert.equal(indicator._muteItem.label.text, 'Mute alerts');
    assert.equal(indicator._unmuteItem.visible, false);

    indicator.setSnoozeUntil(Date.now() + 20 * 60 * 1000);
    assert.match(indicator._muteItem.label.text, /Muted · 20m left/);
    assert.equal(indicator._unmuteItem.visible, true);

    indicator.setSnoozeUntil(Date.now() + 3 * 60 * 60 * 1000);
    assert.match(indicator._muteItem.label.text, /Muted · 3h left/);

    indicator.setSnoozeUntil(Date.now() - 1000);        // already expired
    assert.equal(indicator._muteItem.label.text, 'Mute alerts');
    assert.equal(indicator._unmuteItem.visible, false);

    indicator.setSnoozeUntil(0);
    assert.equal(indicator._muteItem.label.text, 'Mute alerts');
});

test('the mute label refreshes when the menu opens', () => {
    const {indicator} = makeIndicator();
    indicator.setSnoozeUntil(Date.now() + 10 * 60 * 1000);
    menuOf(indicator).__setOpen(true);
    assert.match(indicator._muteItem.label.text, /Muted/);
});

test('the settings item opens preferences', () => {
    const {indicator, prefsOpened} = makeIndicator();
    const item = menuOf(indicator).__items.find(i => /Settings/.test(i.__allText().join(' ')));
    item.emit('activate');
    assert.equal(prefsOpened(), 1);
});

test('the "updated" label buckets elapsed time and survives a missing stamp', () => {
    const {indicator} = makeIndicator();
    indicator.update(detailState({monotonic: GLib.get_monotonic_time()}));
    assert.equal(indicator._timeLabel.text, 'now');

    /** @type {[number, string][]} */
    const cases = [[10_000, '10s'], [120_000, '2m'], [7_200_000, '2h']];
    for (const [ms, expected] of cases) {
        const {indicator: fresh} = makeIndicator();
        fresh.update(detailState({monotonic: GLib.get_monotonic_time()}));
        GLib.__setClock(ms);              // only the clock moves; no timers here
        fresh._updateTime();
        assert.equal(fresh._timeLabel.text, expected, `${ms}ms`);
    }

    // No stamp yet (a context switch just cleared it).
    const {indicator: pending} = makeIndicator();
    pending._showSwitching('other');
    assert.equal(pending._timeLabel.text, 'updating…');
});

test('a state without a monotonic stamp shows "updating…" rather than a bogus age', () => {
    const {indicator} = makeIndicator();
    const {monotonic: _drop, ...noStamp} = detailState();
    indicator.update(noStamp);
    assert.equal(indicator._timeLabel.text, 'updating…');
});

test('a cordoned-but-Ready node still reads as Ready to a screen reader', () => {
    // nodeQualifier returns '' here (warning level, no condition issues), so the
    // row's spoken summary has to supply the state itself.
    const {indicator} = makeIndicator();
    indicator.update(detailState({
        level: NodeLevel.WARNING,
        nodes: [node({name: 'cordoned', unschedulable: true, issues: [], level: NodeLevel.WARNING})],
    }));
    assert.equal(indicator._nodeRows.get('cordoned').item.accessible_name,
        'cordoned, Ready, up 3d');
});

test('the panel icon tracks the theme foreground and stops listening on destroy', () => {
    const {indicator} = makeIndicator();
    const before = indicator._icon.get_style();
    assert.match(before, /color: rgba\(255, 255, 255/);

    Main.panel.__setForeground({red: 0, green: 0, blue: 0, alpha: 255});
    assert.match(indicator._icon.get_style(), /color: rgba\(0, 0, 0/,
        'the logo must follow light/dark themes');

    const handlersBefore = Main.panel.__handlerCount();
    indicator.destroy();
    assert.equal(Main.panel.__handlerCount(), handlersBefore - 1,
        'the style-changed handler must be released, or every lock/unlock leaks one');
});

test('destroy clears the row map and removes the indicator from the panel', () => {
    const {indicator} = makeIndicator();
    Main.panel.addToStatusArea('kube', indicator);
    indicator.update(detailState({nodes: [node({name: 'a'})]}));
    assert.equal(indicator._nodeRows.size, 1);
    indicator.destroy();
    assert.equal(indicator._nodeRows.size, 0);
    assert.equal(Main.panel.statusArea.kube, undefined);
});
