// Extension entry point: builds the indicator, the poller and the GSettings
// bridge in enable(), tears them down in disable(), and folds each poll
// observation through the alert state machine (lib/alerts.js).
// Nothing is allocated at module scope, per the EGO lifecycle rules.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KubeIndicator} from './lib/indicator.js';
import {KubePoller} from './lib/poller.js';
import {KubeNotifier} from './lib/notifier.js';
import {fetchContexts, fetchCurrentContext} from './lib/client.js';
import {
    reduce, groupActions, rollbackDelivery, needsPersist, serializeState, deserializeState,
} from './lib/alerts.js';
import {debug, setDebugEnabled} from './lib/log.js';
import {bindTranslations, unbindTranslations, _, format} from './lib/i18n.js';

// How far the persisted "last observed" stamp may lag before a dconf write is
// worth it; a lagging stamp only makes a gap look bigger, which settles silently.
const STAMP_TOLERANCE_MS = 300_000;   // 5 minutes

export default class KubeMonitorExtension extends Extension {
    enable() {
        // Must run before anything can build a string.
        bindTranslations(this);
        this._settings = this.getSettings();
        setDebugEnabled(this._settings.get_boolean('debug-logging'));
        this._cancellable = new Gio.Cancellable();
        // Fallback label when no explicit context is set; resolved lazily.
        this._context = this._settings.get_string('context');
        this._notifier = new KubeNotifier(this);

        // Polling never pauses while offline (a localhost cluster stays
        // reachable), but a reconnect re-polls at once instead of sitting out
        // the backoff an offline stretch built up.
        this._netMonitor = Gio.NetworkMonitor.get_default();
        // No null-guard on the poller: the handler is disconnected in disable()
        // and enable() finishes building the poller before the loop can dispatch.
        this._netChangedId = this._netMonitor.connect('network-changed',
            (/** @type {unknown} */ _m, /** @type {boolean} */ available) => {
                if (available)
                    this._poller.refreshNow(true);
            });

        // Resume the persisted lifecycle instead of replaying it after a restart.
        /** @type {import('./lib/alerts.js').AlertState | null} */
        this._alertState = deserializeState(this._settings.get_string('alert-state'));
        // What is on disk, so needsPersist can tell a real change from an
        // observation stamp merely advancing.
        /** @type {import('./lib/alerts.js').AlertState | null} */
        this._persistedState = this._alertState;
        // group_wait buffer: actions collect here and flush as coalesced banners.
        /** @type {import('./lib/alerts.js').AlertAction[]} */
        this._pendingActions = [];
        this._groupTimerId = 0;

        this._indicator = new KubeIndicator(this);
        // registerClass() instances are St widgets at runtime, but @girs types the
        // wrapper as RegisteredPrototype rather than a PanelMenu.Button.
        Main.panel.addToStatusArea(this.uuid, /** @type {any} */ (this._indicator));

        // Disconnected explicitly in disable(), which is the pattern EGO review
        // looks for.
        /** @type {number[]} */
        this._indicatorIds = [
            this._indicator.connect('refresh-requested', () => this._poller?.refreshNow()),
            this._indicator.connect('menu-open-changed', (_i, open) => this._poller?.setMenuOpen(open)),
            this._indicator.connect('context-selected',
                (_i, ctx) => this._settings?.set_string('context', ctx)),
            // Translators: notification shown after clicking a node row. The body
            // is the shell command put on the clipboard, so it is not translated.
            this._indicator.connect('node-copied', (_i, name) => this._notifier?.notify(
                _('Copied to clipboard'), format('kubectl describe node %s', name),
                {transient: true})),
            // The menu emits seconds to mute for (0 = unmute); store an absolute
            // deadline the alert machine reads live.
            this._indicator.connect('snooze-requested', (_i, seconds) => this._settings?.set_int64(
                'alert-silence-until', seconds > 0 ? Date.now() + seconds * 1000 : 0)),
        ];
        this._indicator.setSnoozeUntil(this._settings.get_int64('alert-silence-until'));

        this._poller = new KubePoller({
            getOpts: () => this._readOpts(),
            getIntervalSec: () => this._settings?.get_int('refresh-interval') ?? 10,
            getContextLabel: () => this._settings?.get_string('context') || this._context || 'kubectl',
            // The poller is stopped before the monitor goes away, so no guard.
            isOffline: () => !this._netMonitor.network_available,
            onState: state => this._indicator?.update(state),
            onObservation: obs => this._onObservation(obs),
        });

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._poller?.intervalChanged();
            } else if (key === 'context' || key === 'kubeconfig-path' || key === 'kubectl-path') {
                // A different cluster is a cold start for the alert machine, so
                // the next observation reduces from a clean slate.
                this._alertState = null;
                this._refreshContextInfo();
                this._poller?.refreshNow();
            } else if (key === 'debug-logging') {
                setDebugEnabled(settings.get_boolean('debug-logging'));
            } else if (key === 'alert-silence-until') {
                // No null-guard: this handler is disconnected in disable(),
                // before the indicator goes away.
                this._indicator.setSnoozeUntil(settings.get_int64('alert-silence-until'));
            }
            // Only connection keys re-poll: 'alert-state' is this extension's own
            // write, and alert tunables are read live on the next observation.
        });

        this._refreshContextInfo();
        this._poller.start();
    }

    disable() {
        this._poller?.stop();
        this._poller = null;
        // Teardown must not post banners (an EGO anti-pattern), so buffered
        // actions are rolled back in the notify-log for the next enable().
        if (this._groupTimerId) {
            GLib.source_remove(this._groupTimerId);
            this._groupTimerId = 0;
        }
        // The shell calls disable() even when enable() bailed out, so nothing
        // here may assume enable() ran.
        if (this._pendingActions?.length) {
            this._alertState = rollbackDelivery(this._alertState, this._pendingActions);
            this._pendingActions = [];
        }
        // Flush the alert state so a warm restart (screen lock) resumes where it
        // stopped.
        this._persistAlertState();
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._settingsChangedId) {
            this._settings?.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        // The monitor is a process-wide singleton: only the handler is ours.
        if (this._netChangedId) {
            this._netMonitor.disconnect(this._netChangedId);
            this._netChangedId = 0;
        }
        this._netMonitor = null;
        for (const id of this._indicatorIds ?? [])
            this._indicator?.disconnect(id);
        this._indicatorIds = [];
        this._indicator?.destroy();
        this._indicator = null;
        this._notifier?.destroy();
        this._notifier = null;
        this._settings = null;
        this._alertState = null;
        setDebugEnabled(false);   // never keep logging after teardown
        // Drop the gettext backend last: it holds this extension object, which
        // module state would otherwise keep alive past disable().
        unbindTranslations();
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
        // Capture the cancellable once: disable() nulls it, and reading it inside
        // a .then would hand client.js a null one, spawning a kubectl nobody can
        // kill. The is_cancelled() checks below gate the late continuations.
        const cancellable = this._cancellable;
        if (!cancellable)
            return;
        const showList = (/** @type {string} */ current) => {
            fetchContexts(opts, cancellable)
                .then(list => {
                    if (!cancellable.is_cancelled())
                        this._indicator?.setContexts(list, current);
                })
                .catch(() => {});
        };
        // Resolve the effective context first so the switcher can mark it.
        if (opts.context) {
            showList(opts.context);
        } else {
            fetchCurrentContext(opts, cancellable)
                .then(ctx => {
                    if (cancellable.is_cancelled())
                        return;
                    if (ctx)
                        this._context = ctx;
                    showList(ctx || this._context || '');
                });
            // No .catch: fetchCurrentContext resolves '' on any failure, so a
            // rejection is not reachable (see lib/client.js).
        }
    }

    // Fold one poll observation into the alert machine and dispatch its actions.
    // Runs from both tiers and from the poller's error path (reachable:false).
    /** @param {import('./lib/alerts.js').AlertObservation} obs */
    _onObservation(obs) {
        if (!this._settings)
            return;
        const {state, actions} = reduce(this._alertState, obs, this._alertConfig(), Date.now());
        this._alertState = state;
        if (actions.length) {
            debug('alert', 'actions produced', {
                actions: actions.map(a => `${a.type}:${a.key}`),
                reachable: obs.reachable,
            });
            this._pendingActions.push(...actions);
            this._armGroupTimer();
        }
        this._persistAlertState();
    }

    // group_wait: hold the first action briefly so simultaneous flips coalesce
    // into one banner. A 0s wait still batches every action from the same poll.
    _armGroupTimer() {
        if (!this._settings)
            return;   // torn down; nothing owns the timer
        if (this._groupTimerId)
            return;   // a window is already collecting
        const waitSec = Math.max(0, this._settings.get_int('alert-group-wait'));
        this._groupTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, waitSec * 1000, () => {
            this._groupTimerId = 0;
            this._flushGroup();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushGroup() {
        const actions = this._pendingActions;
        this._pendingActions = [];
        for (const n of groupActions(actions)) {
            debug('alert', 'posting banner', {title: n.title, urgency: n.urgency, kind: n.kind});
            this._notifier?.notifyAlert(n);
        }
    }

    /** @returns {import('./lib/alerts.js').AlertConfig} */
    _alertConfig() {
        const s = this._settings;
        return {
            nodeEnabled: s?.get_boolean('notify-node-changes') ?? true,
            clusterEnabled: s?.get_boolean('notify-cluster-unreachable') ?? true,
            resolveNotify: s?.get_boolean('notify-on-recovery') ?? true,
            nodeForSec: s?.get_int('alert-node-for') ?? 30,
            clusterForSec: s?.get_int('alert-cluster-for') ?? 120,
            keepFiringForSec: s?.get_int('alert-keep-firing-for') ?? 60,
            repeatIntervalSec: s?.get_int('alert-repeat-interval') ?? 0,
            intervalSec: s?.get_int('refresh-interval') ?? 10,
            settleFactor: 3,
            silencedUntilMs: s?.get_int64('alert-silence-until') ?? 0,
        };
    }

    // Persist only on a real change, so a steady cluster does not churn dconf on
    // every poll; needsPersist owns that decision.
    _persistAlertState() {
        if (!this._settings)
            return;
        if (!needsPersist(this._persistedState, this._alertState, STAMP_TOLERANCE_MS))
            return;
        this._settings.set_string('alert-state',
            this._alertState ? serializeState(this._alertState) : '');
        this._persistedState = this._alertState;
    }
}
