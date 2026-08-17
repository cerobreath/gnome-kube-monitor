// Tests for the kubectl IO edge: argv, the environment kubectl and its exec
// credential plugins see, kubectl-path validation, and cancellation.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    fetchHealth, fetchHealthTable, fetchNodesDetail, fetchNodeMetrics,
    fetchPodsSummary, fetchContexts, fetchCurrentContext, NodeWatcher,
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

    // A context that looks like a flag must stay one argv element.
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

    // kubectl said nothing: the message stays empty. The detail slot only ever
    // carries kubectl's own words, so untranslatable English cannot leak into it.
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

// The node watch

/** Spawn a watcher against a scriptable streaming subprocess. */
function watchHarness(watcherOpts = OPTS) {
    reset();
    Gio.__setSpawn(() => ({stream: true}));
    const seen = {lines: /** @type {string[]} */ ([]), exits: /** @type {any[]} */ ([])};
    const watcher = new NodeWatcher(watcherOpts, {
        onLine: l => seen.lines.push(l),
        onExit: i => seen.exits.push(i),
    });
    watcher.start();
    return {watcher, seen, proc: Gio.__lastStreamProc()};
}

test('watch argv: --watch and event output, no request timeout, context as one element', () => {
    const {proc} = watchHarness(opts({context: 'demo'}));
    const argv = Gio.__lastCall().argv;
    assert.ok(argv.includes('--watch'), argv.join(' '));
    assert.ok(argv.includes('--output-watch-events'));
    assert.ok(!argv.some(a => a.startsWith('--request-timeout')),
        'a request timeout would cleanly kill the watch after it elapsed');
    assert.ok(argv.includes('--context=demo'));
    assert.ok(argv[argv.length - 1].startsWith('jsonpath='));
    assert.ok(proc, 'the watch child is a streaming subprocess');
});

test('watch lines stream to onLine as they arrive; a clean exit reports ok', async () => {
    const {seen, proc} = watchHarness();
    proc.__pushLine('ADDED|n1||Ready|True');
    await GLib.__settle();
    assert.deepEqual(seen.lines, ['ADDED|n1||Ready|True']);

    proc.__pushLine('MODIFIED|n1||Ready|False');
    await GLib.__settle();
    assert.equal(seen.lines.length, 2);

    GLib.__setClock(45_000);             // lifetime comes from the monotonic clock
    proc.__exit({ok: true});
    await GLib.__settle();
    assert.equal(seen.exits.length, 1);
    assert.equal(seen.exits[0].ok, true);
    assert.equal(seen.exits[0].detail, '');
    assert.equal(seen.exits[0].lifetimeMs, 45_000);
});

test('watch failure carries a bounded stderr tail for classification', async () => {
    const {seen, proc} = watchHarness();
    proc.__pushErr('E0817 klog preamble nobody wants');
    proc.__pushErr('The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?');
    proc.__exit({ok: false});
    await GLib.__settle();
    assert.equal(seen.exits.length, 1);
    assert.equal(seen.exits[0].ok, false);
    assert.ok(seen.exits[0].detail.includes('connection to the server'), seen.exits[0].detail);

    // The tail is capped, keeping the end where kubectl puts its summary.
    const {seen: seen2, proc: proc2} = watchHarness();
    for (let i = 0; i < 200; i++)
        proc2.__pushErr(`line ${i} ${'x'.repeat(100)}`);
    proc2.__pushErr('final summary');
    proc2.__exit({ok: false});
    await GLib.__settle();
    assert.ok(seen2.exits[0].detail.length <= 4096);
    assert.ok(seen2.exits[0].detail.endsWith('final summary'));
});

test('watch stop() kills the child and silences onExit', async () => {
    const {watcher, seen, proc} = watchHarness();
    proc.__pushLine('ADDED|n1||Ready|True');
    await GLib.__settle();
    watcher.stop();
    await GLib.__settle();
    assert.equal(Gio.__killCount(), 1, 'the kubectl child must not linger');
    assert.equal(seen.exits.length, 0, 'teardown is silent');
    watcher.stop();                      // idempotent
    await GLib.__settle();
    assert.equal(seen.exits.length, 0);
});

test('a failed spawn reports through onExit asynchronously', async () => {
    reset();
    Gio.__setSpawn(() => ({spawnThrows: new Error('No such file or directory')}));
    /** @type {any[]} */
    const exits = [];
    const watcher = new NodeWatcher(opts(), {onLine: () => {}, onExit: i => exits.push(i)});
    watcher.start();
    assert.equal(exits.length, 0, 'not synchronously, or the poller would re-enter');
    await GLib.__settle();
    assert.equal(exits.length, 1);
    assert.equal(exits[0].ok, false);
    assert.ok(exits[0].detail.includes('No such file'));
});

test('a watch killed from outside reports a not-ok exit', async () => {
    const {seen, proc} = watchHarness();
    proc.force_exit();                   // the OS or the user killed kubectl
    await GLib.__settle();
    assert.equal(seen.exits.length, 1);
    assert.equal(seen.exits[0].ok, false);
});

test('fetchHealthTable asks for the server-printed table and parses it', async () => {
    reset();
    respond('n1   Ready   <none>   10d   v1.34.6+k3s1\nn2   NotReady   <none>   9d   v1.34.6+k3s1\n');
    const rows = await fetchHealthTable(opts(), null);
    const argv = Gio.__lastCall().argv;
    assert.ok(argv.includes('--no-headers'), argv.join(' '));
    assert.ok(argv.includes('--request-timeout=5s'), 'the reconcile is a bounded poll');
    assert.ok(!argv.some(a => a.startsWith('-o')), 'no output flag: the server prints');
    assert.deepEqual(rows, [
        {name: 'n1', ready: true, unschedulable: false},
        {name: 'n2', ready: false, unschedulable: false},
    ]);
});

test('a mid-stream read failure kills the child and reports an abnormal exit', async () => {
    const {seen, proc} = watchHarness();
    proc.__pushLine('ADDED|n1||Ready|True');
    await GLib.__settle();
    proc.__failOut(new Error('Input/output error'));
    await GLib.__settle();
    assert.equal(seen.exits.length, 1);
    assert.equal(seen.exits[0].ok, false);
    assert.ok(seen.exits[0].detail.includes('Input/output error'), seen.exits[0].detail);
    assert.ok(Gio.__killCount() >= 1, 'the child and the sibling stream are torn down');
});
