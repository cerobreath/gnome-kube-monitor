// Tests for the pure scheduling math.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {baseDelaySec, backoffDelaySec} from '../lib/schedule.js';

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
