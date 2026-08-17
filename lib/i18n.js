// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Translation plumbing, kept gi-free so model.js and alerts.js can carry their
// own wording without importing gnome-shell's gettext. Each process injects a
// backend once at start-up: the Extension / ExtensionPreferences instance, whose
// gettext methods take the domain from metadata.json. Unbound it is the identity.

/**
 * @typedef {object} TranslationBackend
 * @property {(str: string) => string} gettext
 * @property {(str: string, strPlural: string, n: number) => string} ngettext
 * @property {(context: string, str: string) => string} pgettext
 */

/** @type {TranslationBackend} */
const IDENTITY = {
    gettext: str => str,
    ngettext: (str, strPlural, n) => (n === 1 ? str : strPlural),
    pgettext: (_context, str) => str,
};

/** @type {TranslationBackend} */
let backend = IDENTITY;

/**
 * Point the wrappers at a real gettext. Called once per process.
 * @param {TranslationBackend} impl
 */
export function bindTranslations(impl) {
    backend = impl;
}

/**
 * Drop the backend so a torn-down extension is not kept alive by module state.
 */
export function unbindTranslations() {
    backend = IDENTITY;
}

/**
 * Translate a string.
 * @param {string} str
 * @returns {string}
 */
export function _(str) {
    return backend.gettext(str);
}

/**
 * Translate a string, choosing the plural form for n.
 * @param {string} str        singular (English) form
 * @param {string} strPlural  plural (English) form
 * @param {number} n
 * @returns {string}
 */
export function ngettext(str, strPlural, n) {
    return backend.ngettext(str, strPlural, n);
}

/**
 * Translate a string that needs a context to disambiguate it for translators.
 * @param {string} context
 * @param {string} str
 * @returns {string}
 */
export function pgettext(context, str) {
    return backend.pgettext(context, str);
}

/**
 * Mark a string for extraction, for tables built before any locale is bound.
 * @param {string} str
 * @returns {string}
 */
export function N_(str) {
    return str;
}

// %s / %d, plus the positional %1$s form translators need when a language wants
// the arguments in a different order. %% is a literal percent.
const PLACEHOLDER = /%(?:(\d+)\$)?([%sd])/g;

/**
 * Interpolate a translated string. Stands in for String.prototype.format, which
 * gnome-shell installs in its own process only, not in prefs or under node.
 * A placeholder with no matching argument is left as-is.
 * @param {string} template
 * @param {...(string | number)} args
 * @returns {string}
 */
export function format(template, ...args) {
    let next = 0;
    return template.replace(PLACEHOLDER, (match, position, conversion) => {
        if (conversion === '%')
            return '%';
        const value = args[position ? Number(position) - 1 : next++];
        return value === undefined ? match : String(value);
    });
}
