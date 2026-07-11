import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KubeIndicator} from './lib/indicator.js';
import {KubePoller} from './lib/poller.js';
import {fetchContexts, fetchCurrentContext} from './lib/client.js';

export default class KubeMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._cancellable = new Gio.Cancellable();
        // Fallback label when no explicit context is set — resolved lazily.
        this._context = this._settings.get_string('context');
        this._prevReady = null;

        this._indicator = new KubeIndicator(this);
        // registerClass() instances are St widgets at runtime, but @girs types the
        // wrapper as RegisteredPrototype rather than a PanelMenu.Button.
        Main.panel.addToStatusArea(this.uuid, /** @type {any} */ (this._indicator));

        this._indicator.connect('refresh-requested', () => this._poller?.refreshNow());
        this._indicator.connect('menu-open-changed', (_i, open) => this._poller?.setMenuOpen(open));
        this._indicator.connect('context-selected', (_i, ctx) => this._settings?.set_string('context', ctx));

        this._poller = new KubePoller({
            getOpts: () => this._readOpts(),
            getIntervalSec: () => this._settings?.get_int('refresh-interval') ?? 10,
            getContextLabel: () => this._settings?.get_string('context') || this._context || 'kubectl',
            onState: state => this._indicator?.update(state),
            onNodes: nodes => this._notifyTransitions(nodes),
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval') {
                this._poller?.intervalChanged();
            } else if (key === 'notify-node-changes') {
                // Read live in _notifyTransitions; nothing to re-poll.
            } else {
                // A connection setting changed (context / kubeconfig / kubectl):
                // drop the transition baseline, refresh the switcher, poll now.
                this._prevReady = null;
                this._refreshContextInfo();
                this._poller?.refreshNow();
            }
        });

        this._refreshContextInfo();
        this._poller.start();
    }

    disable() {
        this._poller?.stop();
        this._poller = null;
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._settingsChangedId) {
            this._settings?.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._prevReady = null;
    }

    _readOpts() {
        return {
            kubectlPath: this._settings?.get_string('kubectl-path') ?? '',
            kubeconfig: this._settings?.get_string('kubeconfig-path') ?? '',
            context: this._settings?.get_string('context') ?? '',
        };
    }

    // Resolve the current-context label (when the setting is empty) and populate
    // the cluster switcher. Best-effort; failures leave the UI as-is.
    _refreshContextInfo() {
        const opts = this._readOpts();
        if (!opts.context) {
            fetchCurrentContext(opts, this._cancellable)
                .then(ctx => { if (ctx) this._context = ctx; })
                .catch(() => {});
        }
        fetchContexts(opts, this._cancellable)
            .then(list => this._indicator?.setContexts(list, this._settings?.get_string('context') ?? ''))
            .catch(() => {});
    }

    // Fire a desktop notification when a node crosses the Ready boundary. Skips
    // the first poll (no baseline) and always refreshes the baseline so toggling
    // notifications on later doesn't replay old transitions. Works from both
    // tiers — health-tier nodes carry {name, ready} too.
    /** @param {{name: string, ready: boolean}[]} nodes */
    _notifyTransitions(nodes) {
        const cur = new Map(nodes.map(n => /** @type {[string, boolean]} */ ([n.name, n.ready])));
        if (this._prevReady && this._settings?.get_boolean('notify-node-changes')) {
            const down = [];
            const up = [];
            for (const [name, ready] of cur) {
                const was = this._prevReady.get(name);
                if (was === undefined)
                    continue;
                if (was && !ready)
                    down.push(name);
                else if (!was && ready)
                    up.push(name);
            }
            this._notify(down, up);
        }
        this._prevReady = cur;
    }

    // One notification per poll, even when several nodes flip at once.
    /**
     * @param {string[]} down
     * @param {string[]} up
     */
    _notify(down, up) {
        const total = down.length + up.length;
        if (total === 0)
            return;
        if (total === 1) {
            Main.notify('Kube Node Monitor', down.length
                ? `⚠ Node ${down[0]} is NotReady`
                : `✓ Node ${up[0]} recovered`);
            return;
        }
        const lines = [];
        if (down.length)
            lines.push(`⚠ NotReady: ${down.join(', ')}`);
        if (up.length)
            lines.push(`✓ Recovered: ${up.join(', ')}`);
        Main.notify('Kube Node Monitor', lines.join('\n'));
    }
}
