// Fake ExtensionPreferences base for the prefs process. Same getSettings()
// contract as the shell-side Extension, and the gettext exports a future i18n
// pass will reach for.

export {ExtensionPreferences, gettext, ngettext, pgettext} from './extension.js';
