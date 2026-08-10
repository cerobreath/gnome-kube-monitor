// Tests for the preferences window, which runs in a separate process from the
// shell, against the Adw/Gtk fakes.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import KubeMonitorPreferences from '../prefs.js';

/**
 * Build the preferences window. env is applied after the fakes are reset.
 * @param {object} [settingsInitial]
 * @param {{programs?: Record<string, string | null>, files?: string[], getenv?: Record<string, string>}} [env]
 */
async function openPrefs(settingsInitial = {}, env = {}) {
    Gio.__reset();
    GLib.__reset();
    if (env.programs)
        GLib.__setPrograms(env.programs);
    if (env.files)
        GLib.__setExistingFiles(env.files);
    if (env.getenv)
        GLib.__setGetenv(env.getenv);
    Gtk.__setFileDialogResult({dismissed: true});
    Gio.__setSpawn(({argv}) => {
        if (argv.includes('current-context'))
            return {stdout: 'dev\n'};
        if (argv.includes('get-contexts'))
            return {stdout: 'dev\nprod\n'};
        return {stdout: ''};
    });

    const prefs = new KubeMonitorPreferences({
        uuid: 'kube-monitor@cerobreath.dev', path: '/ext',
        __settingsInitial: settingsInitial,
    });
    const window = new Adw.PreferencesWindow();
    await prefs.fillPreferencesWindow(window);
    return {prefs, window, settings: prefs.getSettings(), page: window.__pages[0]};
}

/** Every row across every group on the page. */
function allRows(page) {
    return page.__groups.flatMap(g => g.__children.flatMap(
        row => [row, ...(row.__rows ?? [])]));
}

/** @param {any} page @param {string} title */
function rowByTitle(page, title) {
    return allRows(page).find(r => r.title === title);
}

test('the window has one page with Monitoring, Notifications and Connection groups', async () => {
    const {page} = await openPrefs();
    assert.deepEqual(page.__groups.map(g => g.title),
        ['Monitoring', 'Notifications', 'Connection']);
});

test('every control is bound to its schema key', async () => {
    const {settings} = await openPrefs();
    const bound = settings.__bindings.map(b => `${b.key}:${b.property}`);
    assert.deepEqual(bound.sort(), [
        'alert-cluster-for:value',
        'alert-group-wait:value',
        'alert-keep-firing-for:value',
        'alert-node-for:value',
        'alert-repeat-interval:value',
        'debug-logging:active',
        'kubectl-path:text',
        'notify-cluster-unreachable:active',
        'notify-node-changes:active',
        'notify-on-recovery:active',
        'refresh-interval:value',
    ].sort());
});

test('spin ranges match the schema, so the UI cannot write an out-of-range value', async () => {
    const {page} = await openPrefs();
    /** @type {[string, number, number][]} */
    const expected = [
        ['Refresh interval', 2, 3600],
        ['Node delay', 0, 3600],
        ['Cluster delay', 0, 3600],
        ['Hold time', 0, 3600],
        ['Repeat reminder', 0, 86400],
        ['Batch window', 0, 300],
    ];
    for (const [title, lower, upper] of expected) {
        const row = rowByTitle(page, title);
        assert.ok(row, title);
        assert.equal(row.adjustment.lower, lower, `${title} lower`);
        assert.equal(row.adjustment.upper, upper, `${title} upper`);
    }
});

test('rows carrying untrusted text disable Pango markup', async () => {
    // Adw parses row titles/subtitles as markup by default. These interpolate
    // paths and context names, so a stray '<' would mangle or spoof the text.
    const {page} = await openPrefs({'kubeconfig-path': '/home/tester/a.yaml'});
    for (const title of ['kubectl', 'kubeconfig', 'Context', 'a.yaml']) {
        const row = rowByTitle(page, title);
        assert.ok(row, title);
        assert.equal(row.use_markup, false, `${title} must not be markup-parsed`);
    }
});

test('the icon-only buttons carry tooltips, so they are not unlabelled to a reader', async () => {
    const {page} = await openPrefs({'kubeconfig-path': '/home/tester/a.yaml'});
    const add = rowByTitle(page, 'Add kubeconfig file…');
    assert.equal(add.__suffixes[0].tooltip_text, 'Add a kubeconfig file');
    const file = rowByTitle(page, 'a.yaml');
    assert.match(file.__suffixes[0].tooltip_text, /Remove a\.yaml/);
    // The status icons are labelled too.
    assert.match(rowByTitle(page, 'kubectl').__suffixes[0].tooltip_text, /Whether kubectl was found/);
});

test('detection reports kubectl found on PATH, and says where to fix it when not', async () => {
    let {page} = await openPrefs();
    let row = rowByTitle(page, 'kubectl');
    assert.equal(row.subtitle, '/usr/bin/kubectl');
    assert.equal(row.__suffixes[0].icon_name, 'emblem-ok-symbolic');

    ({page} = await openPrefs({}, {programs: {}}));   // nothing on PATH
    row = rowByTitle(page, 'kubectl');
    assert.match(row.subtitle, /Not found on PATH/,
        'the meaning is in words, not only in the icon');
    assert.equal(row.__suffixes[0].icon_name, 'dialog-warning-symbolic');
});

test('an explicit kubectl path wins over the PATH lookup', async () => {
    const {page} = await openPrefs({'kubectl-path': '/opt/kubectl'});
    assert.equal(rowByTitle(page, 'kubectl').subtitle, '/opt/kubectl');
});

test('kubeconfig detection covers default, missing, explicit and multi-file cases', async () => {
    // Default location, present.
    let {page} = await openPrefs();
    let row = rowByTitle(page, 'kubeconfig');
    assert.equal(row.subtitle, '/home/tester/.kube/config');
    assert.equal(row.__suffixes[0].icon_name, 'emblem-ok-symbolic');

    // Default location, absent -> flagged in words.
    ({page} = await openPrefs({}, {files: []}));
    row = rowByTitle(page, 'kubeconfig');
    assert.match(row.subtitle, /\(missing\)/);
    assert.equal(row.__suffixes[0].icon_name, 'dialog-warning-symbolic');

    // $KUBECONFIG is honoured when no path is configured.
    ({page} = await openPrefs({}, {
        getenv: {KUBECONFIG: '/env/kc.yaml'}, files: ['/env/kc.yaml'],
    }));
    assert.equal(rowByTitle(page, 'kubeconfig').subtitle, '/env/kc.yaml');

    // Several files merged: report the count rather than a misleading single path.
    ({page} = await openPrefs({'kubeconfig-path': '/a.yaml:/b.yaml'}));
    assert.equal(rowByTitle(page, 'kubeconfig').subtitle, '2 files');
});

test('the context list offers auto-follow plus every context', async () => {
    const {page} = await openPrefs();
    const combo = rowByTitle(page, 'Context');
    assert.deepEqual(combo.model.__items, ['Current context (auto)', 'dev', 'prod']);
    assert.equal(combo.selected, 0, 'nothing pinned -> follow current-context');
    assert.match(combo.subtitle, /Following current-context \(dev\)/);
});

test('a pinned context is preselected and described plainly', async () => {
    const {page} = await openPrefs({'context': 'prod'});
    const combo = rowByTitle(page, 'Context');
    assert.equal(combo.selected, 2, 'prod is the second context, after the auto entry');
    assert.equal(combo.subtitle, 'Which context to monitor');
});

test('picking a context writes it; picking auto clears it', async () => {
    const {page, settings} = await openPrefs();
    const combo = rowByTitle(page, 'Context');

    combo.selected = 2;                       // prod
    assert.equal(settings.get_string('context'), 'prod');
    combo.selected = 0;                       // back to auto
    assert.equal(settings.get_string('context'), '');
});

test('populating the list does not write the setting back (no feedback loop)', async () => {
    const {settings} = await openPrefs({'context': 'prod'});
    assert.ok(!settings.writes.includes('context'),
        'syncing the combo must not look like a user choice');
});

test('an out-of-range selection clears rather than writing rubbish', async () => {
    const {page, settings} = await openPrefs();
    const combo = rowByTitle(page, 'Context');
    combo.selected = 99;                      // no such context
    assert.equal(settings.get_string('context'), '');
});

test('a cluster whose contexts cannot be listed still opens cleanly', async () => {
    Gio.__reset();
    GLib.__reset();
    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false}));
    const prefs = new KubeMonitorPreferences({uuid: 'u', path: '/ext'});
    const window = new Adw.PreferencesWindow();
    await prefs.fillPreferencesWindow(window);
    const combo = rowByTitle(window.__pages[0], 'Context');
    assert.deepEqual(combo.model.__items, ['Current context (auto)'],
        'just the auto entry; the dialog is still usable');
});

test('the test button reports a classified reason, never raw stderr', async () => {
    const {page, window} = await openPrefs();
    const testBtn = rowByTitle(page, 'Test connection').__suffixes[0];

    Gio.__setSpawn(() => ({
        stdout: '', ok: false,
        stderr: 'E0711 22:10:05.879293 658680 memcache.go:265] "Unhandled Error" ' +
            'err="couldn\'t get current server API group list: Get \\"https://x/api\\": ' +
            'dial tcp: connect: connection refused"',
    }));
    testBtn.emit('clicked');
    await GLib.__settle();

    assert.equal(window.__toasts.length, 1);
    const toast = window.__toasts[0];
    assert.equal(toast.title, "Can't reach the cluster", 'the klog noise never reaches the user');
    assert.equal(toast.use_markup, false, 'Adw.Toast parses markup by default');
    assert.equal(testBtn.sensitive, true, 'the button is re-enabled either way');
});

test('a successful test reports the count, with correct singular and plural', async () => {
    const {page, window} = await openPrefs();
    const testBtn = rowByTitle(page, 'Test connection').__suffixes[0];

    Gio.__setSpawn(() => ({stdout: 'only-one\n'}));
    testBtn.emit('clicked');
    await GLib.__settle();
    assert.match(window.__toasts[0].title, /Found 1 context\./);

    Gio.__setSpawn(() => ({stdout: 'a\nb\n'}));
    testBtn.emit('clicked');
    await GLib.__settle();
    assert.match(window.__toasts[1].title, /Found 2 contexts\./);
});

test('the test button is disabled while the check runs', async () => {
    const {page} = await openPrefs();
    const testBtn = rowByTitle(page, 'Test connection').__suffixes[0];
    Gio.__setSpawn(() => ({stdout: '', defer: true}));

    testBtn.emit('clicked');
    assert.equal(testBtn.sensitive, false, 'no double-clicking a running check');
    Gio.__release();
    await GLib.__settle();
    assert.equal(testBtn.sensitive, true);
});

test('kubeconfig files are listed one row each, newest addition included', async () => {
    const {page} = await openPrefs({'kubeconfig-path': '/home/tester/a.yaml:/home/tester/b.yaml'});
    const titles = allRows(page).map(r => r.title);
    assert.ok(titles.includes('a.yaml'));
    assert.ok(titles.includes('b.yaml'));
    // The basename is the title, the full path the subtitle.
    assert.equal(rowByTitle(page, 'b.yaml').subtitle, '/home/tester/b.yaml');
});

test('the file picker appends a kubeconfig, and ignores duplicates', async () => {
    const {page, settings} = await openPrefs();
    const addBtn = rowByTitle(page, 'Add kubeconfig file…').__suffixes[0];

    Gtk.__setFileDialogResult({path: '/picked/one.yaml'});
    addBtn.emit('clicked');
    assert.equal(settings.get_string('kubeconfig-path'), '/picked/one.yaml');

    addBtn.emit('clicked');                   // the same file again
    assert.equal(settings.get_string('kubeconfig-path'), '/picked/one.yaml',
        'no duplicate entry');

    Gtk.__setFileDialogResult({path: '/picked/two.yaml'});
    addBtn.emit('clicked');
    assert.equal(settings.get_string('kubeconfig-path'), '/picked/one.yaml:/picked/two.yaml');
});

test('dismissing the file picker changes nothing', async () => {
    const {page, settings} = await openPrefs({'kubeconfig-path': '/keep.yaml'});
    const addBtn = rowByTitle(page, 'Add kubeconfig file…').__suffixes[0];
    Gtk.__setFileDialogResult({dismissed: true});
    addBtn.emit('clicked');
    assert.equal(settings.get_string('kubeconfig-path'), '/keep.yaml');
});

test('a picker returning an empty path is ignored', async () => {
    const {page, settings} = await openPrefs();
    const addBtn = rowByTitle(page, 'Add kubeconfig file…').__suffixes[0];
    Gtk.__setFileDialogResult({path: ''});
    addBtn.emit('clicked');
    assert.equal(settings.get_string('kubeconfig-path'), '');
});

test('removing a kubeconfig drops just that one', async () => {
    const {page, settings} = await openPrefs({'kubeconfig-path': '/a.yaml:/b.yaml'});
    const removeB = rowByTitle(page, 'b.yaml').__suffixes[0];
    removeB.emit('clicked');
    assert.equal(settings.get_string('kubeconfig-path'), '/a.yaml');
});

test('changing the kubeconfig setting rebuilds the rows and re-runs detection', async () => {
    const {page, settings} = await openPrefs();
    assert.equal(rowByTitle(page, 'a.yaml'), undefined);

    GLib.__setExistingFiles(['/home/tester/a.yaml']);
    settings.set_string('kubeconfig-path', '/home/tester/a.yaml');
    await GLib.__settle();

    assert.ok(rowByTitle(page, 'a.yaml'), 'the new file has a row');
    assert.equal(rowByTitle(page, 'kubeconfig').subtitle, '/home/tester/a.yaml');
});

test('changing the kubectl path re-runs detection', async () => {
    const {page, settings} = await openPrefs();
    settings.set_string('kubectl-path', '/opt/custom-kubectl');
    await GLib.__settle();
    assert.equal(rowByTitle(page, 'kubectl').subtitle, '/opt/custom-kubectl');
});

test('the Advanced section is collapsed detail, not a top-level group', async () => {
    const {page} = await openPrefs();
    const conn = page.__groups.find(g => g.title === 'Connection');
    const advanced = conn.__children.find(r => r.title === 'Advanced');
    assert.ok(advanced, 'kubectl path and extra kubeconfigs live behind Advanced');
    assert.ok(advanced.__rows.some(r => r.title === 'kubectl path'));
});

test('a picker handing back nothing at all is ignored', async () => {
    // Not a documented Gtk outcome; the guard stops an empty KUBECONFIG entry.
    const {page, settings} = await openPrefs({'kubeconfig-path': '/keep.yaml'});
    const addBtn = rowByTitle(page, 'Add kubeconfig file…').__suffixes[0];
    Gtk.__setFileDialogResult({nullFile: true});
    addBtn.emit('clicked');
    assert.equal(settings.get_string('kubeconfig-path'), '/keep.yaml');
});

test('a non-Error rejection still yields a readable toast', async () => {
    const {page, window} = await openPrefs();
    const testBtn = rowByTitle(page, 'Test connection').__suffixes[0];
    Gio.__setSpawn(() => ({throws: 'a bare string failure'}));
    testBtn.emit('clicked');
    await GLib.__settle();
    assert.equal(window.__toasts.length, 1);
    assert.equal(window.__toasts[0].title, 'kubectl ran into a problem');
});
