// Fake Extension base class. Mirrors the real contract: getSettings() hands back
// a Gio.Settings for the schema, uuid/path/metadata come from the extension
// directory, and gettext/ngettext/pgettext are instance methods over a catalogue
// -- which is exactly how lib/i18n.js is wired in both real processes.
//
// The catalogue is behavioural rather than an identity stub, so a test can prove
// a bound locale actually reaches the widgets, and that a plural form is chosen
// by the language's own rule rather than by English's n === 1. It is empty by
// default, which leaves every wrapper as the identity and keeps the rest of the
// suite reading in plain English.

import {Settings} from '../gi/Gio.js';

// gettext joins a context to its message id with U+0004, so matching that here
// lets pgettext() be exercised through the same map.
const CONTEXT_GLUE = '\u0004';

export class Extension {
    /** @param {Record<string, any>} [meta] */
    constructor(meta = {}) {
        this.uuid = meta.uuid ?? 'kube-monitor@cerobreath.dev';
        this.path = meta.path ?? '/ext';
        this.metadata = {uuid: this.uuid, ...meta};
        this.__settings = meta.__settings ?? new Settings(meta.__settingsInitial ?? {});
        this.__prefsOpened = 0;
        /**
         * msgid -> translation. A string translates directly; an array holds the
         * plural forms, indexed by __pluralIndex.
         * @type {Record<string, string | string[]>}
         */
        this.__catalog = meta.__catalog ?? {};
        /**
         * The language's plural rule. Defaults to English's two forms; a test can
         * pass Ukrainian's three to check nothing assumes otherwise.
         * @type {(n: number) => number}
         */
        this.__pluralIndex = meta.__pluralIndex ?? (n => (n === 1 ? 0 : 1));
    }

    getSettings() {
        return this.__settings;
    }

    openPreferences() {
        this.__prefsOpened++;
    }

    /** @param {string} str */
    gettext(str) {
        const hit = this.__catalog[str];
        return typeof hit === 'string' ? hit : str;
    }

    /** @param {string} str @param {string} strPlural @param {number} n */
    ngettext(str, strPlural, n) {
        const forms = this.__catalog[str];
        if (Array.isArray(forms))
            return forms[this.__pluralIndex(n)] ?? str;
        return n === 1 ? str : strPlural;
    }

    /** @param {string} context @param {string} str */
    pgettext(context, str) {
        const hit = this.__catalog[context + CONTEXT_GLUE + str];
        return typeof hit === 'string' ? hit : str;
    }
}

export class ExtensionPreferences extends Extension {}

/** @param {string} s */
export const gettext = s => s;
/** @param {string} sing @param {string} plur @param {number} n */
export const ngettext = (sing, plur, n) => (n === 1 ? sing : plur);
/** @param {string} _ctx @param {string} s */
export const pgettext = (_ctx, s) => s;

export default {Extension, ExtensionPreferences, gettext, ngettext, pgettext};
