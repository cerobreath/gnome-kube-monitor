// Guards on assets nothing here executes: stylesheet.css, which gnome-shell
// parses, and the icon names GTK resolves at runtime. St's CSS subset has no
// logical properties while StBoxLayout reverses its children under RTL, hence
// the :ltr / :rtl split.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'stylesheet.css'), 'utf8');

// Physical properties meaning "the left/right edge", which have to be stated per
// direction. Shorthands (margin: a b) are symmetric across the axis.
const DIRECTIONAL = /(?:^|[\s;{])(margin|padding|border)-(left|right)\b|(?:^|[\s;{])(left|right)\s*:/;

/** @returns {{selector: string, body: string}[]} */
function rules() {
    const out = [];
    // Strip comments first: they contain the words the regexes match.
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
    // A fill spanning a whole block marks nothing, so only the rows highlight;
    // deleting a per-row fill leaves that control with no mouse affordance.
    for (const selector of ['.kube-context-row:hover', '.kube-context-button:hover',
        '.kube-icon-button:hover']) {
        const rule = rules().find(r => r.selector === selector);
        assert.ok(rule, `${selector} is missing, so that control would be silent under the pointer`);
        assert.match(rule.body, /background-color:/);
    }
});

test('the meter track width still matches METER_WIDTH in indicator.js', () => {
    // A constant duplicated across a file the tests execute and one they do not.
    const css = /\.kube-meter-track\s*\{[^}]*width:\s*(\d+)px/.exec(CSS);
    const js = /const METER_WIDTH = (\d+);/
        .exec(readFileSync(join(ROOT, 'lib', 'indicator.js'), 'utf8'));
    assert.ok(css && js, 'both declarations must be findable');
    assert.equal(css[1], js[1]);
});

// Adwaita and gtk4's built-in gresource are the only icon sources an extension
// can count on. emblem-ok-symbolic looks plausible, ships only with Breeze, and
// rendered as the missing-icon placeholder in the preferences window until this
// caught it. Verify a new name against both before adding it here.
const ICONS = new Set([
    'content-loading-symbolic',
    'dialog-warning-symbolic',
    'list-add-symbolic',
    'notifications-disabled-symbolic',
    'object-select-symbolic',
    'pan-down-symbolic',
    'pan-end-symbolic',
    'preferences-system-symbolic',
    'user-trash-symbolic',
    'view-refresh-symbolic',
]);

test('every symbolic icon name is one Adwaita or gtk4 actually carries', () => {
    const files = ['prefs.js', 'extension.js',
        ...readdirSync(join(ROOT, 'lib')).filter(f => f.endsWith('.js')).map(f => join('lib', f))];
    let seen = 0;
    for (const rel of files) {
        for (const [, name] of readFileSync(join(ROOT, rel), 'utf8').matchAll(/'([a-z0-9-]+-symbolic)'/g)) {
            seen++;
            assert.ok(ICONS.has(name),
                `${rel} uses ${name}, which is not in the verified icon list`);
        }
    }
    assert.ok(seen >= 9, 'the icon scan found almost nothing, so the regex has drifted');
});
