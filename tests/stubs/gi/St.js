// Fake St widgets on the shared Actor base, plus a recording clipboard.

import {Actor} from '../actor.js';

export {Actor};

export class Widget extends Actor {}
export class Bin extends Actor {}
export class BoxLayout extends Actor {}
export class Label extends Actor {}
export class Icon extends Actor {}
export class ScrollView extends Actor {}

export class Button extends Actor {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super(params);
        if (params.child)
            this.add_child(params.child);
    }

    /** @param {Actor} child */
    set_child(child) {
        super.set_child(child);
        this.child = child;
    }
}

export const ClipboardType = {PRIMARY: 0, CLIPBOARD: 1};

/** @type {{type: number, text: string}[]} */
let clipboardWrites = [];

export const Clipboard = {
    get_default() {
        return {
            /** @param {number} type @param {string} text */
            set_text(type, text) {
                clipboardWrites.push({type, text});
            },
        };
    },
};

export function __clipboard() {
    return [...clipboardWrites];
}

export function __resetClipboard() {
    clipboardWrites = [];
}

export class ThemeContext {
    static get_for_stage() {
        return {get_theme: () => ({load_stylesheet() {}, unload_stylesheet() {}})};
    }
}

export default {
    Actor, Widget, Bin, BoxLayout, Label, Icon, Button, ScrollView,
    Clipboard, ClipboardType, ThemeContext,
    __clipboard, __resetClipboard,
};
