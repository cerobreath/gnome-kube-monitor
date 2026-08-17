// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Poll cadence math. Kept gi-free so it runs under node; the timers and
// watchdog that use it live in poller.js.

// Ceiling for backoff: the longest a recovered cluster can stay shown as
// down, and the largest legitimate poll gap, which the alert machine's
// settle threshold keys off.
export const MAX_BACKOFF_SECONDS = 60;

/**
 * Base interval between polls, clamped to a 2 second minimum.
 * @param {number} intervalSec
 * @returns {number}
 */
export function baseDelaySec(intervalSec) {
    return Math.max(2, intervalSec || 2);
}

/**
 * Delay before the next poll: the base interval while healthy, growing
 * exponentially (exponent and result both capped) while the cluster is down.
 * @param {number} failures  consecutive failed polls (0 = the last poll succeeded)
 * @param {number} baseSec
 * @param {number} maxSec
 * @returns {number}
 */
export function backoffDelaySec(failures, baseSec, maxSec) {
    if (failures <= 0)
        return baseSec;
    const exp = Math.min(failures, 6);   // cap so 2**exp can't blow up
    return Math.min(maxSec, baseSec * (2 ** exp));
}

// Watch cadence: the node watch replaces health polling once it has proven
// itself; these govern when it is respawned, distrusted, and cross-checked.
export const WATCH_STABLE_SECONDS = 60;
export const WATCH_MAX_QUICK_DEATHS = 3;
export const WATCH_RETRY_SECONDS = 300;
export const WATCH_RESPAWN_BASE_SECONDS = 2;
export const WATCH_STARTUP_SECONDS = 30;
export const RECONCILE_SECONDS = 300;
export const WATCH_QUIET_MS = 250;
export const WATCH_MAX_COALESCE_MS = 1500;

/**
 * Turn one watch exit into a respawn plan: a long-lived stream respawns at
 * once, short-lived ones back off, and a run of them parks behind a slow retry.
 * @param {number} lifetimeSec  how long the exited watch process lived
 * @param {number} priorQuickDeaths  consecutive short-lived exits before this one
 * @returns {{quickDeaths: number, delaySec: number}}
 */
export function classifyWatchExit(lifetimeSec, priorQuickDeaths) {
    if (lifetimeSec >= WATCH_STABLE_SECONDS)
        return {quickDeaths: 0, delaySec: 0};
    const quickDeaths = Math.min(priorQuickDeaths + 1, WATCH_MAX_QUICK_DEATHS);
    if (quickDeaths >= WATCH_MAX_QUICK_DEATHS)
        return {quickDeaths, delaySec: WATCH_RETRY_SECONDS};
    return {
        quickDeaths,
        delaySec: backoffDelaySec(quickDeaths, WATCH_RESPAWN_BASE_SECONDS, MAX_BACKOFF_SECONDS),
    };
}

/**
 * Delay until a coalesced watch snapshot may flush: 0 once the quiet window or
 * the ceiling is reached (a busy stream must not defer forever), else the wait.
 * @param {number} nowMs
 * @param {number} firstPendingMs  when the oldest unflushed event arrived
 * @param {number} lastEventMs  when the newest event arrived
 * @returns {number}
 */
export function flushDelayMs(nowMs, firstPendingMs, lastEventMs) {
    const sinceFirst = nowMs - firstPendingMs;
    const sinceLast = nowMs - lastEventMs;
    if (sinceFirst >= WATCH_MAX_COALESCE_MS || sinceLast >= WATCH_QUIET_MS)
        return 0;
    return Math.min(WATCH_QUIET_MS - sinceLast, WATCH_MAX_COALESCE_MS - sinceFirst);
}
