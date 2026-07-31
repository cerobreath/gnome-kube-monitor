// Extension entry point: creates the indicator (view), the poller (IO loop) and
// the GSettings bridge in enable(), tears them all down in disable(), and feeds
// each poll observation through the alert state machine (lib/alerts.js),
// dispatching its fire/resolve actions to the notifier. The machine's state is
// persisted in GSettings so a restart neither replays nor forgets alerts.
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

// How far the persisted "last observed" stamp may lag before it's worth a dconf
// write. Well under the alert machine's settle window, and a lagging stamp only
// makes a gap look bigger (which settles silently), so this is the safe knob.
const STAMP_TOLERANCE_MS = 300_000;   // 5 minutes

export default class KubeMonitorExtension extends Extension {
    enable() {
        // First, before anything can build a string. Extension itself is the
        // backend: ExtensionBase.gettext/ngettext/pgettext are bound to the
        // domain from metadata.json's gettext-domain and read the catalogues
        // from this extension's locale/ directory.
        bindTranslations(this);
        this._settings = this.getSettings();
        // Diagnostics are opt-in: logged messages go to the shared system journal,
        // so this stays off unless the user is troubleshooting.
        setDebugEnabled(this._settings.get_boolean('debug-logging'));
        this._cancellable = new Gio.Cancellable();
        // Fallback label when no explicit context is set; resolved lazily.
        this._context = this._settings.get_string('context');
        this._notifier = new KubeNotifier(this);

        // Alert state machine: load the persisted blob so a restart resumes the
        // lifecycle instead of replaying. _persistedState tracks what's on disk
        // so we only write GSettings when the state actually changes.
        /** @type {import('./lib/alerts.js').AlertState | null} */
        this._alertState = deserializeState(this._settings.get_string('alert-state'));
        // What's currently on disk, so needsPersist can tell a real change from
        // the observation stamp merely advancing.
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

        // Handler ids are kept and disconnected in disable(). Destroying the
        // indicator would drop them anyway, but relying on that is the pattern
        // EGO reviewers query, and being explicit costs an array.
        /** @type {number[]} */
        this._indicatorIds = [
            this._indicator.connect('refresh-requested', () => this._poller?.refreshNow()),
            this._indicator.connect('menu-open-changed', (_i, open) => this._poller?.setMenuOpen(open)),
            this._indicator.connect('context-selected',
                (_i, ctx) => this._settings?.set_string('context', ctx)),
            // Translators: notification shown after clicking a node row. The body
            // is the shell command that was put on the clipboard, so it is not
            // translated.
            this._indicator.connect('node-copied', (_i, name) => this._notifier?.notify(
                _('Copied to clipboard'), format('kubectl describe node %s', name),
                {transient: true})),
            // Snooze: the menu emits seconds to mute for (0 = unmute); persist an
            // absolute wall-clock deadline the alert machine reads live.
            this._indicator.connect('snooze-requested', (_i, seconds) => this._settings?.set_int64(
                'alert-silence-until', seconds > 0 ? Date.now() + seconds * 1000 : 0)),
        ];
        this._indicator.setSnoozeUntil(this._settings.get_int64('alert-silence-until'));

        this._poller = new KubePoller({
            getOpts: () => this._readOpts(),
            getIntervalSec: () => this._settings?.get_int('refresh-interval') ?? 10,
            getContextLabel: () => this._settings?.get_string('context') || this._context || 'kubectl',
            onState: state => this._indicator?.update(state),
            onObservation: obs => this._onObservation(obs),
        });

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._poller?.intervalChanged();
            } else if (key === 'context' || key === 'kubeconfig-path' || key === 'kubectl-path') {
                // A connection setting changed: a different cluster is a cold
                // start for the alert machine. Drop state, refresh the switcher,
                // poll now (the next observation reduces from a clean slate).
                this._alertState = null;
                this._refreshContextInfo();
                this._poller?.refreshNow();
            } else if (key === 'debug-logging') {
                setDebugEnabled(settings.get_boolean('debug-logging'));
            } else if (key === 'alert-silence-until') {
                // Keep the menu's snooze label in sync (also fires on our own
                // write). No null-guards: this handler is disconnected in
                // disable(), and both the indicator and the settings object
                // outlive it, so it cannot run once either is gone.
                this._indicator.setSnoozeUntil(settings.get_int64('alert-silence-until'));
            }
            // 'alert-state' is our own write; alert tunables/toggles are read
            // live when the next observation is reduced. Nothing to do here.
        });

        this._refreshContextInfo();
        this._poller.start();
    }

    disable() {
        this._poller?.stop();
        this._poller = null;
        // Teardown must not post banners: the tray source is about to be
        // destroyed, and allocating one inside disable() is an EGO anti-pattern.
        // Instead roll the notify-log back for anything still buffered, so the
        // next enable() delivers it rather than assuming the user saw it.
        if (this._groupTimerId) {
            GLib.source_remove(this._groupTimerId);
            this._groupTimerId = 0;
        }
        // Optional: the shell calls disable() even when enable() bailed out, so
        // nothing here may assume enable() ran.
        if (this._pendingActions?.length) {
            this._alertState = rollbackDelivery(this._alertState, this._pendingActions);
            this._pendingActions = [];
        }
        // Flush the latest alert state so a warm restart (e.g. screen lock)
        // resumes exactly where we left off. Each observation already persists,
        // so this is belt-and-suspenders.
        this._persistAlertState();
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._settingsChangedId) {
            this._settings?.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
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
        // Drop the gettext backend last: it is this extension object, and module
        // state holding it would outlive the disable() that is meant to release
        // everything (gnome-shell keeps the instance across lock/unlock).
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
        // Capture the cancellable once. disable() nulls it, and reading it late
        // (inside a .then) would hand client.js a null one -- spawning a kubectl
        // nobody can kill. It also gates the continuations: gnome-shell reuses
        // this Extension instance across lock/unlock, so a late callback would
        // otherwise write the previous cycle's context list into the new menu.
        // NB: fetchCurrentContext swallows cancellation and resolves '', so the
        // is_cancelled() checks below are what actually stop the chain.
        const cancellable = this._cancellable;
        if (!cancellable)
            return;
        // No cancellation check on entry: every caller reaches here synchronously
        // after one (the guard above, or the one in the current-context handler
        // below), so only the async continuation can be late.
        const showList = (/** @type {string} */ current) => {
            fetchContexts(opts, cancellable)
                .then(list => {
                    if (!cancellable.is_cancelled())
                        this._indicator?.setContexts(list, current);
                })
                .catch(() => {});
        };
        // Resolve the effective current context first so the switcher can mark it
        // (when no explicit context is set, that's kubectl's current-context).
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
            // No .catch here: fetchCurrentContext resolves '' on any failure by
            // contract (see client.js), so a rejection is not reachable.
        }
    }

    // Fold one poll observation into the alert state machine and dispatch
    // whatever fire/resolve actions it produces. Runs from both tiers and from
    // the poller's error path (reachable:false); the machine handles debounce,
    // dedup, inhibition, resolve and the cold-start/settle guards.
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
    // into one banner instead of a wall of them. A 0s wait still batches every
    // action from the same poll (they're all buffered before the idle fires).
    _armGroupTimer() {
        if (!this._settings)
            return;   // torn down: never arm a timer nobody owns
        if (this._groupTimerId)
            return;   // a window is already open; let it keep collecting
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
            debug('alert', 'posting banner', {title: n.title, urgency: n.urgency});
            this._notifier?.notify(n.title, n.body, {urgency: n.urgency});
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
            clusterForSec: s?.get_int('alert-cluster-for') ?? 30,
            keepFiringForSec: s?.get_int('alert-keep-firing-for') ?? 60,
            repeatIntervalSec: s?.get_int('alert-repeat-interval') ?? 0,
            intervalSec: s?.get_int('refresh-interval') ?? 10,
            settleFactor: 3,
            silencedUntilMs: s?.get_int64('alert-silence-until') ?? 0,
        };
    }

    // Persist only when the alert records actually changed (or the observation
    // stamp has drifted far enough to matter), so a steady cluster doesn't churn
    // dconf on every poll. needsPersist owns that decision and is unit-tested.
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
