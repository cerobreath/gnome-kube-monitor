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
    Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
    _promisified = true;
}

/**
 * gnome-shell has a trimmed PATH and no KUBECONFIG, so the environment kubectl
 * runs with is built explicitly.
 * @param {string} kubeconfig
 * @returns {string[]}
 */
function buildEnviron(kubeconfig) {
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
 * path to an executable file.
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
 * @param {string} kubeconfig
 * @returns {Gio.SubprocessLauncher}
 */
function makeLauncher(kubeconfig) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    launcher.set_environ(buildEnviron(kubeconfig));
    return launcher;
}

/**
 * @param {string[]} extraArgv
 * @param {Opts} opts
 * @param {string} requestTimeout  '' omits the flag (a watch must outlive it)
 * @returns {string[]}
 */
function buildArgv(extraArgv, {kubectlPath, context}, requestTimeout) {
    const argv = [resolveKubectl(kubectlPath)];
    if (requestTimeout)
        argv.push(`--request-timeout=${requestTimeout}`);
    // Single --flag=value element rather than two: a context name is free text
    // from settings, and this form cannot be re-read as a flag.
    if (context)
        argv.push(`--context=${context}`);
    argv.push(...extraArgv);
    return argv;
}

/**
 * @param {string[]} extraArgv
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<string>}
 */
async function runKubectl(extraArgv, opts, cancellable) {
    ensurePromisified();
    // Every poll carries --request-timeout, so a stalled API server cannot
    // outlive the poll interval. The watch omits it: the same flag cleanly
    // terminates a watch when it expires.
    const proc = makeLauncher(opts.kubeconfig).spawnv(buildArgv(extraArgv, opts, '5s'));

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

// Tier 1 fallback, used until the watch delivers and whenever it cannot.
// jsonpath keeps stdout near 250 B and the JSON.parse out of the compositor, but
// the request still pulls whole node objects. Cost measured in docs/architecture.md.
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
 * Cheap cross-check of the watch: the default table is printed server-side.
 * @param {Opts} opts
 * @param {Gio.Cancellable | null} [cancellable]
 * @returns {Promise<import('./model.js').TableRow[]>}
 */
export async function fetchHealthTable(opts, cancellable) {
    const out = await runKubectl(['get', 'nodes', '--no-headers'], opts, cancellable);
    return model.parseNodesTable(out);
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

// Watch tier, shaped by two kubectl 1.35 quirks: {range} is broken on watch
// events, so conditions come as two zipped lists, and the watch printer pads
// "\t" into spaces, so fields are split on "|" (impossible in any cell).
const NODES_WATCH_JSONPATH =
    '{.type}{"|"}{.object.metadata.name}{"|"}{.object.spec.unschedulable}{"|"}' +
    '{.object.status.conditions[*].type}{"|"}{.object.status.conditions[*].status}{"\\n"}';

// Enough stderr for classifyError's summary line without hoarding klog spew.
const STDERR_TAIL_MAX = 4096;

/**
 * @param {string} tail
 * @param {string} line
 * @returns {string}
 */
function appendTail(tail, line) {
    const joined = tail ? `${tail}\n${line}` : line;
    return joined.length > STDERR_TAIL_MAX ? joined.slice(-STDERR_TAIL_MAX) : joined;
}

/**
 * @typedef {object} WatchExitInfo
 * @property {boolean} ok  exit status; a server-closed watch exits 0
 * @property {string} detail  stderr tail for classifyError, never for the log
 * @property {number} lifetimeMs
 */

/**
 * One long-lived kubectl watch child. Lines reach onLine as they stream; every
 * termination reaches onExit exactly once unless stop() silenced it.
 */
export class NodeWatcher {
    /**
     * @param {Opts} opts
     * @param {{onLine: (line: string) => void,
     *          onExit: (info: WatchExitInfo) => void}} callbacks
     */
    constructor(opts, callbacks) {
        this._opts = opts;
        this._callbacks = callbacks;
        this._cancellable = new Gio.Cancellable();
        /** @type {Gio.Subprocess | null} */
        this._proc = null;
        this._stopped = false;
        this._finished = false;
        this._startedUs = 0;
    }

    start() {
        ensurePromisified();
        this._startedUs = GLib.get_monotonic_time();
        const argv = buildArgv(
            ['get', 'nodes', '--watch', '--output-watch-events',
                '-o', `jsonpath=${NODES_WATCH_JSONPATH}`],
            this._opts, '');
        try {
            this._proc = makeLauncher(this._opts.kubeconfig).spawnv(argv);
        } catch (e) {
            // Report through the normal exit path, but asynchronously, so the
            // caller never re-enters its own spawn logic mid-start().
            const detail = e instanceof Error ? e.message : String(e);
            Promise.resolve().then(() => this._finish(false, detail));
            return;
        }
        // A cancelled watch must kill the child too, as runKubectl does.
        this._cancellable.connect(() => this._proc?.force_exit());
        this._run(this._proc);
    }

    /** Silences onExit and kills the child; safe to call more than once. */
    stop() {
        this._stopped = true;
        this._cancellable.cancel();
    }

    /**
     * @param {Gio.Subprocess} proc
     */
    async _run(proc) {
        let detail = '';
        try {
            const stdoutStream = /** @type {Gio.InputStream} */ (proc.get_stdout_pipe());
            const stderrStream = /** @type {Gio.InputStream} */ (proc.get_stderr_pipe());
            await Promise.all([
                this._readLines(stdoutStream, line => this._callbacks.onLine(line)),
                this._readLines(stderrStream, line => {
                    detail = appendTail(detail, line);
                }),
            ]);
            await proc.wait_async(this._cancellable);
            this._finish(proc.get_successful(), detail);
        } catch (e) {
            // stop() unwinds here as CANCELLED and stays silent via _finish's
            // guard; a real stream failure reports like an abnormal exit. The
            // cancel kills the child and the sibling stream either way.
            this._cancellable.cancel();
            this._finish(false, detail || (e instanceof Error ? e.message : String(e)));
        }
    }

    /**
     * @param {Gio.InputStream} base
     * @param {(line: string) => void} onLine
     */
    async _readLines(base, onLine) {
        const stream = new Gio.DataInputStream({
            base_stream: base,
            close_base_stream: true,
        });
        for (;;) {
            // Explicit callback form on purpose: gnome-shell already promisifies
            // read_line_async with the byte-array finisher and Gio._promisify
            // refuses to re-wrap, so awaiting it there would yield Uint8Arrays.
            const line = await new Promise((resolve, reject) => {
                stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                    (_s, res) => {
                        try {
                            const [read] = stream.read_line_finish_utf8(res);
                            resolve(read);
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            if (line === null)
                return;
            onLine(line);
        }
    }

    /**
     * @param {boolean} ok
     * @param {string} detail
     */
    _finish(ok, detail) {
        if (this._stopped || this._finished)
            return;
        this._finished = true;
        const lifetimeMs = (GLib.get_monotonic_time() - this._startedUs) / 1000;
        this._callbacks.onExit({ok, detail: detail.trim(), lifetimeMs});
    }
}
