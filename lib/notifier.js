// Desktop notifications for node Ready/NotReady transitions. Owns a dedicated
// MessageTray source titled "Kube Node Monitor" with the helm icon, so banners
// are attributed to the extension instead of the generic "System" source that
// Main.notify() posts through. Bridges the MessageTray API split at GNOME 46:
// 45 uses positional constructors + Source.showNotification; 46 through 50+ use
// params-object constructors + Source.addNotification. Shell-process only
// (imports resource:///), like indicator.js.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const SOURCE_TITLE = 'Kube Node Monitor';

// GNOME 46 renamed Source.showNotification/pushNotification to addNotification
// and moved both Source and Notification to params-object constructors. Feature-
// detect once (addNotification exists on 46+, not on 45) so the same code path
// is chosen on every supported shell, present and future.
const NEW_API =
    typeof (/** @type {any} */ (MessageTray.Source).prototype.addNotification) === 'function';

export class KubeNotifier {
    /** @param {{path: string}} extension */
    constructor(extension) {
        this._gicon = Gio.icon_new_for_string(`${extension.path}/icons/kubernetes-symbolic.svg`);
        /** @type {any} */
        this._source = null;
    }

    // Lazily (re)create the tray source. The shell destroys a source once its
    // last notification is dismissed, so we drop our reference on 'destroy' and
    // rebuild on the next notify() -- the standard persistent-source pattern.
    _ensureSource() {
        if (this._source)
            return this._source;

        /** @type {any} */
        let source;
        if (NEW_API) {
            source = new MessageTray.Source({title: SOURCE_TITLE, icon: this._gicon});
        } else {
            // GNOME 45: positional (title, iconName). The constructor takes a
            // themed-icon *name*, not a Gio.Icon, so feed the bundled helm to
            // the source (and thus the banner) by overriding getIcon().
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
     * @param {{transient?: boolean}} [opts]  transient banners auto-dismiss and
     *   don't accumulate in the tray -- for confirmations, not node events.
     */
    notify(title, body = '', {transient = false} = {}) {
        const source = this._ensureSource();

        if (NEW_API) {
            source.addNotification(
                new MessageTray.Notification({source, title, body, isTransient: transient}));
        } else {
            const Notification = /** @type {any} */ (MessageTray.Notification);
            const n = new Notification(source, title, body, {});
            n.setTransient(transient);
            source.showNotification(n);
        }
    }

    // Tear down on disable(): destroying the source removes its notifications
    // and clears our reference through the 'destroy' handler above.
    destroy() {
        this._source?.destroy();
        this._source = null;
    }
}
