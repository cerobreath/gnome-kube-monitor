// Tests for the translation plumbing: that an unbound process falls back to
// English rather than crashing, and that format() survives a bad catalogue.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    _, ngettext, pgettext, N_, format, bindTranslations, unbindTranslations,
} from '../lib/i18n.js';

// The rest of the suite asserts English literals, so a leaked backend breaks it.
test.afterEach(() => unbindTranslations());

test('unbound, the wrappers are the identity and English picks its own plural', () => {
    unbindTranslations();
    assert.equal(_('Refresh now'), 'Refresh now');
    assert.equal(pgettext('duration', '%dm'), '%dm');
    assert.equal(ngettext('%d node', '%d nodes', 1), '%d node');
    assert.equal(ngettext('%d node', '%d nodes', 2), '%d nodes');
    assert.equal(ngettext('%d node', '%d nodes', 0), '%d nodes');
});

test('N_ marks a string for extraction without translating it', () => {
    // N_ stays a no-op even once a locale is bound: static tables translate at lookup.
    bindTranslations({
        gettext: () => 'translated',
        ngettext: s => s,
        pgettext: (_c, s) => s,
    });
    assert.equal(N_('healthy'), 'healthy');
});

test('bindTranslations routes through the backend, unbindTranslations restores English', () => {
    bindTranslations({
        gettext: str => `[g]${str}`,
        ngettext: (str, plural, n) => `[n${n}]${n === 1 ? str : plural}`,
        pgettext: (context, str) => `[p:${context}]${str}`,
    });
    assert.equal(_('Settings'), '[g]Settings');
    assert.equal(ngettext('%d node', '%d nodes', 3), '[n3]%d nodes');
    assert.equal(pgettext('meter', 'CPU'), '[p:meter]CPU');

    unbindTranslations();
    assert.equal(_('Settings'), 'Settings');
    assert.equal(pgettext('meter', 'CPU'), 'CPU');
});

test('a language with three plural forms selects by its own rule, not English\'s', () => {
    // Ukrainian: 1 -> form 0, 2..4 -> form 1, 5+ and the teens -> form 2. Nothing
    // in the extension may assume the English n === 1 split.
    const forms = ['%d вузол', '%d вузли', '%d вузлів'];
    const index = (/** @type {number} */ n) => {
        if (n % 10 === 1 && n % 100 !== 11)
            return 0;
        if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14))
            return 1;
        return 2;
    };
    bindTranslations({
        gettext: s => s,
        ngettext: (_str, _plural, n) => forms[index(n)],
        pgettext: (_c, s) => s,
    });
    assert.equal(ngettext('%d node', '%d nodes', 1), '%d вузол');
    assert.equal(ngettext('%d node', '%d nodes', 3), '%d вузли');
    assert.equal(ngettext('%d node', '%d nodes', 5), '%d вузлів');
    assert.equal(ngettext('%d node', '%d nodes', 11), '%d вузлів');
    assert.equal(ngettext('%d node', '%d nodes', 21), '%d вузол');
});

test('format substitutes %s and %d in order and passes plain strings through', () => {
    assert.equal(format('%s is down', 'node-a'), 'node-a is down');
    assert.equal(format('… and %d more nodes', 7), '… and 7 more nodes');
    assert.equal(format('%s, %d of %d nodes ready', 'healthy', 2, 3),
        'healthy, 2 of 3 nodes ready');
    assert.equal(format('No nodes'), 'No nodes');
});

test('format writes %% as a literal percent', () => {
    assert.equal(format('CPU %d%%', 87), 'CPU 87%');
    assert.equal(format('100%%'), '100%');
});

test('format honours positional placeholders, so a locale can reorder arguments', () => {
    // The reason positional forms exist at all: the same two arguments, swapped.
    assert.equal(format('%1$s, %2$s, cluster switcher', 'prod', 'expanded'),
        'prod, expanded, cluster switcher');
    assert.equal(format('%2$s ← %1$s', 'a', 'b'), 'b ← a');
    assert.equal(format('%1$s and %1$s again', 'x'), 'x and x again');
});

test('format leaves a placeholder alone when the catalogue asks for an argument that is not there', () => {
    // A translation may carry a stray or renumbered placeholder. Rendering
    // "undefined" into the panel would be worse than showing the placeholder.
    assert.equal(format('%s and %s', 'only-one'), 'only-one and %s');
    assert.equal(format('%3$s', 'a', 'b'), '%3$s');
    assert.equal(format('%0$s', 'a'), '%0$s');   // gettext numbers from 1
    assert.equal(format('%s'), '%s');
});

test('format interpolates falsy arguments rather than treating them as missing', () => {
    assert.equal(format('%d running', 0), '0 running');
    assert.equal(format('[%s]', ''), '[]');
});
