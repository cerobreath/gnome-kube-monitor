// Unit tests for the kubectl IO edge. Runs under node via tests/hooks.mjs, which
// redirects `gi://…` to the fakes in tests/stubs/gi. These lock down the
// properties that were previously only ever checked by hand: the argv we build,
// the environment we hand to kubectl (and therefore to its exec credential
// plugins), kubectl-path validation, and cancellation behaviour.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    fetchHealth, fetchNodesDetail, fetchNodeMetrics, fetchPodsSummary,
    fetchContexts, fetchCurrentContext,
} from '../lib/client.js';

const OPTS = {kubectlPath: '', kubeconfig: '', context: ''};

/** @param {object} [over] */
function opts(over = {}) {
    return {...OPTS, ...over};
}

function reset() {
    Gio.__reset();
    GLib.__reset();
}

/** @param {string} stdout */
function respond(stdout, stderr = '', ok = true) {
    Gio.__setSpawn(() => ({stdout, stderr, ok}));
}

test('argv: always bounded by a request timeout, context passed as one --flag=value', async () => {
    reset();
    respond('');
    await fetchContexts(opts(), null);
    let argv = Gio.__lastCall().argv;
    assert.equal(argv[0], '/usr/bin/kubectl');            // resolved from PATH
    assert.ok(argv.includes('--request-timeout=5s'), argv.join(' '));
    assert.ok(!argv.some(a => a.startsWith('--context')), 'no context set -> no flag');

    // A context that looks like a flag must still be one argv element, so no arg
    // parser can re-read it as a flag.
    reset();
    respond('');
    await fetchContexts(opts({context: '--kubeconfig=/tmp/evil.yaml'}), null);
    argv = Gio.__lastCall().argv;
    assert.ok(argv.includes('--context=--kubeconfig=/tmp/evil.yaml'), argv.join(' '));
    assert.equal(argv.filter(a => a.startsWith('--context')).length, 1);
});

test('argv: each fetch asks for the narrow projection it needs', async () => {
    reset();
    respond('');
    await fetchHealth(opts(), null);
    let argv = Gio.__lastCall().argv;
    assert.deepEqual(argv.slice(1, 4), ['--request-timeout=5s', 'get', 'nodes']);
    assert.ok(argv[argv.length - 1].startsWith('jsonpath='), 'health tier must use jsonpath');

    reset();
    respond(JSON.stringify({items: []}));
    await fetchNodesDetail(opts(), null);
    assert.deepEqual(Gio.__lastCall().argv.slice(-3), ['nodes', '-o', 'json']);

    reset();
    respond(JSON.stringify({items: []}));
    await fetchNodeMetrics(opts(), null);
    assert.deepEqual(Gio.__lastCall().argv.slice(-2),
        ['--raw', '/apis/metrics.k8s.io/v1beta1/nodes']);

    reset();
    respond('');
    await fetchPodsSummary(opts(), null);
    argv = Gio.__lastCall().argv;
    assert.ok(argv.includes('-A'), 'pods summary is cluster-wide');

    reset();
    respond('ctx-a\n');
    await fetchCurrentContext(opts(), null);
    assert.deepEqual(Gio.__lastCall().argv.slice(-2), ['config', 'current-context']);
});

test('environ: the session\'s secrets are not forwarded to kubectl', async () => {
    reset();
    // A realistic gnome-shell environment, including things kubectl must not see.
    GLib.__setEnviron([
        'PATH=/usr/bin:/bin',
        'HOME=/home/tester',
        'LANG=C',
        'SSH_AUTH_SOCK=/run/user/1000/keyring/ssh',
        'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
        'GNOME_KEYRING_CONTROL=/run/user/1000/keyring',
        'XDG_SESSION_ID=3',
        'MY_COMPANY_API_TOKEN=super-secret',
        'HTTPS_PROXY=http://proxy:3128',
        'AWS_PROFILE=prod',
    ]);
    respond('');
    await fetchContexts(opts(), null);
    const env = Gio.__lastCall().environ;
    const names = env.map(e => e.split('=')[0]);

    for (const leak of ['SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL',
        'XDG_SESSION_ID', 'MY_COMPANY_API_TOKEN'])
        assert.ok(!names.includes(leak), `${leak} must not reach kubectl or its exec plugins`);

    // Things kubectl legitimately needs do come through.
    assert.ok(names.includes('HTTPS_PROXY'), 'corporate proxy config must survive');
    assert.ok(names.includes('AWS_PROFILE'), 'cloud exec plugins need their config');
    assert.ok(names.includes('HOME'));
});

test('environ: PATH is extended (appended, never prepended) and DISPLAY is stripped', async () => {
    reset();
    GLib.__setEnviron(['PATH=/custom/bin', 'DISPLAY=:0', 'WAYLAND_DISPLAY=wayland-0']);
    respond('');
    await fetchContexts(opts(), null);
    const env = Gio.__lastCall().environ;
    const path = env.find(e => e.startsWith('PATH='))?.slice(5) ?? '';
    const parts = path.split(':');

    assert.equal(parts[0], '/custom/bin', 'the user\'s own PATH must stay first (no hijack)');
    for (const dir of ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin',
        '/home/tester/.local/bin', '/home/tester/.krew/bin'])
        assert.ok(parts.includes(dir), `${dir} should be searchable`);

    // A background poll must never be able to pop a browser for OIDC re-auth.
    assert.ok(!env.some(e => e.startsWith('DISPLAY=')), 'DISPLAY must be unset');
    assert.ok(!env.some(e => e.startsWith('WAYLAND_DISPLAY=')), 'WAYLAND_DISPLAY must be unset');
    assert.ok(env.includes('BROWSER=true'), 'BROWSER neutralised');
});

test('environ: KUBECONFIG is set only when a path is configured', async () => {
    reset();
    respond('');
    await fetchContexts(opts(), null);
    assert.ok(!Gio.__lastCall().environ.some(e => e.startsWith('KUBECONFIG=')));

    reset();
    respond('');
    await fetchContexts(opts({kubeconfig: '/tmp/kc.yaml'}), null);
    assert.ok(Gio.__lastCall().environ.includes('KUBECONFIG=/tmp/kc.yaml'));
});

test('kubectl-path: only an absolute, executable, regular file is honoured', async () => {
    const cases = [
        ['/opt/bin/kubectl', {type: Gio.FileType.REGULAR, executable: true}, '/opt/bin/kubectl'],
        ['/opt/bin/kubectl', {type: Gio.FileType.REGULAR, executable: false}, '/usr/bin/kubectl'],
        ['/opt/bin/kubectl', {type: Gio.FileType.DIRECTORY, executable: true}, '/usr/bin/kubectl'],
        ['/nope/kubectl', undefined, '/usr/bin/kubectl'],
        ['kubectl', {type: Gio.FileType.REGULAR, executable: true}, '/usr/bin/kubectl'],
    ];
    for (const [configured, fileInfo, expected] of cases) {
        reset();
        Gio.__setFiles(fileInfo ? {[configured]: fileInfo} : {});
        respond('');
        await fetchContexts(opts({kubectlPath: /** @type {string} */ (configured)}), null);
        assert.equal(Gio.__lastCall().argv[0], expected,
            `configured=${configured} info=${JSON.stringify(fileInfo)}`);
    }
});

test('kubectl-path: falls back to a bare name when nothing is on PATH', async () => {
    reset();
    GLib.__setPrograms({});          // find_program_in_path returns null
    respond('');
    await fetchContexts(opts(), null);
    assert.equal(Gio.__lastCall().argv[0], 'kubectl');
});

test('a non-zero exit surfaces stderr, falling back to stdout', async () => {
    reset();
    Gio.__setSpawn(() => ({stdout: 'out', stderr: 'the real reason', ok: false}));
    await assert.rejects(fetchHealth(opts(), null), /the real reason/);

    reset();
    Gio.__setSpawn(() => ({stdout: 'only stdout', stderr: '', ok: false}));
    await assert.rejects(fetchHealth(opts(), null), /only stdout/);

    // Said nothing at all: the message stays empty rather than being filled with
    // a sentence of ours. classifyError turns that into the generic headline with
    // no detail line -- the detail slot only ever carries kubectl's own words, so
    // it must not become a place where untranslatable English leaks to the user.
    reset();
    Gio.__setSpawn(() => ({stdout: '', stderr: '', ok: false}));
    await assert.rejects(fetchHealth(opts(), null), e => e.message === '');
});

test('cancellation kills the child, so a blocked exec plugin cannot linger', async () => {
    reset();
    Gio.__setSpawn(() => ({hang: true}));       // never returns on its own
    const cancellable = new Gio.Cancellable();
    const pending = fetchHealth(opts(), cancellable);
    await GLib.__settle();
    assert.equal(Gio.__killCount(), 0);
    cancellable.cancel();
    await assert.rejects(pending, e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
    assert.equal(Gio.__killCount(), 1, 'force_exit must run so no grandchild waits forever');
});

test('an already-cancelled cancellable rejects without leaking a handler', async () => {
    reset();
    Gio.__setSpawn(() => ({stdout: '', stderr: '', ok: true}));
    const cancellable = new Gio.Cancellable();
    cancellable.cancel();                        // connect() returns 0 in this state
    await assert.rejects(fetchHealth(opts(), cancellable),
        e => e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
});

test('an environment with no PATH still gets the standard search dirs', async () => {
    reset();
    GLib.__setEnviron(['HOME=/home/tester']);      // no PATH at all
    respond('');
    await fetchContexts(opts(), null);
    const path = Gio.__lastCall().environ.find(e => e.startsWith('PATH='))?.slice(5) ?? '';
    assert.ok(path.split(':').includes('/usr/bin'), path);
    assert.ok(!path.startsWith(':'), 'no empty leading entry');
});

test('a null stdout is treated as empty output, not a crash', async () => {
    reset();
    Gio.__setSpawn(() => ({stdout: null, stderr: '', ok: true}));
    assert.deepEqual(await fetchContexts(opts(), null), []);
});

test('fetchCurrentContext swallows failure and resolves empty', async () => {
    reset();
    Gio.__setSpawn(() => ({stdout: '', stderr: 'boom', ok: false}));
    assert.equal(await fetchCurrentContext(opts(), null), '');

    reset();
    respond('  ctx-b \n');
    assert.equal(await fetchCurrentContext(opts(), null), 'ctx-b');
});

test('fetchContexts trims blanks and whitespace', async () => {
    reset();
    respond('a\n\n  b  \nc\n');
    assert.deepEqual(await fetchContexts(opts(), null), ['a', 'b', 'c']);
});

test('parsing is delegated: each fetch returns model-shaped data', async () => {
    reset();
    respond('n1\tfalse\tReady=True,\n');
    const health = await fetchHealth(opts(), null);
    assert.equal(health.total, 1);
    assert.equal(health.nodes[0].ready, true);

    reset();
    respond(JSON.stringify({items: [{metadata: {name: 'n1'}, status: {}, spec: {}}]}));
    assert.equal((await fetchNodesDetail(opts(), null)).total, 1);

    reset();
    respond(JSON.stringify({items: [{metadata: {name: 'n1'}, usage: {cpu: '1', memory: '1Ki'}}]}));
    assert.equal((await fetchNodeMetrics(opts(), null)).get('n1').cpuMilli, 1000);

    reset();
    respond('Running|\nPending|\n');
    const pods = await fetchPodsSummary(opts(), null);
    assert.equal(pods.running, 1);
    assert.equal(pods.pending, 1);
});
