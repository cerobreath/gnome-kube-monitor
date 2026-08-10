// Poll cadence math. Kept gi-free so it runs under node; the timers and
// watchdog that use it live in poller.js.

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
