import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class KubeMonitorPreferences extends ExtensionPreferences {
    /** @param {Adw.PreferencesWindow} window */
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const monitorGroup = new Adw.PreferencesGroup({title: 'Monitoring'});
        page.add(monitorGroup);

        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between kubectl polls',
            adjustment: new Gtk.Adjustment({
                lower: 2,
                upper: 3600,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        monitorGroup.add(interval);
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        const notify = new Adw.SwitchRow({
            title: 'Notify on node up/down',
            subtitle: 'Desktop notification when a node becomes NotReady or recovers',
        });
        monitorGroup.add(notify);
        settings.bind('notify-node-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);

        const connGroup = new Adw.PreferencesGroup({
            title: 'Connection',
            description: 'Empty = defaults: current context, ~/.kube/config, kubectl from PATH.',
        });
        page.add(connGroup);

        const context = new Adw.EntryRow({title: 'Context'});
        connGroup.add(context);
        settings.bind('context', context, 'text', Gio.SettingsBindFlags.DEFAULT);

        const kubeconfig = new Adw.EntryRow({title: 'kubeconfig path'});
        connGroup.add(kubeconfig);
        settings.bind('kubeconfig-path', kubeconfig, 'text', Gio.SettingsBindFlags.DEFAULT);

        const kubectl = new Adw.EntryRow({title: 'kubectl path'});
        connGroup.add(kubectl);
        settings.bind('kubectl-path', kubectl, 'text', Gio.SettingsBindFlags.DEFAULT);
    }
}
