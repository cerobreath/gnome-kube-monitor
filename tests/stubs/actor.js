// Shared actor behaviour for the St/Clutter/PopupMenu fakes: signals, the child
// tree, style classes and the ClutterText handle. Enough for the view's real
// logic (row reuse, class swapping, wrapping, teardown) to be asserted.

export class Emitter {
    constructor() {
        /** @type {Map<number, {name: string, cb: (...a: any[]) => void}>} */
        this.__handlers = new Map();
        this.__nextHandlerId = 1;
    }

    /** @param {string} name @param {(...a: any[]) => void} cb */
    connect(name, cb) {
        const id = this.__nextHandlerId++;
        this.__handlers.set(id, {name, cb});
        return id;
    }

    /** @param {number} id */
    disconnect(id) {
        if (!this.__handlers.has(id))
            throw new Error(`disconnect: no handler ${id}`);
        this.__handlers.delete(id);
    }

    /** @param {string} name @param {any[]} args */
    emit(name, ...args) {
        for (const h of [...this.__handlers.values()]) {
            if (h.name === name)
                h.cb(this, ...args);
        }
    }

    __handlerCount() {
        return this.__handlers.size;
    }
}

/** The subset of ClutterText the view touches. */
class ClutterText {
    /** @param {string} text */
    constructor(text) {
        this.text = text;
        this.line_wrap = false;
        this.line_wrap_mode = null;
        this.ellipsize = null;
    }
}

export class Actor extends Emitter {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super();
        /** @type {Actor[]} */
        this.__children = [];
        /** @type {Actor | null} */
        this.__parent = null;
        this.__destroyed = false;
        this.__style = '';
        this.visible = true;
        this.opacity = 255;
        /** @type {string[]} */
        this.__classes = [];
        this.__text = '';
        Object.assign(this, params);
        if (typeof params.style_class === 'string')
            this.__classes = params.style_class.split(/\s+/).filter(Boolean);
        if (typeof params.text === 'string')
            this.__text = params.text;
        this.clutter_text = new ClutterText(this.__text);
    }

    get style_class() {
        return this.__classes.join(' ');
    }

    /** @param {string} v */
    set style_class(v) {
        this.__classes = String(v ?? '').split(/\s+/).filter(Boolean);
    }

    get text() {
        return this.__text;
    }

    /** @param {string} v */
    set text(v) {
        this.__text = v;
        if (this.clutter_text)
            this.clutter_text.text = v;
    }

    /** @param {string} cls */
    add_style_class_name(cls) {
        if (!this.__classes.includes(cls))
            this.__classes.push(cls);
    }

    /** @param {string} cls */
    remove_style_class_name(cls) {
        this.__classes = this.__classes.filter(c => c !== cls);
    }

    /** @param {string} cls */
    has_style_class_name(cls) {
        return this.__classes.includes(cls);
    }

    /** @param {string} style */
    set_style(style) {
        this.__style = style;
    }

    get_style() {
        return this.__style;
    }

    /** @param {Actor} child */
    add_child(child) {
        child.__parent = this;
        this.__children.push(child);
    }

    /** @param {Actor} child */
    remove_child(child) {
        child.__parent = null;
        this.__children = this.__children.filter(c => c !== child);
    }

    /** @param {Actor} child */
    set_child(child) {
        this.__children = [];
        this.add_child(child);
    }

    get_children() {
        return [...this.__children];
    }

    destroy_all_children() {
        for (const c of [...this.__children])
            c.destroy();
        this.__children = [];
    }

    destroy() {
        for (const c of [...this.__children])
            c.destroy();
        this.__children = [];
        this.__destroyed = true;
        this.__parent?.remove_child(this);
        this.emit('destroy');
        this.__handlers.clear();
    }

    /** Recursively collect the text of this actor and its descendants. */
    __allText() {
        const mine = this.__text ? [this.__text] : [];
        return mine.concat(...this.__children.map(c => c.__allText()));
    }
}
