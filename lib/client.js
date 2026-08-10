// The only file that spawns kubectl; parsing is delegated to model.js. Each
// fetch* takes (opts, cancellable), opts = {kubectlPath, kubeconfig, context}.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as model from './model.js';

/**
 * @typedef {object} Opts
 * @property {string} kubectlPath  Explicit kubectl binary, or '' to look it up on PATH.
 * @property {string} kubeconfig   Explicit kubeconfig path, or '' for the default.
 * @property {string} context      kubectl context, or '' for the current one.
 */

// Promisify lazily on first use rather than at module load, so importing this
// file has no side effects (EGO review forbids mutating state at initialization).
let _promisified = false;
function ensurePromisified() {
    if (_promisified)
        return;
    Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
    _promisified = true;
}

/**
 * gnome-shell has a trimmed PATH and no KUBECONFIG, so the environment kubectl
 * runs with is built explicitly.
 * @param {string} kubeconfig
 * @returns {string[]}
 */
function buildEnviron(kubeconfig) {
    // Allowlist, not gnome-shell's whole environment: the shell inherits the
    // systemd --user env (SSH_AUTH_SOCK, GNOME_KEYRING_CONTROL, anything
    // environment.d set) and kubectl hands its env to exec credential plugins.
    const KEEP = [
        'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
        'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
        'KUBECONFIG', 'KUBECACHEDIR',
        // Proxy + TLS trust: omitting these silently breaks corporate setups.
        'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
        'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
        // Cloud exec plugins read these to find their own config/credentials.
        'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONFIG_FILE',
        'AWS_SHARED_CREDENTIALS_FILE', 'AWS_SDK_LOAD_CONFIG',
        'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS',
        'AZURE_CONFIG_DIR',
    ];
    const inherited = GLib.get_environ();
    /** @type {string[]} */
    let environ = [];
    for (const key of KEEP) {
        const value = GLib.environ_getenv(inherited, key);
        if (value !== null && value !== undefined)
            environ = GLib.environ_setenv(environ, key, value, true);
    }

    const current = GLib.environ_getenv(environ, 'PATH') ?? '';
    const parts = current ? current.split(':') : [];
    // Common install locations across distros, so auto-detect finds kubectl and
    // its exec auth plugins (krew installs oidc-login into ~/.krew/bin).
    const home = GLib.get_home_dir();
    const extra = [
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/snap/bin',
        GLib.build_filenamev([home, '.local', 'bin']),
        GLib.build_filenamev([home, '.krew', 'bin']),
    ];
    for (const p of extra) {
        if (!parts.includes(p))
            parts.push(p);
    }
    environ = GLib.environ_setenv(environ, 'PATH', parts.join(':'), true);

    if (kubeconfig)
        environ = GLib.environ_setenv(environ, 'KUBECONFIG', kubeconfig, true);

    // Background polling must never pop up a window, and OIDC exec plugins open a
    // browser once their cached token expires. xdg-open honours BROWSER, where
    // true is a no-op; unsetting the display is the backstop.
    environ = GLib.environ_setenv(environ, 'BROWSER', 'true', true);
    environ = GLib.environ_unsetenv(environ, 'DISPLAY');
    environ = GLib.environ_unsetenv(environ, 'WAYLAND_DISPLAY');

    return environ;
}

/**
 * Pick the kubectl binary. An explicit setting wins only if it is an absolute
 * path to an executable file: dconf has no per-key ACL, so any same-UID process
 * can write the key.
 * @param {string} kubectlPath
 * @returns {string}
 */
function resolveKubectl(kubectlPath) {
    if (kubectlPath && isUsableProgram(kubectlPath))
        return kubectlPath;
    return GLib.find_program_in_path('kubectl') ?? 'kubectl';
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isUsableProgram(path) {
    if (!GLib.path_is_absolute(path))
        return false;
    const file = Gio.File.new_for_path(path);
    try {
        const info = file.query_info(
            'standard::type,access::can-execute', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_file_type() === Gio.FileType.REGULAR &&
            info.get_attribute_boolean('access::can-execute');
    } catch {
        return false;   // missing, unreadable, or not a real file
    }
}

/**
 * @param {string[]} extraArgv
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<string>}
 */
async function runKubectl(extraArgv, {kubectlPath, kubeconfig, context}, cancellable) {
    ensurePromisified();
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_environ(buildEnviron(kubeconfig));

    // Every call carries --request-timeout, so a stalled API server cannot
    // outlive the poll interval.
    const argv = [resolveKubectl(kubectlPath), '--request-timeout=5s'];
    // Single --flag=value element rather than two: a context name is free text
    // from settings, and this form cannot be re-read as a flag.
    if (context)
        argv.push(`--context=${context}`);
    argv.push(...extraArgv);

    const proc = launcher.spawnv(argv);

    // Cancelling a poll must kill the child too: an exec auth plugin blocked from
    // opening a browser (see buildEnviron) would otherwise linger.
    // Gio.Cancellable.connect takes the callback directly, not a signal name.
    let cancelledId = 0;
    if (cancellable)
        cancelledId = cancellable.connect(() => proc.force_exit());

    try {
        // @girs types the async form as callback-based, so the resolved tuple
        // needs an explicit shape.
        const [stdout, stderr] = /** @type {[string, string]} */ (
            await proc.communicate_utf8_async(null, cancellable ?? null));

        if (!proc.get_successful()) {
            // Whatever kubectl said, verbatim: classifyError renders it as the
            // error detail, which is never translated. An empty message gives the
            // generic headline with no detail, as the watchdog path does.
            throw new Error((stderr || stdout || '').trim());
        }
        return stdout ?? '';
    } finally {
        if (cancelledId)
            cancellable?.disconnect(cancelledId);
    }
}

// Tier 1: per node, its unschedulable flag and every condition as Type=Status.
// jsonpath holds the payload to ~250 B against the ~120 KB of -o json, and keeps
// that JSON.parse out of the compositor on every interval.
const NODES_HEALTH_JSONPATH =
    '{range .items[*]}{.metadata.name}{"\\t"}{.spec.unschedulable}{"\\t"}' +
    '{range .status.conditions[*]}{.type}{"="}{.status}{","}{end}{"\\n"}{end}';

// Tier 2: per-pod phase and container waiting reasons; small at hundreds of pods.
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
