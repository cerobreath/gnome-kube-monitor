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
