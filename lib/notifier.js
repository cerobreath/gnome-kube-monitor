// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Desktop notifications for node Ready/NotReady transitions. Owns a dedicated
// MessageTray source with the helm icon, so banners are attributed to the
// extension instead of the generic "System" source Main.notify() posts through.
// Shell-process only (imports resource:///), like indicator.js.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const SOURCE_TITLE = 'Kube Node Monitor';

// Neutral urgency names mapped to MessageTray.Urgency. CRITICAL banners show
// even under Do-Not-Disturb and are not auto-dismissed.
const URGENCY = {
    low: MessageTray.Urgency.LOW,
    normal: MessageTray.Urgency.NORMAL,
    high: MessageTray.Urgency.HIGH,
    critical: MessageTray.Urgency.CRITICAL,
};

// GNOME 46 renamed Source.showNotification to addNotification and moved Source
// and Notification to params-object constructors, so the generation is
// feature-detected: addNotification exists on 46+, not on 45.
/** @returns {boolean} */
function usesModernApi() {
    return typeof (/** @type {any} */ (MessageTray.Source).prototype.addNotification) === 'function';
}

export class KubeNotifier {
    /** @param {{path: string}} extension */
    constructor(extension) {
        this._gicon = Gio.icon_new_for_string(`${extension.path}/icons/kubernetes-symbolic.svg`);
        /** @type {any} */
        this._source = null;
        // The one live alert banner; see notifyAlert().
        /** @type {any} */
        this._alertNotification = null;
    }

    // The shell destroys a source once its last notification is dismissed, so the
    // reference is dropped on 'destroy' and the source rebuilt on the next call.
    _ensureSource() {
        if (this._source)
            return this._source;

        /** @type {any} */
        let source;
        if (usesModernApi()) {
            source = new MessageTray.Source({title: SOURCE_TITLE, icon: this._gicon});
        } else {
            // GNOME 45 takes positional (title, iconName): a themed-icon name,
            // not a Gio.Icon, so the bundled helm goes in via getIcon().
            source = new (/** @type {any} */ (MessageTray.Source))(SOURCE_TITLE, null);
            source.getIcon = () => this._gicon;
        }

        source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(source);
        this._source = source;
        return source;
    }

    /**
     * Post one banner attributed to the Kube Node Monitor source.
     * @param {string} title
     * @param {string} [body]
     * @param {{transient?: boolean, urgency?: 'low' | 'normal' | 'high' | 'critical'}} [opts]
     *   transient banners auto-dismiss and don't accumulate in the tray;
     *   urgency maps to MessageTray.Urgency (critical = sticky, shown under DND).
     */
    notify(title, body = '', {transient = false, urgency = 'normal'} = {}) {
        this._post(title, body, transient, URGENCY[urgency] ?? MessageTray.Urgency.NORMAL);
    }

    /**
     * Post a grouped alert banner. At most one is live at a time: a new fire
     * replaces the previous banner and a resolve withdraws it, so a recovered
     * cluster never leaves a stale "unreachable" banner sitting in the tray.
     * @param {import('./alerts.js').GroupedNotification} group
     */
    notifyAlert({kind, title, body, urgency}) {
        this._alertNotification?.destroy();
        const n = this._post(title, body, kind === 'resolve',
            URGENCY[urgency] ?? MessageTray.Urgency.NORMAL);
        if (kind !== 'fire')
            return;
        // Dismissal also destroys; the guard keeps a late destroy of an already
        // replaced banner from dropping the live one's reference.
        n.connect('destroy', () => {
            if (this._alertNotification === n)
                this._alertNotification = null;
        });
        this._alertNotification = n;
    }

    /**
     * @param {string} title
     * @param {string} body
     * @param {boolean} transient
     * @param {number} urgencyValue
     * @returns {any} the posted MessageTray.Notification
     */
    _post(title, body, transient, urgencyValue) {
        const source = this._ensureSource();

        if (usesModernApi()) {
            const n = new MessageTray.Notification({
                source, title, body, isTransient: transient, urgency: urgencyValue,
            });
            source.addNotification(n);
            return n;
        }
        const Notification = /** @type {any} */ (MessageTray.Notification);
        const n = new Notification(source, title, body, {});
        n.setTransient(transient);
        n.setUrgency(urgencyValue);
        source.showNotification(n);
        return n;
    }

    // Destroying the source removes its notifications and clears the references
    // through the 'destroy' handlers.
    destroy() {
        this._source?.destroy();
        this._source = null;
        this._alertNotification = null;
    }
}
