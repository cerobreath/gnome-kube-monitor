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
 * @property {boolean} [stream]   stay open; the test drives __pushLine/__exit
 * @property {Error} [spawnThrows]  spawnv itself throws (missing binary)
 */

/**
 * One pipe of a streaming subprocess: lines a test pushes come out of
 * read_line_async in order, null after __end, cancellation rejects.
 */
class FakeLineStream {
    constructor() {
        /** @type {string[]} */
        this._buf = [];
        this._eof = false;
        /** @type {{resolve: (v: [string | null, number]) => void,
         *          reject: (e: Error) => void} | null} */
        this._waiter = null;
    }

    /** @param {string} line */
    __push(line) {
        const w = this._waiter;
        if (w) {
            this._waiter = null;
            w.resolve([line, line.length]);
        } else {
            this._buf.push(line);
        }
    }

    __end() {
        this._eof = true;
        const w = this._waiter;
        if (w) {
            this._waiter = null;
            w.resolve([null, 0]);
        }
    }

    /** Fail the stream: the pending (or next) read rejects. @param {Error} err */
    __fail(err) {
        this._err = err;
        const w = this._waiter;
        if (w) {
            this._waiter = null;
            w.reject(err);
        }
    }

    /**
     * @param {number} _prio
     * @param {Cancellable | null} cancellable
     * @returns {Promise<[string | null, number]>}
     */
    read_line_async(_prio, cancellable) {
        return new Promise((resolve, reject) => {
            const fail = () => reject(
                new GioError('Operation was cancelled', IOErrorEnum, IOErrorEnum.CANCELLED));
            if (cancellable?.is_cancelled()) {
                fail();
                return;
            }
            const line = this._buf.shift();
            if (line !== undefined) {
                resolve([line, line.length]);
                return;
            }
            if (this._err) {
                reject(this._err);
                return;
            }
            if (this._eof) {
                resolve([null, 0]);
                return;
            }
            this._waiter = {resolve, reject};
            cancellable?.connect(() => {
                if (this._waiter) {
                    this._waiter = null;
                    fail();
                }
            });
        });
    }
}

/**
 * Real code reads its pipes callback-style (gnome-shell pre-promisifies
 * read_line_async with the byte finisher); the fake keeps that split.
 */
export class DataInputStream {
    /** @param {{base_stream: FakeLineStream, close_base_stream?: boolean}} params */
    constructor(params) {
        this._base = params.base_stream;
    }

    /**
     * @param {number} prio
     * @param {Cancellable | null} cancellable
     * @param {(s: DataInputStream, res: unknown) => void} callback
     */
    read_line_async(prio, cancellable, callback) {
        this._base.read_line_async(prio, cancellable).then(
            tuple => callback(this, {ok: true, tuple}),
            err => callback(this, {ok: false, err}));
    }

    /** @param {any} res */
    read_line_finish_utf8(res) {
        if (!res.ok)
            throw res.err;
        return res.tuple;
    }
}

/** @type {(call: {argv: string[], environ: string[]}) => SpawnResult} */
let spawnHandler = () => ({stdout: '', stderr: '', ok: true});
/** @type {{argv: string[], environ: string[]}[]} */
let calls = [];
let killed = 0;
/** @type {(() => void)[]} */
let deferred = [];
/** @type {Subprocess[]} */
let streamProcs = [];

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
    streamProcs = [];
    files = {'/usr/bin/kubectl': {type: FileType.REGULAR, executable: true}};
    networkMonitor = new FakeNetworkMonitor();
}

/** Streaming subprocesses (SpawnResult.stream), oldest first. */
export function __streamProcs() {
    return [...streamProcs];
}

export function __lastStreamProc() {
    return streamProcs.length ? streamProcs[streamProcs.length - 1] : null;
}

export class Subprocess {
    /** @param {string[]} argv @param {string[]} environ */
    constructor(argv, environ) {
        this._argv = argv;
        this._environ = environ;
        this._result = spawnHandler({argv, environ}) ?? {};
        this._exited = false;
        this._completed = false;
        this._forceFailed = false;
        this._stdout = new FakeLineStream();
        this._stderr = new FakeLineStream();
        /** @type {{resolve: (v: boolean) => void, reject: (e: Error) => void}[]} */
        this._exitWaiters = [];
        if (this._result.spawnThrows) {
            // spawnv throws before anyone can read this instance.
        } else if (this._result.stream) {
            streamProcs.push(this);
        } else if (!this._result.hang) {
            // Scripted one-shot results also work through the streaming API:
            // stdout arrives as lines, both pipes EOF, and the wait resolves.
            for (const line of (this._result.stdout ?? '').split('\n'))
                if (line !== '')
                    this._stdout.__push(line);
            for (const line of (this._result.stderr ?? '').split('\n'))
                if (line !== '')
                    this._stderr.__push(line);
            this._completed = true;
            this._stdout.__end();
            this._stderr.__end();
        }
    }

    // Latched at completion, not derived from _exited: killing an already-finished
    // process must not retroactively turn its success into a failure.
    get_successful() {
        return this._completed && this._result.ok !== false && !this._forceFailed;
    }

    force_exit() {
        killed++;
        this._exited = true;
        this._onKill?.();
        if (!this._completed)
            this._forceFailed = true;
        this._completed = true;
        this._stdout.__end();
        this._stderr.__end();
        this._settleExit();
    }

    get_stdout_pipe() {
        return this._stdout;
    }

    get_stderr_pipe() {
        return this._stderr;
    }

    /** Test control: push a stdout line into a streaming subprocess. @param {string} line */
    __pushLine(line) {
        this._stdout.__push(line);
    }

    /** @param {string} line */
    __pushErr(line) {
        this._stderr.__push(line);
    }

    /** Test control: fail the stdout stream mid-read. @param {Error} err */
    __failOut(err) {
        this._stdout.__fail(err);
    }

    /** Test control: end a streaming subprocess like the real child exiting. @param {{ok?: boolean}} [opts] */
    __exit(opts = {}) {
        this._result = {...this._result, ok: opts.ok !== false};
        this._completed = true;
        this._stdout.__end();
        this._stderr.__end();
        this._settleExit();
    }

    _settleExit() {
        const waiters = this._exitWaiters;
        this._exitWaiters = [];
        for (const w of waiters)
            w.resolve(true);
    }

    /**
     * @param {Cancellable | null} cancellable
     * @returns {Promise<boolean>}
     */
    wait_async(cancellable) {
        return new Promise((resolve, reject) => {
            const fail = () => reject(
                new GioError('Operation was cancelled', IOErrorEnum, IOErrorEnum.CANCELLED));
            if (cancellable?.is_cancelled()) {
                fail();
                return;
            }
            if (this._completed || this._exited) {
                resolve(true);
                return;
            }
            const waiter = {resolve, reject};
            this._exitWaiters.push(waiter);
            cancellable?.connect(() => {
                if (this._exitWaiters.includes(waiter)) {
                    this._exitWaiters = this._exitWaiters.filter(w => w !== waiter);
                    fail();
                }
            });
        });
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
        const proc = new Subprocess(argv, this._environ);
        if (proc._result.spawnThrows)
            throw proc._result.spawnThrows;
        return proc;
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
    Cancellable, Subprocess, SubprocessLauncher, DataInputStream, File, GioError,
    NetworkMonitor, _promisify, icon_new_for_string,
    __setSpawn, __calls, __lastCall, __killCount, __setFiles, __reset,
    __release, __pendingSpawns, __networkMonitor, __streamProcs, __lastStreamProc,
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
