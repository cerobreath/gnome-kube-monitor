// Fake Extension base class: getSettings() hands back a Gio.Settings, and
// gettext/ngettext/pgettext are instance methods over a catalogue that is empty
// by default, so the suite reads in plain English unless a test supplies one.

import {Settings} from '../gi/Gio.js';

// gettext joins a context to its message id with U+0004.
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
         * msgid -> translation; an array holds the plural forms.
         * @type {Record<string, string | string[]>}
         */
        this.__catalog = meta.__catalog ?? {};
        /**
         * The language's plural rule; defaults to English's two forms.
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
