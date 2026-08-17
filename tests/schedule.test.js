// Tests for the pure scheduling math.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    baseDelaySec, backoffDelaySec, classifyWatchExit, flushDelayMs,
    WATCH_MAX_COALESCE_MS, WATCH_QUIET_MS, WATCH_RETRY_SECONDS, WATCH_STABLE_SECONDS,
} from '../lib/schedule.js';

test('baseDelaySec clamps to a 2s floor', () => {
    assert.equal(baseDelaySec(10), 10);
    assert.equal(baseDelaySec(2), 2);
    assert.equal(baseDelaySec(1), 2);
    assert.equal(baseDelaySec(0), 2);      // 0 || 2 → 2
});

test('backoffDelaySec returns the base interval while healthy', () => {
    assert.equal(backoffDelaySec(0, 10, 300), 10);
});

test('backoffDelaySec grows exponentially then caps at maxSec', () => {
    assert.equal(backoffDelaySec(1, 10, 300), 20);
    assert.equal(backoffDelaySec(2, 10, 300), 40);
    assert.equal(backoffDelaySec(3, 10, 300), 80);
    assert.equal(backoffDelaySec(4, 10, 300), 160);
    assert.equal(backoffDelaySec(5, 10, 300), 300);   // 320 → capped to 300
    assert.equal(backoffDelaySec(6, 10, 300), 300);
});

test('backoffDelaySec caps the exponent so huge failure counts stay bounded', () => {
    // exponent capped at 6 → 2 * 2**6 = 128, under the 1000 ceiling
    assert.equal(backoffDelaySec(100, 2, 1000), 128);
    assert.equal(backoffDelaySec(100, 10, 300), 300);
});

test('classifyWatchExit: a stable stream respawns at once and forgives history', () => {
    assert.deepEqual(classifyWatchExit(WATCH_STABLE_SECONDS, 2), {quickDeaths: 0, delaySec: 0});
    assert.deepEqual(classifyWatchExit(3600, 0), {quickDeaths: 0, delaySec: 0});
});

test('classifyWatchExit: quick deaths back off, then park behind the slow retry', () => {
    // WATCH_RESPAWN_BASE_SECONDS = 2, so backoff gives 2 * 2**n.
    assert.deepEqual(classifyWatchExit(1, 0), {quickDeaths: 1, delaySec: 4});
    assert.deepEqual(classifyWatchExit(1, 1), {quickDeaths: 2, delaySec: 8});
    assert.deepEqual(classifyWatchExit(1, 2), {quickDeaths: 3, delaySec: WATCH_RETRY_SECONDS});
    // Further quick deaths stay parked rather than growing the counter.
    assert.deepEqual(classifyWatchExit(59, 3), {quickDeaths: 3, delaySec: WATCH_RETRY_SECONDS});
});

test('flushDelayMs: flushes on the quiet window or the ceiling', () => {
    // Quiet window reached: last event WATCH_QUIET_MS ago.
    assert.equal(flushDelayMs(1000, 900, 1000 - WATCH_QUIET_MS), 0);
    // Ceiling reached: first pending event WATCH_MAX_COALESCE_MS ago.
    assert.equal(flushDelayMs(2000, 2000 - WATCH_MAX_COALESCE_MS, 1999), 0);
});

test('flushDelayMs: mid-burst it returns the sooner of the two deadlines', () => {
    // Fresh event: quiet expires in 200ms, ceiling in 1400ms -> 200.
    assert.equal(flushDelayMs(1100, 1000, 1050), 200);
    // Old burst: quiet expires in 240ms but the ceiling in 100ms -> 100.
    assert.equal(flushDelayMs(2400, 1000, 2390), 100);
});
