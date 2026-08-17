// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Opt-in diagnostic logging, off unless the debug-logging key is set. Uses
// console.log (GLib LEVEL_MESSAGE), not console.debug: GLib's default writer
// discards LEVEL_DEBUG unless G_MESSAGES_DEBUG is set on the process. Raw
// kubectl output is never logged, since its stderr can carry credentials.

import {redactForLog} from './model.js';

const PREFIX = '[kube-monitor]';

let enabled = false;

/**
 * The production sink.
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
 * Strip anything credential-shaped and cap the length before the journal sees it.
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
    const clean = redactForLog(String(s)).replace(/\s+/g, ' ');
    return clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
}
