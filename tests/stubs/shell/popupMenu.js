// Fake PopupMenu family; the view's row reuse depends on removeAll() semantics.

import {Actor} from '../actor.js';

export class PopupBaseMenuItem extends Actor {
    /** @param {Record<string, any>} [params] */
    constructor(params = {}) {
        super({reactive: true, can_focus: true, ...params});
    }
}

export class PopupMenuItem extends PopupBaseMenuItem {
    /** @param {string} text @param {Record<string, any>} [params] */
    constructor(text, params = {}) {
        super(params);
        this.label = new Actor({text, style_class: 'popup-menu-item-label'});
        this.add_child(this.label);
    }
}

export class PopupImageMenuItem extends PopupMenuItem {
    /** @param {string} text @param {string} iconName @param {Record<string, any>} [params] */
    constructor(text, iconName, params = {}) {
        super(text, params);
        this.icon = new Actor({icon_name: iconName});
    }
}

export class PopupSeparatorMenuItem extends PopupBaseMenuItem {
    /** @param {string} [text] */
    constructor(text) {
        super({reactive: false, can_focus: false});
        this.label = new Actor({text: text ?? ''});
    }
}

/** A menu or section: an ordered list of items with the real removeAll(). */
class ItemHolder extends Actor {
    constructor() {
        super();
        /** @type {any[]} */
        this.__items = [];
    }

    /** @param {any} item */
    addMenuItem(item) {
        this.__items.push(item);
        this.add_child(item);
        item.__menu = this;
    }

    /** @param {number} [index] */
    removeAll() {
        for (const item of [...this.__items])
            item.destroy();
        this.__items = [];
    }

    get numMenuItems() {
        return this.__items.length;
    }

    __itemTexts() {
        return this.__items.map(i => i.__allText().join(' '));
    }
}

export class PopupMenuSection extends ItemHolder {}

export class PopupMenu extends ItemHolder {
    /** @param {any} sourceActor */
    constructor(sourceActor) {
        super();
        this.sourceActor = sourceActor;
        this.isOpen = false;
    }

    /** @param {boolean} open */
    __setOpen(open) {
        this.isOpen = open;
        this.emit('open-state-changed', open);
    }

    open() {
        this.__setOpen(true);
    }

    close() {
        this.__setOpen(false);
    }
}

export class PopupSubMenuMenuItem extends PopupBaseMenuItem {
    /** @param {string} text @param {boolean} [wantIcon] */
    constructor(text, wantIcon = false) {
        super();
        this.label = new Actor({text});
        this.add_child(this.label);
        if (wantIcon) {
            this.icon = new Actor({});
            this.add_child(this.icon);
        }
        this.menu = new PopupMenuSection();
        this.add_child(this.menu);
    }
}

export default {
    PopupBaseMenuItem, PopupMenuItem, PopupImageMenuItem, PopupSeparatorMenuItem,
    PopupMenuSection, PopupMenu, PopupSubMenuMenuItem,
};
