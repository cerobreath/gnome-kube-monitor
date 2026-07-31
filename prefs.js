// Preferences window (libadwaita), which runs in a separate process from the
// shell. It reuses lib/client.js to auto-detect kubectl/kubeconfig and list
// contexts. Has Adw, Gtk, Gio and GLib but no St/Clutter/Main; see the
// two-execution-contexts note in CLAUDE.md.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {fetchContexts, fetchCurrentContext} from './lib/client.js';
import {classifyError} from './lib/model.js';
import {bindTranslations, _, ngettext, format} from './lib/i18n.js';

export default class KubeMonitorPreferences extends ExtensionPreferences {
    /** @param {Adw.PreferencesWindow} window */
    async fillPreferencesWindow(window) {
        // This is a different process from the shell, with its own module state,
        // so it binds its own backend. ExtensionPreferences derives from the same
        // ExtensionBase, so the instance carries the same gettext methods.
        bindTranslations(this);
        const settings = this.getSettings();

        // Translators: the only page of the preferences window.
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // ---------------- Monitoring ----------------
        // Translators: preferences group covering how often the cluster is polled.
        const monitorGroup = new Adw.PreferencesGroup({title: _('Monitoring')});
        page.add(monitorGroup);

        const interval = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between kubectl polls'),
            adjustment: new Gtk.Adjustment({lower: 2, upper: 3600, step_increment: 1, page_increment: 5}),
        });
        monitorGroup.add(interval);
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        const notify = new Adw.SwitchRow({
            title: _('Notify on node up/down'),
            subtitle: _('Alert when a node goes down or recovers'),
        });
        monitorGroup.add(notify);
        settings.bind('notify-node-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);

        // ---------------- Notifications ----------------
        const notifyGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            // Translators: "Debounce" and "hold" are the two waiting periods
            // configured by the rows below.
            description: _('How and when alerts fire. Debounce and hold windows ride out brief blips.'),
        });
        page.add(notifyGroup);

        const cluster = new Adw.SwitchRow({
            title: _('Notify when the cluster is unreachable'),
            subtitle: _('When kubectl can’t reach the cluster past the debounce window'),
        });
        notifyGroup.add(cluster);
        settings.bind('notify-cluster-unreachable', cluster, 'active', Gio.SettingsBindFlags.DEFAULT);

        const recovery = new Adw.SwitchRow({
            title: _('Notify on recovery'),
            subtitle: _('Also notify when a node or the cluster comes back'),
        });
        notifyGroup.add(recovery);
        settings.bind('notify-on-recovery', recovery, 'active', Gio.SettingsBindFlags.DEFAULT);

        const nodeFor = new Adw.SpinRow({
            // Translators: how long a node must stay down before it notifies.
            title: _('Node debounce'),
            // Translators: "NotReady" is a Kubernetes node state, keep it as it is.
            subtitle: _('Seconds a node must stay NotReady before it notifies'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(nodeFor);
        settings.bind('alert-node-for', nodeFor, 'value', Gio.SettingsBindFlags.DEFAULT);

        const clusterFor = new Adw.SpinRow({
            // Translators: how long the cluster must stay unreachable before it notifies.
            title: _('Cluster debounce'),
            subtitle: _('Seconds the cluster must stay unreachable before it notifies'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(clusterFor);
        settings.bind('alert-cluster-for', clusterFor, 'value', Gio.SettingsBindFlags.DEFAULT);

        const keepFiring = new Adw.SpinRow({
            // Translators: an alert stays active this long after its cause clears.
            title: _('Keep firing for'),
            // Translators: a "flap" is a node switching state repeatedly.
            subtitle: _('Seconds to hold a firing alert after it clears, so a flap doesn’t re-fire'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(keepFiring);
        settings.bind('alert-keep-firing-for', keepFiring, 'value', Gio.SettingsBindFlags.DEFAULT);

        const repeat = new Adw.SpinRow({
            title: _('Repeat interval'),
            subtitle: _('Seconds before re-notifying a still-firing alert (0 never repeats)'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 86400, step_increment: 60, page_increment: 300}),
        });
        notifyGroup.add(repeat);
        settings.bind('alert-repeat-interval', repeat, 'value', Gio.SettingsBindFlags.DEFAULT);

        const groupWait = new Adw.SpinRow({
            // Translators: alerts firing within this window become one banner.
            title: _('Group wait'),
            subtitle: _('Seconds to batch alerts firing together into one banner (0 groups per poll)'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 300, step_increment: 1, page_increment: 5}),
        });
        notifyGroup.add(groupWait);
        settings.bind('alert-group-wait', groupWait, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---------------- Connection ----------------
        const connGroup = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _('Auto-detected. Change these only if needed.'),
        });
        page.add(connGroup);

        // One-click context picker.
        const contextModel = new Gtk.StringList();
        // use_markup off: the subtitle interpolates a context name read from the
        // kubeconfig, which is not ours to trust as markup.
        const contextRow = new Adw.ComboRow({
            // Translators: "context" is the kubectl term for a saved cluster
            // connection; use whatever kubectl's own translation uses.
            title: _('Context'), subtitle: _('Which context to monitor'), use_markup: false,
        });
        contextRow.model = contextModel;
        connGroup.add(contextRow);

        // Auto-detected kubectl + kubeconfig, with a ✓ / ⚠ status prefix. The
        // subtitles carry the same meaning in words (the resolved path, or
        // "Not found…"), so the icon is reinforcement rather than the only
        // signal; the tooltip names it for anyone hovering or using a reader.
        // use_markup is off because the subtitles interpolate filesystem paths
        // and context names, which Adw would otherwise parse as Pango markup.
        // "kubectl" and "kubeconfig" are the tool's own names and stay untranslated
        // in the row titles; only what we say *about* them is translated.
        const kubectlIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        // Translators: tooltip on the ✓/⚠ icon beside the kubectl row.
        kubectlIcon.set_tooltip_text(_('kubectl detection status'));
        const kubectlRow = new Adw.ActionRow({title: 'kubectl', use_markup: false});
        kubectlRow.add_prefix(kubectlIcon);
        connGroup.add(kubectlRow);

        const kubeconfigIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        // Translators: tooltip on the ✓/⚠ icon beside the kubeconfig row.
        kubeconfigIcon.set_tooltip_text(_('kubeconfig detection status'));
        const kubeconfigRow = new Adw.ActionRow({title: 'kubeconfig', use_markup: false});
        kubeconfigRow.add_prefix(kubeconfigIcon);
        connGroup.add(kubeconfigRow);

        // One-click connection test.
        // Translators: button that tries the connection. Keep it to one word if
        // you can -- it is a compact button in a row.
        const testBtn = new Gtk.Button({label: _('Test'), valign: Gtk.Align.CENTER});
        const testRow = new Adw.ActionRow({
            title: _('Test connection'), subtitle: _('Run kubectl and list contexts'),
        });
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        connGroup.add(testRow);

        // Manual overrides, tucked away; empty means auto-detect.
        const advanced = new Adw.ExpanderRow({
            title: _('Advanced'),
            subtitle: _('Extra kubeconfig files and a custom kubectl path.'),
        });
        connGroup.add(advanced);

        const kubectlEntry = new Adw.EntryRow({title: _('kubectl path')});
        advanced.add_row(kubectlEntry);
        settings.bind('kubectl-path', kubectlEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        // Troubleshooting switch, so it lives behind Advanced rather than in the
        // main flow. Off by default; see lib/log.js for what it does and does not
        // write.
        const debugRow = new Adw.SwitchRow({
            title: _('Log diagnostics to the journal'),
            // Translators: %s is a shell command; it is not translated.
            subtitle: format(_('For troubleshooting: %s'),
                'journalctl -f -o cat /usr/bin/gnome-shell'),
        });
        advanced.add_row(debugRow);
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Kubeconfig files: a list that kubectl merges via KUBECONFIG. Add with a
        // file picker, remove with the trash button. Empty = default ~/.kube/config.
        const getKubeconfigs = () =>
            settings.get_string('kubeconfig-path').split(':').map(s => s.trim()).filter(Boolean);
        const setKubeconfigs = (/** @type {string[]} */ list) =>
            settings.set_string('kubeconfig-path', list.join(':'));

        const addRow = new Adw.ActionRow({title: _('Add kubeconfig file…')});
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            // Icon-only: without this a screen reader announces "button".
            tooltip_text: _('Add a kubeconfig file'),
        });
        addRow.add_suffix(addBtn);
        addRow.activatable_widget = addBtn;
        addBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: _('Select a kubeconfig file')});
            dialog.open(window, null, (_source, res) => {
                let file;
                try {
                    file = dialog.open_finish(res);
                } catch {
                    return;   // dismissed
                }
                const path = file?.get_path() ?? '';
                const list = getKubeconfigs();
                if (path && !list.includes(path)) {
                    list.push(path);
                    setKubeconfigs(list);
                }
            });
        });

        /** @type {Adw.ActionRow[]} */
        let kubeconfigRows = [];
        let addRowAdded = false;
        const rebuildKubeconfigRows = () => {
            for (const r of kubeconfigRows)
                advanced.remove(r);
            if (addRowAdded)
                advanced.remove(addRow);
            kubeconfigRows = getKubeconfigs().map(path => {
                // use_markup off: title and subtitle are filesystem paths, which
                // Adw would otherwise run through the Pango markup parser.
                const row = new Adw.ActionRow({
                    title: GLib.path_get_basename(path), subtitle: path, use_markup: false,
                });
                const rm = new Gtk.Button({
                    icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                    // Translators: tooltip on the trash button beside a kubeconfig
                    // file. %s is the file's name.
                    tooltip_text: format(_('Remove %s'), GLib.path_get_basename(path)),
                });
                rm.connect('clicked', () => setKubeconfigs(getKubeconfigs().filter(p => p !== path)));
                row.add_suffix(rm);
                advanced.add_row(row);
                return row;
            });
            advanced.add_row(addRow);
            addRowAdded = true;
        };
        rebuildKubeconfigRows();

        // ---------------- logic ----------------
        const opts = () => ({
            kubectlPath: settings.get_string('kubectl-path'),
            kubeconfig: settings.get_string('kubeconfig-path'),
            context: settings.get_string('context'),
        });

        const detectPaths = () => {
            const o = opts();
            const kubectl = o.kubectlPath || GLib.find_program_in_path('kubectl') || '';
            kubectlIcon.icon_name = kubectl ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic';
            // Translators: shown when kubectl is not on PATH. "Advanced" is the
            // expander below -- use the same wording you used for its title.
            kubectlRow.subtitle = kubectl || _('Not found on PATH. Set it under Advanced.');

            const list = o.kubeconfig ? o.kubeconfig.split(':').filter(Boolean) : [];
            if (list.length > 1) {
                kubeconfigIcon.icon_name = 'emblem-ok-symbolic';
                // Translators: how many kubeconfig files kubectl will merge into
                // one configuration. %d is the count.
                const files = ngettext('%d file', '%d files', list.length);
                kubeconfigRow.subtitle = format(files, list.length);
            } else {
                const kc = list[0] || GLib.getenv('KUBECONFIG') ||
                    GLib.build_filenamev([GLib.get_home_dir(), '.kube', 'config']);
                const exists = GLib.file_test(kc, GLib.FileTest.EXISTS);
                kubeconfigIcon.icon_name = exists ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic';
                // Translators: %s is a file path that does not exist.
                kubeconfigRow.subtitle = exists ? kc : format(_('%s  (missing)'), kc);
            }
        };

        let contexts = /** @type {string[]} */ ([]);
        let syncing = false;

        const populate = async () => {
            try {
                contexts = await fetchContexts(opts(), null);
            } catch {
                contexts = [];
            }
            // No .catch: fetchCurrentContext resolves '' on any failure by
            // contract (see client.js), so a rejection is not reachable.
            const current = await fetchCurrentContext(opts(), null);

            syncing = true;
            // Translators: first entry of the context picker -- follow whichever
            // context kubectl currently has selected instead of pinning one.
            const auto = _('Current context (auto)');
            contextModel.splice(0, contextModel.get_n_items(), [auto, ...contexts]);
            const setCtx = settings.get_string('context');
            const idx = setCtx ? contexts.indexOf(setCtx) + 1 : 0;
            contextRow.selected = idx > 0 ? idx : 0;
            syncing = false;

            contextRow.subtitle = (!setCtx && current)
                // Translators: shown when no context is pinned, so the extension
                // follows kubectl's selection. %s is that context's name;
                // "current-context" is the kubeconfig field -- keep it as it is.
                ? format(_('Following current-context (%s)'), current)
                : _('Which context to monitor');
        };

        contextRow.connect('notify::selected', () => {
            if (syncing)
                return;
            const i = contextRow.selected;
            settings.set_string('context', i > 0 ? (contexts[i - 1] ?? '') : '');
        });

        testBtn.connect('clicked', () => {
            testBtn.sensitive = false;
            fetchContexts(opts(), null)
                .then(list => window.add_toast(new Adw.Toast({
                    // Translators: toast after a successful connection test.
                    // %d is how many contexts the kubeconfig defines.
                    title: format(ngettext('Connected. Found %d context.',
                        'Connected. Found %d contexts.', list.length), list.length),
                    use_markup: false,
                })))
                // Route through the shared classifier rather than printing raw
                // stderr: it picks kubectl's own summary over the klog noise and
                // redacts credential material an exec plugin may have logged.
                // use_markup is false because Adw.Toast parses Pango markup by
                // default, so untrusted text would be interpreted, not shown.
                .catch(e => window.add_toast(new Adw.Toast({
                    title: classifyError(e?.message ?? e).title,
                    use_markup: false,
                })))
                .finally(() => { testBtn.sensitive = true; });
        });

        // Re-detect and re-list when the custom paths change.
        settings.connect('changed::kubeconfig-path', () => {
            detectPaths();
            populate();
            rebuildKubeconfigRows();
        });
        settings.connect('changed::kubectl-path', () => { detectPaths(); populate(); });

        detectPaths();
        await populate();
    }
}
