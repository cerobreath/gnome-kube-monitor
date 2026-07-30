// Fake Extension base class. Mirrors the real contract: getSettings() hands back
// a Gio.Settings for the schema, and uuid/path/metadata come from the extension
// directory. Also carries the gettext exports so a future i18n pass resolves.

import {Settings} from '../gi/Gio.js';

export class Extension {
    /** @param {Record<string, any>} [meta] */
    constructor(meta = {}) {
        this.uuid = meta.uuid ?? 'kube-monitor@cerobreath.dev';
        this.path = meta.path ?? '/ext';
        this.metadata = {uuid: this.uuid, ...meta};
        this.__settings = meta.__settings ?? new Settings(meta.__settingsInitial ?? {});
        this.__prefsOpened = 0;
    }

    getSettings() {
        return this.__settings;
    }

    openPreferences() {
        this.__prefsOpened++;
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
