// Opt-in diagnostic logging.
//
// Everything here is off unless the user turns on `debug-logging`, because the
// GNOME guidance is explicit that logged messages land in the system journal and
// excessive logging makes debugging *other* applications harder. When it is on,
// the point is to answer "why did (or didn't) I get a notification?" without
// attaching a debugger to the compositor.
//
// Two rules this module exists to enforce:
//
//   1. One level, and never warn/error: those are recorded unconditionally, which
//      is what "keep logging to a minimum" rules out. We use `console.log`
//      (GLib LEVEL_MESSAGE) rather than `console.debug` (LEVEL_DEBUG) because
//      GLib's default log writer *discards* LEVEL_DEBUG unless G_MESSAGES_DEBUG
//      is set on the process -- measured in a nested shell: with console.debug
//      the journal showed nothing, and only `G_MESSAGES_DEBUG=all gnome-shell`
//      revealed the lines. You cannot set an env var on the gnome-shell a user
//      is already running, so a troubleshooting switch that needs one produces
//      no output at all. Being off by default is what keeps the journal quiet.
//   2. **Never log raw kubectl output.** Its stderr can carry credential material
//      from an exec plugin (see classifyError/redactSecrets in model.js), and the
//      journal is readable and long-lived. Callers pass already-classified or
//      already-redacted strings; `sanitize()` is the belt-and-braces backstop.
//
// gi-free on purpose, so it is unit-tested directly.

import {redactForLog} from './model.js';

const PREFIX = '[kube-monitor]';

let enabled = false;

/**
 * The production sink. See the note above on why this is console.log
 * (LEVEL_MESSAGE) and not console.debug.
 * @param {unknown[]} args
 */
function consoleSink(...args) {
    console.log(...args);
}

/** @type {(...args: unknown[]) => void} */
let sink = consoleSink;

/**
 * @param {boolean} on
 */
export function setDebugEnabled(on) {
    enabled = Boolean(on);
}

export function isDebugEnabled() {
    return enabled;
}

/**
 * Swap the output sink. Tests use this; production never calls it.
 * @param {((...args: unknown[]) => void) | null} fn  null restores the console sink
 */
export function setLogSink(fn) {
    sink = fn ?? consoleSink;
}

/**
 * Log one diagnostic line. Silent unless debug logging is enabled.
 * @param {string} topic  short area tag, e.g. 'poll' or 'alert'
 * @param {string} message
 * @param {Record<string, unknown>} [fields]  appended as key=value pairs
 */
export function debug(topic, message, fields) {
    if (!enabled)
        return;
    const parts = [`${PREFIX} ${topic}: ${sanitize(message)}`];
    for (const [key, value] of Object.entries(fields ?? {}))
        parts.push(`${key}=${sanitize(format(value))}`);
    sink(parts.join(' '));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function format(value) {
    if (value === null || value === undefined)
        return String(value);
    if (Array.isArray(value))
        return value.map(format).join(',');
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
}

/**
 * Last line of defence: strip anything credential-shaped and cap the length, so
 * a careless caller cannot put a token in the journal.
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
    const clean = redactForLog(String(s)).replace(/\s+/g, ' ');
    return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}
