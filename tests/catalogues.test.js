// Guards on po/*.po that gettext's own tools cannot express: that translations
// stay inside the printf subset format() implements, keep the whitespace and
// ellipsis a caller depends on, and still fit the columns they sit in. Reads the
// catalogue sources rather than executing anything.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const PO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'po');

/**
 * @typedef {object} Entry
 * @property {string} context
 * @property {string} id
 * @property {string[]} strings
 */

/**
 * A small .po reader: msgctxt/msgid/msgid_plural/msgstr[n] with continuation lines.
 * @param {string} text
 * @returns {Entry[]}
 */
function parsePo(text) {
    /** @type {Entry[]} */
    const entries = [];
    /** @type {Entry | null} */
    let entry = null;
    // msgctxt precedes its msgid, so it is held until the msgid arrives rather
    // than opening an entry of its own; otherwise every context is stripped.
    let pendingContext = '';
    /** @type {'context' | 'id' | 'plural' | 'string' | null} */
    let field = null;

    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const start = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+"(.*)"$/.exec(line);
        if (start) {
            const [, keyword, value] = start;
            if (keyword === 'msgctxt') {
                pendingContext = value;
                field = 'context';
            } else if (keyword === 'msgid') {
                entry = {context: pendingContext, id: value, strings: []};
                pendingContext = '';
                entries.push(entry);
                field = 'id';
            } else if (keyword === 'msgid_plural') {
                field = 'plural';   // the English plural is not checked
            } else {
                entry?.strings.push(value);
                field = 'string';
            }
            continue;
        }
        const cont = /^"(.*)"$/.exec(line);
        if (cont && field) {
            if (field === 'context')
                pendingContext += cont[1];
            else if (field === 'id' && entry)
                entry.id += cont[1];
            else if (field === 'string' && entry)
                entry.strings[entry.strings.length - 1] += cont[1];
            continue;
        }
        if (!line)
            field = null;
    }
    // The header is msgid ""; it is metadata, not a message.
    return entries.filter(e => e.id !== '');
}

const CATALOGUES = readdirSync(PO_DIR)
    .filter(name => name.endsWith('.po'))
    .sort()
    .map(name => ({
        lang: name.slice(0, -3),
        entries: parsePo(readFileSync(join(PO_DIR, name), 'utf8')),
    }));

/** @param {(lang: string, entry: Entry, str: string) => string | null} check */
function sweep(check) {
    /** @type {string[]} */
    const problems = [];
    for (const {lang, entries} of CATALOGUES) {
        for (const entry of entries) {
            for (const str of entry.strings) {
                if (!str)
                    continue;
                const complaint = check(lang, entry, str);
                if (complaint)
                    problems.push(`${lang}: ${complaint}`);
            }
        }
    }
    return problems;
}

test('the catalogues are found and non-trivial', () => {
    assert.ok(CATALOGUES.length >= 16, `only found ${CATALOGUES.length} catalogues`);
    for (const {lang, entries} of CATALOGUES)
        assert.ok(entries.length > 90, `${lang} parsed as only ${entries.length} entries`);
});

test('translations use only the printf subset lib/i18n.js implements', () => {
    // format() knows %s, %d, %% and the positional %N$s / %N$d. Anything else
    // (%i, %f, a bare trailing %) reaches the panel as literal punctuation.
    const KNOWN = /%(?:\d+\$)?[%sd]/g;
    const problems = sweep((_lang, entry, str) => {
        const leftovers = str.replace(KNOWN, '');
        return leftovers.includes('%')
            ? `"${entry.id}" -> "${str}" uses a conversion format() cannot render`
            : null;
    });
    assert.deepEqual(problems, []);
});

test('translations keep the leading and trailing whitespace of their message', () => {
    // Several messages are concatenated with a neighbour ("%s  (missing)"), so a
    // trimmed or padded translation silently changes the spacing at the seam.
    const edges = (/** @type {string} */ s) =>
        [s.length - s.trimStart().length, s.length - s.trimEnd().length].join(':');
    const problems = sweep((_lang, entry, str) =>
        edges(entry.id) !== edges(str)
            ? `"${entry.id}" -> "${str}" changes the surrounding whitespace`
            : null);
    assert.deepEqual(problems, []);
});

test('an ellipsis in the message survives translation', () => {
    // The ellipsis says "this continues" or "this opens a dialog", not decoration.
    const problems = sweep((_lang, entry, str) =>
        entry.id.endsWith('…') !== str.endsWith('…')
            ? `"${entry.id}" -> "${str}" gains or loses its ellipsis`
            : null);
    assert.deepEqual(problems, []);
});

test('the meter labels still fit the column they sit in', () => {
    // .kube-meter-label is a 30px column shared by CPU and MEM on every node row;
    // a long translation pushes the meters out of alignment across the menu.
    const problems = sweep((_lang, entry, str) =>
        entry.context === 'meter' && str.length > 4
            ? `meter label "${str}" is ${str.length} characters, over the 4 the column allows`
            : null);
    assert.deepEqual(problems, []);
});

test('the duration abbreviations stay abbreviations', () => {
    // They share a node row with the node name and are reused by the "updated N
    // ago" label and the mute countdown, so they must stay tiny and keep %d.
    const problems = sweep((_lang, entry, str) => {
        if (entry.context !== 'duration')
            return null;
        if (!/%d/.test(str))
            return `duration "${entry.id}" -> "${str}" lost its number`;
        return str.length > 8
            ? `duration "${str}" is ${str.length} characters, too long for the row`
            : null;
    });
    assert.deepEqual(problems, []);
});
