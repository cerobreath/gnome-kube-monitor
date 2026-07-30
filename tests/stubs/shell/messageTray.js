// Fake MessageTray that can present either generation of the notification API,
// so lib/notifier.js's version shim is testable on both sides of the GNOME 46
// break instead of only on whichever shell the developer happens to run.
//
//   45   : positional constructors + Source.showNotification + setters
//   46-50: params-object constructors + Source.addNotification + properties
//
// Shapes verified against the messageTray.js shipped in GNOME 50 and the 45.0 tag.

export const Urgency = {LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3};

export const NotificationDestroyedReason = {EXPIRED: 1, DISMISSED: 2, SOURCE_CLOSED: 3};

class Emitter {
    constructor() {
        /** @type {Map<string, ((...a: any[]) => void)[]>} */
        this._signals = new Map();
    }

    /** @param {string} name @param {(...a: any[]) => void} cb */
    connect(name, cb) {
        const list = this._signals.get(name) ?? [];
        list.push(cb);
        this._signals.set(name, list);
        return list.length;
    }

    /** @param {string} name @param {any[]} args */
    emit(name, ...args) {
        for (const cb of this._signals.get(name) ?? [])
            cb(this, ...args);
    }
}

export class Notification extends Emitter {
    /** @param {any} a @param {any} [b] @param {any} [c] @param {any} [d] */
    constructor(a, b, c, d) {
        super();
        if (generation >= 46) {
            Object.assign(this, {urgency: Urgency.NORMAL, isTransient: false}, a ?? {});
        } else {
            // 45: (source, title, banner, params)
            this.source = a;
            this.title = b;
            this.body = c;
            this.params = d ?? {};
            this.urgency = Urgency.NORMAL;
            this.isTransient = false;
        }
    }

    /** @param {boolean} v */
    setTransient(v) {
        if (generation >= 46)
            throw new Error('setTransient is the GNOME 45 API; 46+ uses isTransient');
        this.isTransient = v;
    }

    /** @param {number} v */
    setUrgency(v) {
        if (generation >= 46)
            throw new Error('setUrgency is the GNOME 45 API; 46+ uses the urgency property');
        this.urgency = v;
    }

    destroy() {
        this.emit('destroy');
    }
}

class SourceBase extends Emitter {
    /** @param {any} a @param {any} [b] */
    constructor(a, b) {
        super();
        /** @type {Notification[]} */
        this.notifications = [];
        this.destroyed = false;
        if (generation >= 46) {
            Object.assign(this, a ?? {});
        } else {
            this.title = a;                 // 45: (title, iconName)
            this.iconName = b;
        }
    }

    getIcon() {
        return this.icon ?? {__themed: this.iconName};
    }

    destroy() {
        this.destroyed = true;
        this.notifications = [];
        this.emit('destroy');
    }
}

/** Rebuilt by __setApiGeneration so the prototype probe sees the right shape. */
export let Source = SourceBase;
let generation = 50;

/** @param {number} gen  45 for the legacy API, 46+ for the modern one */
export function __setApiGeneration(gen) {
    generation = gen;
    if (gen >= 46) {
        Source = class ModernSource extends SourceBase {
            /** @param {Notification} n */
            addNotification(n) {
                this.notifications.push(n);
                this.emit('notification-added', n);
            }
        };
    } else {
        Source = class LegacySource extends SourceBase {
            /** @param {Notification} n */
            showNotification(n) {
                this.notifications.push(n);
                this.emit('notify', n);
            }

            /** @param {Notification} n */
            pushNotification(n) {
                this.notifications.push(n);
            }
        };
    }
}

export function __generation() {
    return generation;
}

__setApiGeneration(50);
