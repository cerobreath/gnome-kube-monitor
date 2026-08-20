// Fake Main: the panel and the message tray, recording what was added or
// connected.

class Emitter {
    constructor() {
        /** @type {Map<number, {name: string, cb: (...a: any[]) => void}>} */
        this._handlers = new Map();
        this._nextId = 1;
    }

    /** @param {string} name @param {(...a: any[]) => void} cb */
    connect(name, cb) {
        const id = this._nextId++;
        this._handlers.set(id, {name, cb});
        return id;
    }

    /** @param {number} id */
    disconnect(id) {
        if (!this._handlers.has(id))
            throw new Error(`disconnect: no handler ${id}`);
        this._handlers.delete(id);
    }

    /** @param {string} name @param {any[]} args */
    emit(name, ...args) {
        for (const h of [...this._handlers.values()]) {
            if (h.name === name)
                h.cb(this, ...args);
        }
    }

    __handlerCount() {
        return this._handlers.size;
    }
}

class Panel extends Emitter {
    constructor() {
        super();
        /** @type {Record<string, any>} */
        this.statusArea = {};
        this._fg = {red: 255, green: 255, blue: 255, alpha: 255};
    }

    /** @param {string} role @param {any} indicator */
    addToStatusArea(role, indicator) {
        // The real panel refuses a second indicator for one role (panel.js).
        if (this.statusArea[role])
            throw new Error(`Extension point conflict: there is already a status indicator for role ${role}`);
        this.statusArea[role] = indicator;
        // The real panel deletes its entry when the indicator is destroyed.
        indicator.connect?.('destroy', () => {
            delete this.statusArea[role];
        });
    }

    get_theme_node() {
        return {get_foreground_color: () => this._fg};
    }

    /** @param {{red: number, green: number, blue: number, alpha: number}} color */
    __setForeground(color) {
        this._fg = color;
        this.emit('style-changed');
    }
}

class MessageTrayImpl {
    constructor() {
        /** @type {any[]} */
        this.sources = [];
    }

    /** @param {any} source */
    add(source) {
        this.sources.push(source);
        source.connect?.('destroy', () => {
            this.sources = this.sources.filter(s => s !== source);
        });
    }
}

export let panel = new Panel();
export let messageTray = new MessageTrayImpl();

/** @type {{title: string, body: string}[]} */
export let notifications = [];

/** The legacy shortcut, recorded so a test can prove it is never used. */
export function notify(/** @type {string} */ title, /** @type {string} */ body) {
    notifications.push({title, body});
}

export function __reset() {
    panel = new Panel();
    messageTray = new MessageTrayImpl();
    notifications = [];
}
