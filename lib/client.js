// kubectl invocation edge. Everything that shells out lives here; parsing is
// delegated to the pure model.js. Each fetch* takes (opts, cancellable) where
// opts = {kubectlPath, kubeconfig, context}.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as model from './model.js';

/**
 * @typedef {object} Opts
 * @property {string} kubectlPath  Explicit kubectl binary, or '' to look it up on PATH.
 * @property {string} kubeconfig   Explicit kubeconfig path, or '' for the default.
 * @property {string} context      kubectl context, or '' for the current one.
 */

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/**
 * gnome-shell runs with a trimmed PATH and no user KUBECONFIG — build the
 * environment explicitly, otherwise kubectl won't be found / won't see the config.
 * @param {string} kubeconfig
 * @returns {string[]}
 */
function buildEnviron(kubeconfig) {
    let environ = GLib.get_environ();

    const current = GLib.environ_getenv(environ, 'PATH') ?? '';
    const parts = current ? current.split(':') : [];
    const extra = [
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin']),
    ];
    for (const p of extra) {
        if (!parts.includes(p))
            parts.push(p);
    }
    environ = GLib.environ_setenv(environ, 'PATH', parts.join(':'), true);

    if (kubeconfig)
        environ = GLib.environ_setenv(environ, 'KUBECONFIG', kubeconfig, true);

    // Background polling must never pop up a window. OIDC/SSO exec credential
    // plugins (e.g. kubectl-oidc_login / kubelogin) open a browser to
    // re-authenticate once their cached token expires, and kubectl passes our
    // env straight through — so neutralise the browser launcher (xdg-open
    // honours $BROWSER, and `true` is a no-op) and strip the display as a
    // backstop. A poll then fails quietly instead of stealing focus; the user's
    // own kubectl in a terminal keeps its normal interactive login (its own env).
    environ = GLib.environ_setenv(environ, 'BROWSER', 'true', true);
    environ = GLib.environ_unsetenv(environ, 'DISPLAY');
    environ = GLib.environ_unsetenv(environ, 'WAYLAND_DISPLAY');

    return environ;
}

/**
 * @param {string} kubectlPath
 * @returns {string}
 */
function resolveKubectl(kubectlPath) {
    if (kubectlPath)
        return kubectlPath;
    return GLib.find_program_in_path('kubectl') ?? 'kubectl';
}

/**
 * @param {string[]} extraArgv
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<string>}
 */
async function runKubectl(extraArgv, {kubectlPath, kubeconfig, context}, cancellable) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_environ(buildEnviron(kubeconfig));

    const argv = [resolveKubectl(kubectlPath), '--request-timeout=5s'];
    if (context)
        argv.push('--context', context);
    argv.push(...extraArgv);

    const proc = launcher.spawnv(argv);

    // If the poll is cancelled (watchdog timeout, stop(), context switch), kill
    // the child too — an exec auth plugin that we blocked from opening a browser
    // (see buildEnviron) could otherwise linger waiting on a login that never comes.
    // NB: Gio.Cancellable.connect is g_cancellable_connect (takes the callback
    // directly), NOT the GObject signal connect(name, cb) — passing 'cancelled'
    // as a first arg throws "Expected function … got string" at runtime.
    let cancelledId = 0;
    if (cancellable)
        cancelledId = cancellable.connect(() => proc.force_exit());

    try {
        // Promisified above; @girs types the async form as callback-based, so the
        // resolved [stdout, stderr] tuple needs an explicit shape.
        const [stdout, stderr] = /** @type {[string, string]} */ (
            await proc.communicate_utf8_async(null, cancellable ?? null));

        if (!proc.get_successful()) {
            const msg = (stderr || stdout || 'kubectl exited with an error').trim();
            throw new Error(msg);
        }
        return stdout ?? '';
    } finally {
        if (cancelledId)
            cancellable?.disconnect(cancelledId);
    }
}

// Tier 1: per node, its unschedulable flag and every condition as Type=Status.
// jsonpath is evaluated client-side, so what we save here is the payload piped
// back into gnome-shell (~250 B vs the ~120 KB of `-o json`) and the JSON.parse
// that would otherwise run inside the compositor every interval.
const NODES_HEALTH_JSONPATH =
    '{range .items[*]}{.metadata.name}{"\\t"}{.spec.unschedulable}{"\\t"}' +
    '{range .status.conditions[*]}{.type}{"="}{.status}{","}{end}{"\\n"}{end}';

// Tier 2: compact per-pod phase + container waiting reasons — keeps the payload
// tiny even with hundreds of pods.
const PODS_JSONPATH =
    '{range .items[*]}{.status.phase}{"|"}' +
    '{range .status.containerStatuses[*]}{.state.waiting.reason}{","}{end}{"\\n"}{end}';

/**
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<import('./model.js').NodeSummary<import('./model.js').HealthNode>>}
 */
export async function fetchHealth(opts, cancellable) {
    const out = await runKubectl(
        ['get', 'nodes', '-o', `jsonpath=${NODES_HEALTH_JSONPATH}`], opts, cancellable);
    return model.parseHealth(out);
}

/**
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<import('./model.js').NodeSummary<import('./model.js').DetailNode>>}
 */
export async function fetchNodesDetail(opts, cancellable) {
    const out = await runKubectl(['get', 'nodes', '-o', 'json'], opts, cancellable);
    return model.parseNodesDetail(out);
}

/**
 * Per-node live usage from the metrics API (needs metrics-server).
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<Map<string, import('./model.js').MetricsEntry>>}
 */
export async function fetchNodeMetrics(opts, cancellable) {
    const out = await runKubectl(
        ['get', '--raw', '/apis/metrics.k8s.io/v1beta1/nodes'], opts, cancellable);
    return model.parseMetrics(out);
}

/**
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<import('./model.js').PodsSummary>}
 */
export async function fetchPodsSummary(opts, cancellable) {
    const out = await runKubectl(
        ['get', 'pods', '-A', '-o', `jsonpath=${PODS_JSONPATH}`], opts, cancellable);
    return model.parsePods(out);
}

/**
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<string[]>}
 */
export async function fetchContexts(opts, cancellable) {
    const out = await runKubectl(['config', 'get-contexts', '-o', 'name'], opts, cancellable);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
}

/**
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<string>}
 */
export async function fetchCurrentContext(opts, cancellable) {
    try {
        const out = await runKubectl(['config', 'current-context'], opts, cancellable);
        return out.trim();
    } catch {
        return '';
    }
}
