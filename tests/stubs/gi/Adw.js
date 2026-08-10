// Fake Adw rows, groups and pages, recording the properties prefs.js sets and
// keeping an ordered child list.

import {Emitter} from '../actor.js';

class Row extends Emitter {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super();
        this.title = '';
        this.subtitle = '';
        this.use_markup = undefined;
        /** @type {any[]} */
        this.__suffixes = [];
        Object.assign(this, params);
    }

    /** @param {any} w */
    add_suffix(w) {
        this.__suffixes.push(w);
    }

    /** @param {any} w */
    add_prefix(w) {
        this.__suffixes.push(w);
    }
}

export class ActionRow extends Row {}
export class EntryRow extends Row {}
export class SwitchRow extends Row {}
export class SpinRow extends Row {}

export class ComboRow extends Row {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super(params);
        this.__selected = 0;
    }

    get selected() {
        return this.__selected;
    }

    /** @param {number} v */
    set selected(v) {
        this.__selected = v;
        this.emit('notify::selected');
    }
}

export class ExpanderRow extends Row {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super(params);
        /** @type {any[]} */
        this.__rows = [];
    }

    /** @param {any} row */
    add_row(row) {
        this.__rows.push(row);
    }

    /** @param {any} row */
    remove(row) {
        this.__rows = this.__rows.filter(r => r !== row);
    }
}

export class PreferencesGroup extends Row {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super(params);
        /** @type {any[]} */
        this.__children = [];
    }

    /** @param {any} row */
    add(row) {
        this.__children.push(row);
    }

    /** @param {any} row */
    remove(row) {
        this.__children = this.__children.filter(r => r !== row);
    }
}

export class PreferencesPage extends Row {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super(params);
        /** @type {any[]} */
        this.__groups = [];
    }

    /** @param {any} group */
    add(group) {
        this.__groups.push(group);
    }
}

export class Toast extends Row {}

/** Stands in for the Adw.PreferencesWindow handed to fillPreferencesWindow. */
export class PreferencesWindow extends Emitter {
    constructor() {
        super();
        /** @type {any[]} */
        this.__pages = [];
        /** @type {Toast[]} */
        this.__toasts = [];
    }

    /** @param {any} page */
    add(page) {
        this.__pages.push(page);
    }

    /** @param {Toast} toast */
    add_toast(toast) {
        this.__toasts.push(toast);
    }
}

export default {
    ActionRow, EntryRow, SwitchRow, SpinRow, ComboRow, ExpanderRow,
    PreferencesGroup, PreferencesPage, PreferencesWindow, Toast,
};
