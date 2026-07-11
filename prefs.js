import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {fetchContexts, fetchCurrentContext} from './lib/client.js';

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
            subtitle: 'Desktop notification when a node becomes NotReady or recovers',
        });
        monitorGroup.add(notify);
        settings.bind('notify-node-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);

        // ---------------- Connection ----------------
        const connGroup = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Auto-detected — you normally don’t need to change anything.',
        });
        page.add(connGroup);

        // One-click context picker.
        const contextModel = new Gtk.StringList();
        const contextRow = new Adw.ComboRow({title: 'Context', subtitle: 'Which context to monitor'});
        contextRow.model = contextModel;
        connGroup.add(contextRow);

        // Auto-detected kubectl + kubeconfig, with a ✓ / ⚠ status prefix.
        const kubectlIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        const kubectlRow = new Adw.ActionRow({title: 'kubectl'});
        kubectlRow.add_prefix(kubectlIcon);
        connGroup.add(kubectlRow);

        const kubeconfigIcon = new Gtk.Image({icon_name: 'content-loading-symbolic'});
        const kubeconfigRow = new Adw.ActionRow({title: 'kubeconfig'});
        kubeconfigRow.add_prefix(kubeconfigIcon);
        connGroup.add(kubeconfigRow);

        // One-click connection test.
        const testBtn = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER});
        const testRow = new Adw.ActionRow({title: 'Test connection', subtitle: 'Run kubectl and list contexts'});
        testRow.add_suffix(testBtn);
        testRow.activatable_widget = testBtn;
        connGroup.add(testRow);

        // Manual overrides, tucked away — empty means auto-detect.
        const advanced = new Adw.ExpanderRow({
            title: 'Advanced',
            subtitle: 'Custom paths — leave empty to auto-detect',
        });
        connGroup.add(advanced);

        const kubeconfigEntry = new Adw.EntryRow({title: 'kubeconfig path'});
        advanced.add_row(kubeconfigEntry);
        settings.bind('kubeconfig-path', kubeconfigEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

        const kubectlEntry = new Adw.EntryRow({title: 'kubectl path'});
        advanced.add_row(kubectlEntry);
        settings.bind('kubectl-path', kubectlEntry, 'text', Gio.SettingsBindFlags.DEFAULT);

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
            kubectlRow.subtitle = kubectl || 'Not found on PATH — set it under Advanced';

            const kc = o.kubeconfig || GLib.getenv('KUBECONFIG') ||
                GLib.build_filenamev([GLib.get_home_dir(), '.kube', 'config']);
            const exists = GLib.file_test(kc, GLib.FileTest.EXISTS);
            kubeconfigIcon.icon_name = exists ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic';
            kubeconfigRow.subtitle = exists ? kc : `${kc}  (missing)`;
        };

        let contexts = /** @type {string[]} */ ([]);
        let syncing = false;

        const populate = async () => {
            try {
                contexts = await fetchContexts(opts(), null);
            } catch {
                contexts = [];
            }
            const current = await fetchCurrentContext(opts(), null).catch(() => '');

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
                    title: `Connected — ${list.length} context${list.length === 1 ? '' : 's'} found`,
                })))
                .catch(e => window.add_toast(new Adw.Toast({
                    title: `Failed: ${String(e?.message ?? e).split('\n')[0]}`,
                })))
                .finally(() => { testBtn.sensitive = true; });
        });

        // Re-detect and re-list when the custom paths change.
        settings.connect('changed::kubeconfig-path', () => { detectPaths(); populate(); });
        settings.connect('changed::kubectl-path', () => { detectPaths(); populate(); });

        detectPaths();
        await populate();
    }
}
