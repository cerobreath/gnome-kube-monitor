// Guards on stylesheet.css that no JavaScript test can express, because the file
// is never executed here -- gnome-shell parses it.
//
// The one that matters is right-to-left. St's CSS subset has no logical
// properties (gnome-shell's own theme uses the :ltr / :rtl pseudo-classes in 28
// places and margin-inline-* in none), while StBoxLayout *does* reverse its
// children under RTL. A bare `margin-left` therefore keeps pushing right in
// Arabic, where the neighbour it was meant to clear has moved to the other side.
// Nothing in the suite would notice, so this checks the source directly.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'stylesheet.css'), 'utf8');

// Physical properties that mean "the left/right edge" and so have to be stated
// per direction. Shorthands (`margin: a b`) are symmetric across the axis and
// are fine as they are.
const DIRECTIONAL = /(?:^|[\s;{])(margin|padding|border)-(left|right)\b|(?:^|[\s;{])(left|right)\s*:/;

/** @returns {{selector: string, body: string}[]} */
function rules() {
    const out = [];
    // Comments first: they contain the words we grep for.
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
        out.push({selector: m[1].trim(), body: m[2]});
    return out;
}

test('no direction-sensitive property escapes an :ltr / :rtl selector', () => {
    const offenders = rules()
        .filter(r => DIRECTIONAL.test(r.body))
        .filter(r => !/:(ltr|rtl)\b/.test(r.selector))
        .map(r => r.selector);
    assert.deepEqual(offenders, [],
        'these rules would land on the wrong side in Arabic; split them into ' +
        '`:ltr` and `:rtl` the way gnome-shell\'s own theme does');
});

test('every :ltr rule has an :rtl counterpart, and the other way round', () => {
    /** @param {string} pseudo */
    const bases = pseudo => rules()
        .filter(r => r.selector.includes(`:${pseudo}`))
        .map(r => r.selector.replaceAll(`:${pseudo}`, ''))
        .sort();
    const ltr = bases('ltr');
    const rtl = bases('rtl');
    assert.ok(ltr.length > 0, 'the guard is worthless if nothing declares a direction');
    assert.deepEqual(ltr, rtl, 'a one-sided direction rule silently drops the spacing');
});

test('every row a pointer can land on still says so', () => {
    // The container's highlight was removed because a fill that spans a whole
    // block marks nothing; the per-row fills are the ones that do the work, and
    // deleting one leaves that control with no mouse affordance at all.
    for (const selector of ['.kube-context-row:hover', '.kube-context-button:hover',
        '.kube-icon-button:hover']) {
        const rule = rules().find(r => r.selector === selector);
        assert.ok(rule, `${selector} is missing — that control would be silent under the pointer`);
        assert.match(rule.body, /background-color:/);
    }
});

test('the meter track width still matches METER_WIDTH in indicator.js', () => {
    // Not an i18n concern, but the same class of defect: a constant duplicated
    // across a file the tests do execute and one they do not.
    const css = /\.kube-meter-track\s*\{[^}]*width:\s*(\d+)px/.exec(CSS);
    const js = /const METER_WIDTH = (\d+);/
        .exec(readFileSync(join(ROOT, 'lib', 'indicator.js'), 'utf8'));
    assert.ok(css && js, 'both declarations must be findable');
    assert.equal(css[1], js[1]);
});
