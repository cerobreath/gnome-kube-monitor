// Pure scheduling math for the poll loop. No gi:// imports, so it is
// unit-tested directly (see tests/schedule.test.js). The stateful orchestration
// (timers, watchdog, reentrancy) stays in poller.js and calls into this.

/**
 * Base interval between polls, clamped to a sane floor.
 * @param {number} intervalSec
 * @returns {number}
 */
export function baseDelaySec(intervalSec) {
    return Math.max(2, intervalSec || 2);
}

/**
 * Delay before the next poll given consecutive failures: the base interval
 * while healthy, growing exponentially (with the exponent and result both
 * capped) while the cluster stays unreachable.
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
