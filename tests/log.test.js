// Tests for diagnostic logging: silent unless enabled, and it cannot put
// credential material in the shared journal even if a caller is careless.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {debug, setDebugEnabled, isDebugEnabled, setLogSink} from '../lib/log.js';

/** Capture what would reach the journal. */
function capture() {
    /** @type {string[]} */
    const lines = [];
    setLogSink((...args) => lines.push(args.join(' ')));
    return lines;
}

test('logging is silent until it is switched on', () => {
    const lines = capture();
    setDebugEnabled(false);
    assert.equal(isDebugEnabled(), false);
    debug('poll', 'this must not be logged');
    assert.deepEqual(lines, []);

    setDebugEnabled(true);
    assert.equal(isDebugEnabled(), true);
    debug('poll', 'now it should');
    assert.equal(lines.length, 1);
    setDebugEnabled(false);
    setLogSink(null);
});

test('a line carries the extension prefix, a topic and key=value fields', () => {
    const lines = capture();
    setDebugEnabled(true);
    debug('poll', 'ok', {tier: 'health', nodes: 3, ready: 2});
    assert.equal(lines[0], '[kube-monitor] poll: ok tier=health nodes=3 ready=2');
    setDebugEnabled(false);
    setLogSink(null);
});

test('field values of every shape are rendered readably', () => {
    const lines = capture();
    setDebugEnabled(true);
    debug('alert', 'shapes', {
        arr: ['fire:a', 'resolve:b'],
        obj: {a: 1},
        nil: null,
        undef: undefined,
        bool: false,
        num: 0,
    });
    assert.match(lines[0], /arr=fire:a,resolve:b/);
    assert.match(lines[0], /obj=\{"a":1\}/);
    assert.match(lines[0], /nil=null/);
    assert.match(lines[0], /undef=undefined/);
    assert.match(lines[0], /bool=false/);
    assert.match(lines[0], /num=0/);
    setDebugEnabled(false);
    setLogSink(null);
});

test('no fields at all is fine', () => {
    const lines = capture();
    setDebugEnabled(true);
    debug('poll', 'bare');
    assert.equal(lines[0], '[kube-monitor] poll: bare');
    setDebugEnabled(false);
    setLogSink(null);
});

test('credential material cannot reach the journal, even if a caller passes it', () => {
    const lines = capture();
    setDebugEnabled(true);
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJl';
    debug('poll', `failed with id_token ${jwt}`, {
        url: 'https://sts.amazonaws.com/?X-Amz-Security-Token=FQoDYXdzEBYaD',
        header: `Authorization: Bearer ${jwt}`,
    });
    const line = lines[0];
    assert.ok(!line.includes(jwt), line);
    assert.ok(!line.includes('FQoDYXdzEBYaD'), line);
    assert.match(line, /redacted/);
    setDebugEnabled(false);
    setLogSink(null);
});

test('a long line is capped so one message cannot flood the journal', () => {
    const lines = capture();
    setDebugEnabled(true);
    debug('poll', 'x'.repeat(1000));
    assert.ok(lines[0].length < 400, `got ${lines[0].length} chars`);
    assert.match(lines[0], /…$/);
    setDebugEnabled(false);
    setLogSink(null);
});

test('newlines are collapsed, so one event stays one journal line', () => {
    const lines = capture();
    setDebugEnabled(true);
    debug('poll', 'first\nsecond\n\nthird');
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes('\n'));
    setDebugEnabled(false);
    setLogSink(null);
});

test('the default sink is console.log, which the journal actually shows', () => {
    // Not console.debug: GLib's default writer drops LEVEL_DEBUG unless
    // G_MESSAGES_DEBUG is set on the process, which a running gnome-shell cannot
    // do. Not warn/error either: those are recorded whether asked for or not.
    const original = console.log;
    /** @type {string[]} */
    const seen = [];
    setLogSink(null);                 // restore the production sink
    console.log = (...args) => seen.push(args.join(' '));
    try {
        setDebugEnabled(true);
        debug('poll', 'through console.log');
        assert.equal(seen.length, 1);
        assert.match(seen[0], /through console\.log/);
    } finally {
        console.log = original;
        setDebugEnabled(false);
    }
});
