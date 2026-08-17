// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences window (libadwaita). Runs in its own process, so it has Adw, Gtk,
// Gio and GLib but no St/Clutter/Main. Reuses lib/client.js to detect
// kubectl/kubeconfig and list contexts.

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
        // A separate process from the shell, with its own module state, so it
        // binds its own backend. ExtensionPreferences derives from the same
        // ExtensionBase, so the instance carries the same gettext methods.
        bindTranslations(this);
        const settings = this.getSettings();

        // Translators: the only page of the preferences window.
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});
        window.add(page);

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

        const notifyGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Choose which events notify you, and how long to wait first.'),
        });
        page.add(notifyGroup);

        const notify = new Adw.SwitchRow({
            title: _('Node problems'),
            // Translators: "Ready" is a Kubernetes node state, keep it as it is.
            subtitle: _('Notify when a node stops being Ready'),
        });
        notifyGroup.add(notify);
        settings.bind('notify-node-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);

        const cluster = new Adw.SwitchRow({
            title: _('Cluster unreachable'),
            subtitle: _('Notify when kubectl cannot reach the cluster'),
        });
        notifyGroup.add(cluster);
        settings.bind('notify-cluster-unreachable', cluster, 'active', Gio.SettingsBindFlags.DEFAULT);

        const recovery = new Adw.SwitchRow({
            title: _('Recovery'),
            subtitle: _('Also notify when a node or the cluster comes back'),
        });
        notifyGroup.add(recovery);
        settings.bind('notify-on-recovery', recovery, 'active', Gio.SettingsBindFlags.DEFAULT);

        const nodeFor = new Adw.SpinRow({
            // Translators: how long a node must stay down before it notifies.
            title: _('Node delay'),
            // Translators: "NotReady" is a Kubernetes node state, keep it as it is.
            subtitle: _('Seconds a node must stay NotReady before notifying'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(nodeFor);
        settings.bind('alert-node-for', nodeFor, 'value', Gio.SettingsBindFlags.DEFAULT);

        const clusterFor = new Adw.SpinRow({
            // Translators: how long the cluster must stay unreachable before it notifies.
            title: _('Cluster delay'),
            subtitle: _('Seconds the cluster must stay unreachable before notifying'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(clusterFor);
        settings.bind('alert-cluster-for', clusterFor, 'value', Gio.SettingsBindFlags.DEFAULT);

        const keepFiring = new Adw.SpinRow({
            // Translators: an alert stays active this long after its cause clears.
            title: _('Hold time'),
            // Translators: a node that "flaps" switches state repeatedly.
            subtitle: _('Seconds an alert stays active after it clears, so a flapping node notifies once'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(keepFiring);
        settings.bind('alert-keep-firing-for', keepFiring, 'value', Gio.SettingsBindFlags.DEFAULT);

        const repeat = new Adw.SpinRow({
            title: _('Repeat reminder'),
            subtitle: _('Seconds before notifying again about a still-active alert, or zero to notify once'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 86400, step_increment: 60, page_increment: 300}),
        });
        notifyGroup.add(repeat);
        settings.bind('alert-repeat-interval', repeat, 'value', Gio.SettingsBindFlags.DEFAULT);

        const groupWait = new Adw.SpinRow({
            // Translators: alerts firing within this window become one notification.
            title: _('Batch window'),
            subtitle: _('Seconds to wait so alerts firing together arrive as one notification'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 300, step_increment: 1, page_increment: 5}),
        });
        notifyGroup.add(groupWait);
        settings.bind('alert-group-wait', groupWait, 'value', Gio.SettingsBindFlags.DEFAULT);

        const connGroup = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _('kubectl and the kubeconfig are found automatically.'),
        });
        page.add(connGroup);

        const contextModel = new Gtk.StringList();
        // use_markup off: the subtitle interpolates a context name read from the
        // kubeconfig, which is not trusted as markup.
        const contextRow = new Adw.ComboRow({
            // Translators: "context" is the kubectl term for a saved cluster
            // connection; use whatever kubectl's own translation uses.
            title: _('Context'), subtitle: _('Which context to monitor'), use_markup: false,
        });
        contextRow.model = contextModel;
        connGroup.add(contextRow);

        // The status icon repeats what the subtitle already says in words, so it
        // is reinforcement rather than the only signal. "kubectl" and
        // "kubeconfig" are product names and stay untranslated as row titles.
        // use_markup off: the subtitles interpolate filesystem paths.
        const kubectlIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        // Translators: tooltip on the status icon beside the kubectl row.
        kubectlIcon.set_tooltip_text(_('Whether kubectl was found'));
        const kubectlRow = new Adw.ActionRow({title: 'kubectl', use_markup: false});
        kubectlRow.add_prefix(kubectlIcon);
        connGroup.add(kubectlRow);

        const kubeconfigIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        // Translators: tooltip on the status icon beside the kubeconfig row.
        kubeconfigIcon.set_tooltip_text(_('Whether a kubeconfig was found'));
        const kubeconfigRow = new Adw.ActionRow({title: 'kubeconfig', use_markup: false});
        kubeconfigRow.add_prefix(kubeconfigIcon);
        connGroup.add(kubeconfigRow);

        // Translators: button that tries the connection. Keep it to one word if
        // you can, it is a compact button in a row.
        const testBtn = new Gtk.Button({label: _('Test'), valign: Gtk.Align.CENTER});
        const testRow = new Adw.ActionRow({
            title: _('Test connection'), subtitle: _('Run kubectl and list contexts'),
        });
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        connGroup.add(testRow);

        // Manual overrides. Empty means detect.
        const advanced = new Adw.ExpanderRow({
            title: _('Advanced'),
            subtitle: _('Extra kubeconfig files and a custom kubectl path'),
        });
        connGroup.add(advanced);

        const kubectlEntry = new Adw.EntryRow({title: _('kubectl path')});
        advanced.add_row(kubectlEntry);
        settings.bind('kubectl-path', kubectlEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        // Off by default; see lib/log.js for what it does and does not write.
        const debugRow = new Adw.SwitchRow({
            title: _('Log diagnostics'),
            subtitle: _('Record poll and alert decisions in the system log'),
        });
        advanced.add_row(debugRow);
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // kubectl merges this list via KUBECONFIG. Empty means ~/.kube/config.
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

        const opts = () => ({
            kubectlPath: settings.get_string('kubectl-path'),
            kubeconfig: settings.get_string('kubeconfig-path'),
            context: settings.get_string('context'),
        });

        const detectPaths = () => {
            const o = opts();
            const kubectl = o.kubectlPath || GLib.find_program_in_path('kubectl') || '';
            kubectlIcon.icon_name = kubectl ? 'object-select-symbolic' : 'dialog-warning-symbolic';
            // Translators: shown when kubectl is not on PATH. "Advanced" is the
            // expander below, so use the same wording you gave its title.
            kubectlRow.subtitle = kubectl || _('Not found on PATH. Set it under Advanced.');

            const list = o.kubeconfig ? o.kubeconfig.split(':').filter(Boolean) : [];
            if (list.length > 1) {
                kubeconfigIcon.icon_name = 'object-select-symbolic';
                // Translators: how many kubeconfig files kubectl will merge into
                // one configuration. %d is the count.
                const files = ngettext('%d file', '%d files', list.length);
                kubeconfigRow.subtitle = format(files, list.length);
            } else {
                const kc = list[0] || GLib.getenv('KUBECONFIG') ||
                    GLib.build_filenamev([GLib.get_home_dir(), '.kube', 'config']);
                const exists = GLib.file_test(kc, GLib.FileTest.EXISTS);
                kubeconfigIcon.icon_name = exists ? 'object-select-symbolic' : 'dialog-warning-symbolic';
                // Translators: %s is a file path that does not exist.
                kubeconfigRow.subtitle = exists ? kc : format(_('%s (missing)'), kc);
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
            // Translators: first entry of the context picker. It follows whichever
            // context kubectl has selected instead of pinning one.
            const auto = _('Current context (auto)');
            contextModel.splice(0, contextModel.get_n_items(), [auto, ...contexts]);
            const setCtx = settings.get_string('context');
            const idx = setCtx ? contexts.indexOf(setCtx) + 1 : 0;
            contextRow.selected = idx > 0 ? idx : 0;
            syncing = false;

            contextRow.subtitle = (!setCtx && current)
                // Translators: shown when no context is pinned, so the extension
                // follows kubectl's selection. %s is that context's name.
                // "current-context" is a kubeconfig field, keep it as it is.
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
                // classifyError picks kubectl's own summary over the klog noise
                // and redacts credential material an exec plugin may have logged.
                // use_markup off: Adw.Toast parses Pango markup by default.
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
