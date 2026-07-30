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

const AUTO_LABEL = 'Current context (auto)';

export default class KubeMonitorPreferences extends ExtensionPreferences {
    /** @param {Adw.PreferencesWindow} window */
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // ---------------- Monitoring ----------------
        const monitorGroup = new Adw.PreferencesGroup({title: 'Monitoring'});
        page.add(monitorGroup);

        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between kubectl polls',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 3600, step_increment: 1, page_increment: 5}),
        });
        monitorGroup.add(interval);
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        const notify = new Adw.SwitchRow({
            title: 'Notify on node up/down',
            subtitle: 'Alert when a node goes down or recovers',
        });
        monitorGroup.add(notify);
        settings.bind('notify-node-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);

        // ---------------- Notifications ----------------
        const notifyGroup = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'How and when alerts fire. Debounce and hold windows ride out brief blips.',
        });
        page.add(notifyGroup);

        const cluster = new Adw.SwitchRow({
            title: 'Notify when the cluster is unreachable',
            subtitle: 'When kubectl can’t reach the cluster past the debounce window',
        });
        notifyGroup.add(cluster);
        settings.bind('notify-cluster-unreachable', cluster, 'active', Gio.SettingsBindFlags.DEFAULT);

        const recovery = new Adw.SwitchRow({
            title: 'Notify on recovery',
            subtitle: 'Also notify when a node or the cluster comes back',
        });
        notifyGroup.add(recovery);
        settings.bind('notify-on-recovery', recovery, 'active', Gio.SettingsBindFlags.DEFAULT);

        const nodeFor = new Adw.SpinRow({
            title: 'Node debounce',
            subtitle: 'Seconds a node must stay NotReady before it notifies',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(nodeFor);
        settings.bind('alert-node-for', nodeFor, 'value', Gio.SettingsBindFlags.DEFAULT);

        const clusterFor = new Adw.SpinRow({
            title: 'Cluster debounce',
            subtitle: 'Seconds the cluster must stay unreachable before it notifies',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(clusterFor);
        settings.bind('alert-cluster-for', clusterFor, 'value', Gio.SettingsBindFlags.DEFAULT);

        const keepFiring = new Adw.SpinRow({
            title: 'Keep firing for',
            subtitle: 'Seconds to hold a firing alert after it clears, so a flap doesn’t re-fire',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 3600, step_increment: 5, page_increment: 30}),
        });
        notifyGroup.add(keepFiring);
        settings.bind('alert-keep-firing-for', keepFiring, 'value', Gio.SettingsBindFlags.DEFAULT);

        const repeat = new Adw.SpinRow({
            title: 'Repeat interval',
            subtitle: 'Seconds before re-notifying a still-firing alert (0 never repeats)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 86400, step_increment: 60, page_increment: 300}),
        });
        notifyGroup.add(repeat);
        settings.bind('alert-repeat-interval', repeat, 'value', Gio.SettingsBindFlags.DEFAULT);

        const groupWait = new Adw.SpinRow({
            title: 'Group wait',
            subtitle: 'Seconds to batch alerts firing together into one banner (0 groups per poll)',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 300, step_increment: 1, page_increment: 5}),
        });
        notifyGroup.add(groupWait);
        settings.bind('alert-group-wait', groupWait, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ---------------- Connection ----------------
        const connGroup = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Auto-detected. Change these only if needed.',
        });
        page.add(connGroup);

        // One-click context picker.
        const contextModel = new Gtk.StringList();
        // use_markup off: the subtitle interpolates a context name read from the
        // kubeconfig, which is not ours to trust as markup.
        const contextRow = new Adw.ComboRow({
            title: 'Context', subtitle: 'Which context to monitor', use_markup: false,
        });
        contextRow.model = contextModel;
        connGroup.add(contextRow);

        // Auto-detected kubectl + kubeconfig, with a ✓ / ⚠ status prefix. The
        // subtitles carry the same meaning in words (the resolved path, or
        // "Not found…"), so the icon is reinforcement rather than the only
        // signal; the tooltip names it for anyone hovering or using a reader.
        // use_markup is off because the subtitles interpolate filesystem paths
        // and context names, which Adw would otherwise parse as Pango markup.
        const kubectlIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        kubectlIcon.set_tooltip_text('kubectl detection status');
        const kubectlRow = new Adw.ActionRow({title: 'kubectl', use_markup: false});
        kubectlRow.add_prefix(kubectlIcon);
        connGroup.add(kubectlRow);

        const kubeconfigIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        kubeconfigIcon.set_tooltip_text('kubeconfig detection status');
        const kubeconfigRow = new Adw.ActionRow({title: 'kubeconfig', use_markup: false});
        kubeconfigRow.add_prefix(kubeconfigIcon);
        connGroup.add(kubeconfigRow);

        // One-click connection test.
        const testBtn = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        const testRow = new Adw.ActionRow({title: 'Test connection', subtitle: 'Run kubectl and list contexts'});
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        connGroup.add(testRow);

        // Manual overrides, tucked away; empty means auto-detect.
        const advanced = new Adw.ExpanderRow({
            title: 'Advanced',
            subtitle: 'Extra kubeconfig files and a custom kubectl path.',
        });
        connGroup.add(advanced);

        const kubectlEntry = new Adw.EntryRow({title: 'kubectl path'});
        advanced.add_row(kubectlEntry);
        settings.bind('kubectl-path', kubectlEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        // Troubleshooting switch, so it lives behind Advanced rather than in the
        // main flow. Off by default; see lib/log.js for what it does and does not
        // write.
        const debugRow = new Adw.SwitchRow({
            title: 'Log diagnostics to the journal',
            subtitle: 'For troubleshooting: journalctl -f -o cat /usr/bin/gnome-shell',
        });
        advanced.add_row(debugRow);
        settings.bind('debug-logging', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // Kubeconfig files: a list that kubectl merges via KUBECONFIG. Add with a
        // file picker, remove with the trash button. Empty = default ~/.kube/config.
        const getKubeconfigs = () =>
            settings.get_string('kubeconfig-path').split(':').map(s => s.trim()).filter(Boolean);
        const setKubeconfigs = (/** @type {string[]} */ list) =>
            settings.set_string('kubeconfig-path', list.join(':'));

        const addRow = new Adw.ActionRow({title: 'Add kubeconfig file…'});
        const addBtn = new Gtk.Button({
            icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            // Icon-only: without this a screen reader announces "button".
            tooltip_text: 'Add a kubeconfig file',
        });
        addRow.add_suffix(addBtn);
        addRow.activatable_widget = addBtn;
        addBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Select a kubeconfig file'});
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
                    tooltip_text: `Remove ${GLib.path_get_basename(path)}`,
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
            kubectlRow.subtitle = kubectl || 'Not found on PATH. Set it under Advanced.';

            const list = o.kubeconfig ? o.kubeconfig.split(':').filter(Boolean) : [];
            if (list.length > 1) {
                kubeconfigIcon.icon_name = 'emblem-ok-symbolic';
                kubeconfigRow.subtitle = `${list.length} files`;
            } else {
                const kc = list[0] || GLib.getenv('KUBECONFIG') ||
                    GLib.build_filenamev([GLib.get_home_dir(), '.kube', 'config']);
                const exists = GLib.file_test(kc, GLib.FileTest.EXISTS);
                kubeconfigIcon.icon_name = exists ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic';
                kubeconfigRow.subtitle = exists ? kc : `${kc}  (missing)`;
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
            contextModel.splice(0, contextModel.get_n_items(), [AUTO_LABEL, ...contexts]);
            const setCtx = settings.get_string('context');
            const idx = setCtx ? contexts.indexOf(setCtx) + 1 : 0;
            contextRow.selected = idx > 0 ? idx : 0;
            syncing = false;

            contextRow.subtitle = setCtx
                ? 'Which context to monitor'
                : (current ? `Following current-context (${current})` : 'Which context to monitor');
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
                    title: `Connected. Found ${list.length} context${list.length === 1 ? '' : 's'}.`,
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
