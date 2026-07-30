// Fake Gtk for the prefs process: widgets carry their properties and record
// signal handlers, and Gtk.FileDialog is scriptable so both the "picked a file"
// and "dismissed the dialog" paths can be driven.

import {Emitter} from '../actor.js';

export const Align = {FILL: 0, START: 1, END: 2, CENTER: 3, BASELINE: 4};

class Widget extends Emitter {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super();
        this.sensitive = true;
        this.visible = true;
        Object.assign(this, params);
    }

    /** @param {string} text */
    set_tooltip_text(text) {
        this.tooltip_text = text;
    }
}

export class Adjustment extends Widget {}
export class Image extends Widget {}
export class Button extends Widget {}
export class Label extends Widget {}
export class Box extends Widget {}

export class StringList extends Widget {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super(params);
        /** @type {string[]} */
        this.__items = [...(params.strings ?? [])];
    }

    get_n_items() {
        return this.__items.length;
    }

    /** @param {number} pos @param {number} nRemovals @param {string[]} additions */
    splice(pos, nRemovals, additions) {
        this.__items.splice(pos, nRemovals, ...(additions ?? []));
    }

    /** @param {number} i */
    get_string(i) {
        return this.__items[i];
    }
}

/** @type {{path?: string, dismissed?: boolean, nullFile?: boolean}} */
let dialogResult = {dismissed: true};

/** @param {{path?: string, dismissed?: boolean, nullFile?: boolean}} r */
export function __setFileDialogResult(r) {
    dialogResult = r;
}

export class FileDialog extends Widget {
    /**
     * @param {any} _parent @param {any} _cancellable
     * @param {(source: any, res: any) => void} cb
     */
    open(_parent, _cancellable, cb) {
        this.__opened = true;
        cb(this, {});
    }

    open_finish() {
        if (dialogResult.dismissed)
            throw new Error('Dismissed by user');
        if (dialogResult.nullFile)
            return null;          // not a documented outcome; prefs guards anyway
        return {get_path: () => dialogResult.path ?? ''};
    }
}

export default {
    Align, Adjustment, Image, Button, Label, Box, StringList, FileDialog,
    __setFileDialogResult,
};
