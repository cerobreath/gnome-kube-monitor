// Fake GLib whose clock only moves when a test advances it, so timer-driven code
// can be asserted without sleeping.

export const PRIORITY_DEFAULT = 0;
export const PRIORITY_LOW = 300;
export const SOURCE_REMOVE = false;
export const SOURCE_CONTINUE = true;
export const TIME_SPAN_SECOND = 1_000_000;   // microseconds, as in real GLib

let nowMs = 0;
let nextId = 1;
/** @type {{id: number, at: number, cb: () => boolean}[]} */
let timers = [];
let home = '/home/tester';
/** @type {Record<string, string | null>} */
let programs = {kubectl: '/usr/bin/kubectl'};
/** @type {string[]} */
let baseEnviron = ['PATH=/usr/bin:/bin', 'HOME=/home/tester', 'LANG=C'];

// Control surface (tests only)

export function __reset() {
    nowMs = 0;
    nextId = 1;
    timers = [];
    home = '/home/tester';
    programs = {kubectl: '/usr/bin/kubectl'};
    baseEnviron = ['PATH=/usr/bin:/bin', 'HOME=/home/tester', 'LANG=C'];
    extraEnv = {};
    existingFiles = new Set(['/home/tester/.kube/config']);
}

/** @param {string[]} env */
export function __setEnviron(env) {
    baseEnviron = [...env];
}

/** @param {Record<string, string | null>} map */
export function __setPrograms(map) {
    programs = {...map};
}

export function __now() {
    return nowMs;
}

/**
 * Move the clock without running any timers, for code that only reads the time.
 * @param {number} ms
 */
export function __setClock(ms) {
    nowMs = ms;
}

export function __pendingTimers() {
    return timers.length;
}

/**
 * Advance the clock, firing every timer that comes due in time order. Production
 * code always returns SOURCE_REMOVE and re-schedules explicitly.
 * @param {number} ms
 */
export async function __advance(ms) {
    const target = nowMs + ms;
    for (;;) {
        const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due)
            break;
        timers = timers.filter(t => t !== due);
        nowMs = due.at;
        const again = due.cb();
        if (again === SOURCE_CONTINUE)
            timers.push({...due, at: nowMs + (due.at - nowMs || 1)});
        // Let the callback's promise continuations settle before the next timer.
        await Promise.resolve();
        await new Promise(r => setImmediate(r));
    }
    nowMs = target;
}

/** Drain queued microtasks/IO without moving the clock. */
export async function __settle() {
    for (let i = 0; i < 5; i++)
        await new Promise(r => setImmediate(r));
}

// GLib surface

/** @param {number} _prio @param {number} ms @param {() => boolean} cb */
export function timeout_add(_prio, ms, cb) {
    const id = nextId++;
    timers.push({id, at: nowMs + ms, cb});
    return id;
}

/** @param {number} _prio @param {number} s @param {() => boolean} cb */
export function timeout_add_seconds(_prio, s, cb) {
    return timeout_add(_prio, s * 1000, cb);
}

/** @param {number} id */
export function source_remove(id) {
    const had = timers.some(t => t.id === id);
    timers = timers.filter(t => t.id !== id);
    if (!had)
        throw new Error(`source_remove: no such source ${id}`);   // mirrors GLib's warning
    return true;
}

export function get_monotonic_time() {
    return nowMs * 1000;
}

export function get_environ() {
    return [...baseEnviron];
}

/** @param {string[]} env @param {string} key */
export function environ_getenv(env, key) {
    const hit = env.find(e => e.startsWith(`${key}=`));
    return hit === undefined ? null : hit.slice(key.length + 1);
}

/** @param {string[]} env @param {string} key @param {string} value */
export function environ_setenv(env, key, value) {
    return [...env.filter(e => !e.startsWith(`${key}=`)), `${key}=${value}`];
}

/** @param {string[]} env @param {string} key */
export function environ_unsetenv(env, key) {
    return env.filter(e => !e.startsWith(`${key}=`));
}

/** @param {string} name */
export function find_program_in_path(name) {
    return programs[name] ?? null;
}

export function get_home_dir() {
    return home;
}

/** @param {string[]} parts */
export function build_filenamev(parts) {
    return parts.join('/');
}

/** @param {string} p */
export function path_is_absolute(p) {
    return p.startsWith('/');
}

export const FileTest = {EXISTS: 1, IS_REGULAR: 2, IS_DIR: 4, IS_EXECUTABLE: 8};

/** @type {Record<string, string>} */
let extraEnv = {};
/** @type {Set<string>} */
let existingFiles = new Set(['/home/tester/.kube/config']);

/** @param {Record<string, string>} map */
export function __setGetenv(map) {
    extraEnv = {...map};
}

/** @param {string[]} paths */
export function __setExistingFiles(paths) {
    existingFiles = new Set(paths);
}

/** @param {string} name */
export function getenv(name) {
    return extraEnv[name] ?? environ_getenv(baseEnviron, name);
}

/** @param {string} path @param {number} _test */
export function file_test(path, _test) {
    return existingFiles.has(path);
}

/** @param {string} p */
export function path_get_basename(p) {
    return p.split('/').filter(Boolean).pop() ?? p;
}

export default {
    PRIORITY_DEFAULT, PRIORITY_LOW, SOURCE_REMOVE, SOURCE_CONTINUE, TIME_SPAN_SECOND,
    timeout_add, timeout_add_seconds, source_remove, get_monotonic_time,
    get_environ, environ_getenv, environ_setenv, environ_unsetenv,
    find_program_in_path, get_home_dir, build_filenamev, path_is_absolute, path_get_basename,
    FileTest, getenv, file_test,
    __reset, __setEnviron, __setPrograms, __now, __setClock, __advance, __settle,
    __pendingTimers, __setGetenv, __setExistingFiles,
};
