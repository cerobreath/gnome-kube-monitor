// Unit tests for the notification edge. The point of these is the version shim:
// the extension claims GNOME 45-50, but a developer only ever runs one of them,
// so both sides of the MessageTray API break at 46 are exercised here.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {KubeNotifier} from '../lib/notifier.js';

const EXT = {path: '/ext'};

/**
 * Point the stub tray at one API generation and hand back a fresh notifier.
 * A single module instance serves every generation because notifier.js probes
 * the API per call rather than caching the answer at import.
 * @param {number} gen
 */
async function loadNotifier(gen) {
    MessageTray.__setApiGeneration(gen);
    Main.__reset();
    return new KubeNotifier(EXT);
}

for (const gen of [45, 46, 50]) {
    test(`GNOME ${gen}: a notification is attributed to our own source`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('worker-2 is down');

        assert.equal(Main.messageTray.sources.length, 1, 'the source is registered with the tray');
        const source = Main.messageTray.sources[0];
        assert.equal(source.title, 'Kube Node Monitor',
            'banners must not read as the generic "System" source');
        assert.equal(source.notifications.length, 1);
        assert.equal(source.notifications[0].title, 'worker-2 is down');
        // Never via the legacy shortcut, which posts to the shared system source.
        assert.deepEqual(Main.notifications, []);
        notifier.destroy();
    });

    test(`GNOME ${gen}: the source carries our helm icon, not a themed fallback`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('x');
        const icon = Main.messageTray.sources[0].getIcon();
        assert.match(String(icon.__gicon ?? icon.to_string?.() ?? ''), /kubernetes-symbolic\.svg$/);
        notifier.destroy();
    });

    test(`GNOME ${gen}: urgency maps through, so a fire is sticky and shown under DND`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('down', '', {urgency: 'critical'});
        notifier.notify('recovered', '', {urgency: 'normal'});
        notifier.notify('quiet', '', {urgency: 'low'});
        notifier.notify('loud', '', {urgency: 'high'});
        notifier.notify('default');

        const urgencies = Main.messageTray.sources[0].notifications.map(n => n.urgency);
        assert.deepEqual(urgencies, [
            MessageTray.Urgency.CRITICAL,
            MessageTray.Urgency.NORMAL,
            MessageTray.Urgency.LOW,
            MessageTray.Urgency.HIGH,
            MessageTray.Urgency.NORMAL,
        ]);
        notifier.destroy();
    });

    test(`GNOME ${gen}: an unknown urgency name degrades to normal`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('x', '', {urgency: /** @type {any} */ ('nonsense')});
        assert.equal(Main.messageTray.sources[0].notifications[0].urgency,
            MessageTray.Urgency.NORMAL);
        notifier.destroy();
    });

    test(`GNOME ${gen}: transient confirmations do not linger in the tray`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('Copied to clipboard', 'kubectl describe node n1', {transient: true});
        notifier.notify('worker-2 is down');
        const [copy, down] = Main.messageTray.sources[0].notifications;
        assert.equal(copy.isTransient, true, 'a confirmation is transient');
        assert.equal(down.isTransient, false, 'a node event is not');
        notifier.destroy();
    });

    test(`GNOME ${gen}: the source is rebuilt after the shell destroys it`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('first');
        const first = Main.messageTray.sources[0];

        first.destroy();                 // the shell does this once the tray empties
        assert.equal(Main.messageTray.sources.length, 0);

        notifier.notify('second');       // must not post into the dead source
        assert.equal(Main.messageTray.sources.length, 1, 'a fresh source was registered');
        const second = Main.messageTray.sources[0];
        assert.notEqual(second, first);
        assert.equal(second.notifications[0].title, 'second');
        notifier.destroy();
    });

    test(`GNOME ${gen}: one source is reused across notifications`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('a');
        notifier.notify('b');
        assert.equal(Main.messageTray.sources.length, 1, 'no duplicate sources');
        assert.equal(Main.messageTray.sources[0].notifications.length, 2);
        notifier.destroy();
    });

    test(`GNOME ${gen}: destroy() tears the source down and is safe to repeat`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('a');
        notifier.destroy();
        assert.equal(Main.messageTray.sources.length, 0);
        notifier.destroy();              // idempotent: nothing left to destroy
        assert.equal(Main.messageTray.sources.length, 0);
    });

    test(`GNOME ${gen}: destroy() before anything was posted is a no-op`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.destroy();              // the source is created lazily
        assert.equal(Main.messageTray.sources.length, 0);
    });

    test(`GNOME ${gen}: the body defaults to empty`, async () => {
        const notifier = await loadNotifier(gen);
        notifier.notify('title only');
        assert.equal(Main.messageTray.sources[0].notifications[0].body ?? '', '');
        notifier.destroy();
    });
}

test('the API generation is detected from the Source prototype, not a version string', async () => {
    // 46+ exposes addNotification; 45 does not. That probe is the whole shim.
    MessageTray.__setApiGeneration(50);
    assert.equal(typeof MessageTray.Source.prototype.addNotification, 'function');
    MessageTray.__setApiGeneration(45);
    assert.equal(MessageTray.Source.prototype.addNotification, undefined);
    assert.equal(typeof MessageTray.Source.prototype.showNotification, 'function');
});
