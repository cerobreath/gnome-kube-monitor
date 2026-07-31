// Translation plumbing: the one place that knows how a locale reaches the code.
//
// Gi-free on purpose, like model.js / alerts.js / schedule.js. The wording lives
// beside the logic it belongs to (and beside its tests), but those modules must
// not import gnome-shell's gettext: model.js is also loaded by prefs.js in a
// separate process, and by node in the test suite. So each process *injects* its
// own gettext here once at start-up and everything else calls these wrappers.
//
// Both injected backends are the extension object itself: ExtensionBase exposes
// gettext/ngettext/pgettext as instance methods bound to the domain from
// metadata.json. That is deliberately not the module-level `gettext` exported by
// resource:///org/gnome/shell/extensions/extension.js, which resolves the domain
// by walking an Error stack for a path under /gnome-shell/extensions/ -- the
// instance methods skip that guesswork entirely.
//
// Until something binds a backend the wrappers are the identity. That keeps the
// unit tests reading in plain English, and means a mis-ordered start-up degrades
// to untranslated text instead of throwing.

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
 * Point the wrappers at a real gettext. Called once per process: from the
 * extension's enable() and from prefs' fillPreferencesWindow(), in both cases
 * with the Extension / ExtensionPreferences instance itself.
 * @param {TranslationBackend} impl
 */
export function bindTranslations(impl) {
    backend = impl;
}

/**
 * Drop the backend. disable() calls this so a torn-down extension object is not
 * kept alive by module state across a lock/unlock cycle.
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
 * Translate a string, choosing the plural form for `n`. Never assume two forms:
 * the catalogues here range from one (ja, ko, zh) to six (ar).
 * @param {string} str        singular (English) form
 * @param {string} strPlural  plural (English) form
 * @param {number} n
 * @returns {string}
 */
export function ngettext(str, strPlural, n) {
    return backend.ngettext(str, strPlural, n);
}

/**
 * Translate a string that needs disambiguating for translators -- our duration
 * abbreviations ("5m") in particular, which are otherwise indistinguishable
 * from a unit of anything else.
 * @param {string} context
 * @param {string} str
 * @returns {string}
 */
export function pgettext(context, str) {
    return backend.pgettext(context, str);
}

/**
 * Mark a string for extraction without translating it yet -- the standard
 * gettext N_() idiom. Static tables (model.js's error headlines, indicator.js's
 * spoken severity words) are built at module load, long before a locale is
 * bound, so they store the English source and pass it through _() at lookup.
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
 * Interpolate a translated string.
 *
 * This exists instead of String.prototype.format because that method is not a
 * language feature: gnome-shell's ui/environment.js installs it from
 * imports.format, and the preferences process (org.gnome.Shell.Extensions) does
 * not -- so a `.format()` call in any code prefs.js reaches would throw there,
 * and throw again under node in the tests.
 *
 * A placeholder whose argument is missing is left as-is rather than rendered as
 * "undefined". Catalogues are external input: a translation may carry a stray or
 * renumbered placeholder, and that must degrade visibly, not crash the shell.
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
