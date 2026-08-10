// Fake Gio: a scriptable subprocess, a Cancellable, a filesystem probe and
// GSettings, so the kubectl edge is assertable without spawning anything.

export const IOErrorEnum = {CANCELLED: 19, FAILED: 0, NOT_FOUND: 1};

export const SubprocessFlags = {
    STDOUT_PIPE: 1 << 0,
    STDERR_PIPE: 1 << 1,
    STDIN_PIPE: 1 << 2,
};

export const FileType = {REGULAR: 1, DIRECTORY: 2, SYMBOLIC_LINK: 3, UNKNOWN: 0};
export const FileQueryInfoFlags = {NONE: 0, NOFOLLOW_SYMLINKS: 1};
export const SettingsBindFlags = {DEFAULT: 0, GET: 1, SET: 2, NO_SENSITIVITY: 4};

/** A GError-alike: production code identifies cancellation via .matches(). */
export class GioError extends Error {
    /** @param {string} message @param {object} domain @param {number} code */
    constructor(message, domain, code) {
        super(message);
        this._domain = domain;
        this._code = code;
    }

    /** @param {object} domain @param {number} code */
    matches(domain, code) {
        return this._domain === domain && this._code === code;
    }
}

export class Cancellable {
    constructor() {
        this._cancelled = false;
        /** @type {Map<number, () => void>} */
        this._handlers = new Map();
        this._nextId = 1;
    }

    is_cancelled() {
        return this._cancelled;
    }

    cancel() {
        if (this._cancelled)
            return;
        this._cancelled = true;
        for (const cb of [...this._handlers.values()])
            cb();
    }

    // g_cancellable_connect: invokes immediately and returns 0 when already
    // cancelled, which is why callers must guard their disconnect on the id.
    /** @param {() => void} cb */
    connect(cb) {
        if (this._cancelled) {
            cb();
            return 0;
        }
        const id = this._nextId++;
        this._handlers.set(id, cb);
        return id;
    }

    /** @param {number} id */
    disconnect(id) {
        this._handlers.delete(id);
    }
}

// Scriptable subprocess

/**
 * @typedef {object} SpawnResult
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {boolean} [ok]       exit status; defaults true
 * @property {boolean} [hang]     never resolve until cancelled (watchdog tests)
 * @property {boolean} [defer]    resolve only when __release() is called, so a
 *                                test can land a poll after stop()
 * @property {Error} [throws]     reject instead of resolving
 */

/** @type {(call: {argv: string[], environ: string[]}) => SpawnResult} */
let spawnHandler = () => ({stdout: '', stderr: '', ok: true});
/** @type {{argv: string[], environ: string[]}[]} */
let calls = [];
let killed = 0;
/** @type {(() => void)[]} */
let deferred = [];

/** Complete every deferred call, so a test chooses when a poll lands. */
export function __release() {
    const pending = deferred;
    deferred = [];
    for (const settle of pending)
        settle();
}

export function __pendingSpawns() {
    return deferred.length;
}

/** @param {(call: {argv: string[], environ: string[]}) => SpawnResult} fn */
export function __setSpawn(fn) {
    spawnHandler = fn;
}

export function __calls() {
    return calls.map(c => ({argv: [...c.argv], environ: [...c.environ]}));
}

export function __lastCall() {
    return calls.length ? calls[calls.length - 1] : null;
}

export function __killCount() {
    return killed;
}

export function __reset() {
    spawnHandler = () => ({stdout: '', stderr: '', ok: true});
    calls = [];
    killed = 0;
    deferred = [];
    files = {'/usr/bin/kubectl': {type: FileType.REGULAR, executable: true}};
    networkMonitor = new FakeNetworkMonitor();
}

export class Subprocess {
    /** @param {string[]} argv @param {string[]} environ */
    constructor(argv, environ) {
        this._argv = argv;
        this._environ = environ;
        this._result = spawnHandler({argv, environ}) ?? {};
        this._exited = false;
        this._completed = false;
    }

    // Latched at completion, not derived from _exited: killing an already-finished
    // process must not retroactively turn its success into a failure.
    get_successful() {
        return this._completed && this._result.ok !== false;
    }

    force_exit() {
        killed++;
        this._exited = true;
        this._onKill?.();
    }

    /**
     * Promisified in real GJS; the stub returns the Promise directly.
     * @param {unknown} _stdin
     * @param {Cancellable | null} cancellable
     * @returns {Promise<[string, string]>}
     */
    communicate_utf8_async(_stdin, cancellable) {
        const r = this._result;
        return new Promise((resolve, reject) => {
            const fail = () => reject(
                new GioError('Operation was cancelled', IOErrorEnum, IOErrorEnum.CANCELLED));
            if (cancellable?.is_cancelled()) {
                fail();
                return;
            }
            this._onKill = fail;
            if (r.hang)
                return;                       // resolves only via force_exit()
            // stdout: null is passed through, so client.js's ?? '' guard is tested.
            const finish = () => {
                if (r.throws) {
                    reject(r.throws);
                    return;
                }
                this._completed = true;
                resolve([r.stdout === undefined ? '' : r.stdout, r.stderr ?? '']);
            };
            if (r.defer) {
                deferred.push(finish);
                return;
            }
            finish();
        });
    }
}

export class SubprocessLauncher {
    /** @param {{flags?: number}} [params] */
    constructor(params = {}) {
        this.flags = params.flags ?? 0;
        /** @type {string[]} */
        this._environ = [];
    }

    /** @param {string[]} env */
    set_environ(env) {
        this._environ = [...env];
    }

    /** @param {string[]} argv */
    spawnv(argv) {
        calls.push({argv: [...argv], environ: [...this._environ]});
        return new Subprocess(argv, this._environ);
    }
}

// Filesystem probe

/** @type {Record<string, {type?: number, executable?: boolean} | undefined>} */
let files = {'/usr/bin/kubectl': {type: FileType.REGULAR, executable: true}};

/** @param {Record<string, {type?: number, executable?: boolean} | undefined>} map */
export function __setFiles(map) {
    files = {...map};
}

export const File = {
    /** @param {string} path */
    new_for_path(path) {
        return {
            query_info() {
                const f = files[path];
                if (!f)
                    throw new GioError('No such file', IOErrorEnum, IOErrorEnum.NOT_FOUND);
                return {
                    get_file_type: () => f.type ?? FileType.UNKNOWN,
                    /** @param {string} attr */
                    get_attribute_boolean: attr =>
                        attr === 'access::can-execute' ? f.executable === true : false,
                };
            },
        };
    },
};

export function _promisify() {
    // No-op: Subprocess.communicate_utf8_async already returns a Promise here.
}

// Network monitor: a process-wide singleton like the real one, with a switch a
// test flips to change availability and emit network-changed.
class FakeNetworkMonitor {
    constructor() {
        this.network_available = true;
        /** @type {Map<number, {name: string, cb: (...a: any[]) => void}>} */
        this._handlers = new Map();
        this._nextId = 1;
    }

    /** @param {string} name @param {(...a: any[]) => void} cb */
    connect(name, cb) {
        const id = this._nextId++;
        this._handlers.set(id, {name, cb});
        return id;
    }

    /** @param {number} id */
    disconnect(id) {
        if (!this._handlers.has(id))
            throw new Error(`NetworkMonitor.disconnect: no handler ${id}`);
        this._handlers.delete(id);
    }

    __handlerCount() {
        return this._handlers.size;
    }

    /** @param {boolean} available */
    __setAvailable(available) {
        this.network_available = available;
        for (const h of [...this._handlers.values()]) {
            if (h.name === 'network-changed')
                h.cb(this, available);
        }
    }
}

let networkMonitor = new FakeNetworkMonitor();

export const NetworkMonitor = {
    get_default: () => networkMonitor,
};

export function __networkMonitor() {
    return networkMonitor;
}

export function icon_new_for_string(/** @type {string} */ str) {
    return {__gicon: str, to_string: () => str};
}

export default {
    IOErrorEnum, SubprocessFlags, FileType, FileQueryInfoFlags, SettingsBindFlags,
    Cancellable, Subprocess, SubprocessLauncher, File, GioError, NetworkMonitor,
    _promisify, icon_new_for_string,
    __setSpawn, __calls, __lastCall, __killCount, __setFiles, __reset,
    __release, __pendingSpawns, __networkMonitor,
    get Settings() {
        return Settings;
    },
};

// GSettings

/**
 * Fake Gio.Settings backed by a plain map. Defaults mirror the real gschema, and
 * every write emits changed and changed::key exactly as dconf does.
 */
export class Settings {
    /** @param {Record<string, any>} [initial] */
    constructor(initial = {}) {
        /** @type {Record<string, any>} */
        this._values = {
            'refresh-interval': 10,
            'notify-node-changes': true,
            'notify-cluster-unreachable': true,
            'notify-on-recovery': true,
            'alert-node-for': 30,
            'alert-cluster-for': 120,
            'alert-keep-firing-for': 60,
            'alert-repeat-interval': 0,
            'alert-group-wait': 0,
            'alert-silence-until': 0,
            'debug-logging': false,
            'alert-state': '',
            'context': '',
            'kubeconfig-path': '',
            'kubectl-path': '',
            ...initial,
        };
        /** @type {Map<number, {name: string, cb: (...a: any[]) => void}>} */
        this._handlers = new Map();
        this._nextId = 1;
        /** @type {string[]} */
        this.writes = [];
    }

    /** @param {string} key */
    _get(key) {
        if (!(key in this._values))
            throw new Error(`Settings: unknown key "${key}" (not in the schema)`);
        return this._values[key];
    }

    /** @param {string} key @param {any} value */
    _set(key, value) {
        this._get(key);                  // reject keys the schema doesn't define
        this.writes.push(key);
        if (this._values[key] === value)
            return;                      // dconf coalesces no-op writes
        this._values[key] = value;
        this.emit('changed', key);
    }

    /** @param {string} key */
    get_string(key) {
        return String(this._get(key));
    }

    /** @param {string} key @param {string} v */
    set_string(key, v) {
        this._set(key, v);
    }

    /** @param {string} key */
    get_boolean(key) {
        return Boolean(this._get(key));
    }

    /** @param {string} key @param {boolean} v */
    set_boolean(key, v) {
        this._set(key, v);
    }

    /** @param {string} key */
    get_int(key) {
        return Number(this._get(key));
    }

    /** @param {string} key @param {number} v */
    set_int(key, v) {
        this._set(key, v);
    }

    /** @param {string} key */
    get_int64(key) {
        return Number(this._get(key));
    }

    /** @param {string} key @param {number} v */
    set_int64(key, v) {
        this._set(key, v);
    }

    /** @param {string} name @param {(...a: any[]) => void} cb */
    connect(name, cb) {
        const id = this._nextId++;
        this._handlers.set(id, {name, cb});
        return id;
    }

    /** @param {number} id */
    disconnect(id) {
        if (!this._handlers.has(id))
            throw new Error(`Settings.disconnect: no handler ${id}`);
        this._handlers.delete(id);
    }

    /** @param {string} name @param {any[]} args */
    emit(name, ...args) {
        for (const h of [...this._handlers.values()]) {
            if (h.name === name || h.name === `${name}::${args[0]}`)
                h.cb(this, ...args);
        }
    }

    /** Widget binding used by prefs; records the pairing for assertions. */
    bind(key, object, property, _flags) {
        this._get(key);
        object[property] = this._values[key];
        this.__bindings = this.__bindings ?? [];
        this.__bindings.push({key, property});
    }

    __handlerCount() {
        return this._handlers.size;
    }
}
