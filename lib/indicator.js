// The view: a PanelMenu.Button and its dropdown menu (St/Clutter). It is
// decoupled from settings; it emits refresh-requested, context-selected and
// menu-open-changed, and never reads GSettings itself. Node rows are keyed by
// name and updated in place between polls, so an open menu does not churn.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NodeLevel, compareNodes, nodeQualifier, meterLevel} from './model.js';

const DOT_LEVEL_CLASSES = ['kube-dot-ok', 'kube-dot-warning', 'kube-dot-error', 'kube-dot-unknown'];

// Spoken form of each level. The panel's only visual state is a 10px coloured
// dot, so without this a screen-reader user gets no indication at all that the
// cluster is degraded -- the whole point of the extension.
const LEVEL_WORD = {
    ok: 'healthy',
    warning: 'degraded',
    error: 'critical',
    unknown: 'status unknown',
};

// Meter track width in px; must match .kube-meter-track in stylesheet.css.
const METER_WIDTH = 64;

// Most node rows to build at once. Rows cost ~14 St actors each and are built on
// the compositor's main loop, so this bounds what opening the menu can cost on a
// large cluster. Rows are sorted most-severe-first, and the remainder is
// summarised rather than silently dropped.
const MAX_NODE_ROWS = 50;

/**
 * A CPU or MEM meter bar (label + track + fill + value), updated in place.
 * @typedef {object} Meter
 * @property {St.BoxLayout} box
 * @property {St.Widget} fill
 * @property {St.Label} value
 */

/**
 * A rendered node row, kept so we can update it in place between polls.
 * @typedef {object} NodeRow
 * @property {PopupMenu.PopupBaseMenuItem} item
 * @property {St.Widget} dot
 * @property {St.Label} nameLabel
 * @property {St.Label} qualLabel
 * @property {St.Label} durationLabel
 * @property {St.BoxLayout} meters
 * @property {Meter} cpu
 * @property {Meter} mem
 */

export const KubeIndicator = GObject.registerClass({
    Signals: {
        'refresh-requested': {},
        'context-selected': {param_types: [GObject.TYPE_STRING]},
        'menu-open-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'node-copied': {param_types: [GObject.TYPE_STRING]},
        'snooze-requested': {param_types: [GObject.TYPE_INT]},
    },
}, class KubeIndicator extends PanelMenu.Button {
    // NB: fields are NOT declared as class fields; in GObject.registerClass
    // classes the field initializers run after _init() and would clobber it.
    // @ts-expect-error: PanelMenu.Button._init has a wider signature; GObject construction passes our single argument.
    _init(/** @type {{path: string, openPreferences: () => void}} */ extension) {
        super._init(0.5, 'Kube Node Monitor', false);

        this._extension = extension;
        /** @type {number | null} */
        this._lastMonotonic = null;
        // Wall-ms until which alerts are muted (0 = not muted); driven by the extension.
        this._snoozeUntil = 0;
        /** @type {Map<string, NodeRow>} */
        this._nodeRows = new Map();
        /** @type {string | null} */
        this._nodesSig = null;

        const overlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/kubernetes-symbolic.svg`),
            style_class: 'kube-panel-icon',
            icon_size: 22,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelDot = new St.Widget({
            style_class: 'kube-dot kube-panel-dot kube-dot-unknown',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        overlay.add_child(this._icon);
        overlay.add_child(this._panelDot);
        this.add_child(overlay);

        this._syncIconColor();
        this._styleChangedId = Main.panel.connect('style-changed', () => this._syncIconColor());

        this._buildMenu();
    }

    _syncIconColor() {
        const fg = Main.panel.get_theme_node().get_foreground_color();
        this._icon.set_style(`color: rgba(${fg.red}, ${fg.green}, ${fg.blue}, ${fg.alpha / 255});`);
    }

    _buildMenu() {
        const menu = /** @type {PopupMenu.PopupMenu} */ (this.menu);

        const headerItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'kube-header',
        });

        // Clickable context switcher: name + caret. Toggles the list below.
        this._contextButton = new St.Button({style_class: 'kube-context-button', can_focus: true});
        const info = new St.BoxLayout({vertical: true});
        const titleRow = new St.BoxLayout({});
        this._titleLabel = new St.Label({
            text: 'Loading…', style_class: 'kube-title', y_align: Clutter.ActorAlign.CENTER,
        });
        // Long context names (e.g. gke_project_zone_cluster) must not stretch the
        // header past its standard width; max-width in CSS caps it, ellipsis trims.
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._caret = new St.Icon({
            icon_name: 'pan-end-symbolic', style_class: 'kube-caret',
            icon_size: 12, y_align: Clutter.ActorAlign.CENTER,
        });
        titleRow.add_child(this._titleLabel);
        titleRow.add_child(this._caret);
        this._timeLabel = new St.Label({text: '', style_class: 'kube-time'});
        info.add_child(titleRow);
        info.add_child(this._timeLabel);
        this._contextButton.set_child(info);
        this._contextButton.connect('clicked', () => this._toggleContexts());

        const refreshBtn = new St.Button({
            style_class: 'kube-icon-button',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon'}),
            y_align: Clutter.ActorAlign.CENTER,
            // Icon-only, so it needs a name for screen readers; and St.Widget
            // defaults can-focus to FALSE, which left this the one control in the
            // menu a keyboard user could not reach.
            can_focus: true,
            accessible_name: 'Refresh now',
        });
        refreshBtn.connect('clicked', () => this.emit('refresh-requested'));

        headerItem.add_child(this._contextButton);
        headerItem.add_child(new St.Widget({x_expand: true}));   // spacer: tight highlight, refresh on the right
        headerItem.add_child(refreshBtn);
        menu.addMenuItem(headerItem);

        // Collapsible context list. Rows are buttons, so selecting one switches
        // context without closing the menu.
        this._contextItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false, can_focus: false, style_class: 'kube-context-list',
        });
        this._contextList = new St.BoxLayout({vertical: true, x_expand: true});
        this._contextItem.add_child(this._contextList);
        this._contextsExpanded = false;
        this._contextItem.visible = false;
        menu.addMenuItem(this._contextItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._podsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._podsBox = new St.BoxLayout({style_class: 'kube-pods', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        this._podsItem.add_child(this._podsBox);
        menu.addMenuItem(this._podsItem);

        this._podsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        menu.addMenuItem(this._podsSeparator);

        this._podsItem.visible = false;
        this._podsSeparator.visible = false;

        this._nodesSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._nodesSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Snooze: mute alert banners for a while (the alert machine keeps
        // tracking; muted alerts still active when it expires notify then).
        this._muteItem = new PopupMenu.PopupSubMenuMenuItem('Mute alerts', true);
        this._muteItem.icon.icon_name = 'notifications-disabled-symbolic';
        /** @type {[string, number][]} */
        const durations = [['For 15 minutes', 900], ['For 1 hour', 3600], ['For 8 hours', 28800]];
        for (const [label, seconds] of durations) {
            const row = new PopupMenu.PopupMenuItem(label);
            row.connect('activate', () => this.emit('snooze-requested', seconds));
            this._muteItem.menu.addMenuItem(row);
        }
        this._unmuteItem = new PopupMenu.PopupMenuItem('Turn muting off');
        this._unmuteItem.connect('activate', () => this.emit('snooze-requested', 0));
        this._muteItem.menu.addMenuItem(this._unmuteItem);
        menu.addMenuItem(this._muteItem);

        const settingsItem = new PopupMenu.PopupImageMenuItem('Settings', 'preferences-system-symbolic');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(settingsItem);

        menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._updateTime();
                this._syncMuteLabel();
            } else {
                this._setContextsExpanded(false);
            }
            this.emit('menu-open-changed', open);
        });
    }

    /** @param {number} untilMs  wall-ms until which alerts are muted (0 = not muted) */
    setSnoozeUntil(untilMs) {
        this._snoozeUntil = untilMs || 0;
        this._syncMuteLabel();
    }

    // Reflect the mute state in the submenu: title shows the remaining time, and
    // the "off" row only appears while muted.
    _syncMuteLabel() {
        if (!this._muteItem)
            return;
        const leftMs = this._snoozeUntil - Date.now();
        if (leftMs > 0) {
            const mins = Math.ceil(leftMs / 60000);
            const left = mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
            this._muteItem.label.text = `Muted · ${left} left`;
            this._unmuteItem.visible = true;
        } else {
            this._muteItem.label.text = 'Mute alerts';
            this._unmuteItem.visible = false;
        }
    }

    _toggleContexts() {
        this._setContextsExpanded(!this._contextsExpanded);
    }

    /** @param {boolean} expanded */
    _setContextsExpanded(expanded) {
        this._contextsExpanded = expanded;
        this._contextItem.visible = expanded;
        this._caret.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
    }

    /**
     * @param {string[]} contexts
     * @param {string} current
     */
    setContexts(contexts, current) {
        this._contextList.destroy_all_children();
        if (contexts.length === 0) {
            this._contextList.add_child(new St.Label({
                text: 'No contexts', style_class: 'kube-context-empty',
            }));
        } else {
            for (const ctx of contexts)
                this._contextList.add_child(this._makeContextRow(ctx, ctx === current));
        }

        const add = new St.Button({style_class: 'kube-context-row', x_expand: true, can_focus: true});
        const addBox = new St.BoxLayout({x_expand: true});
        addBox.add_child(new St.Icon({
            icon_name: 'list-add-symbolic', icon_size: 14,
            style_class: 'kube-context-icon', y_align: Clutter.ActorAlign.CENTER,
        }));
        addBox.add_child(new St.Label({
            text: 'Add connection…', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        }));
        add.set_child(addBox);
        add.connect('clicked', () => this._extension.openPreferences());
        this._contextList.add_child(add);
    }

    /**
     * @param {string} ctx
     * @param {boolean} current
     * @returns {St.Button}
     */
    _makeContextRow(ctx, current) {
        const row = new St.Button({style_class: 'kube-context-row', x_expand: true, can_focus: true});
        const box = new St.BoxLayout({x_expand: true});
        const check = new St.Icon({
            icon_name: 'object-select-symbolic', icon_size: 14,
            style_class: 'kube-context-icon', y_align: Clutter.ActorAlign.CENTER,
        });
        check.opacity = current ? 255 : 0;   // keep the column aligned when unchecked
        box.add_child(check);
        box.add_child(new St.Label({text: ctx, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        row.set_child(box);
        // Opacity 0 hides the checkmark visually but leaves it in the
        // accessibility tree, so "which context is current" has to be said.
        row.accessible_name = current ? `${ctx}, current` : ctx;
        row.connect('clicked', () => {
            this._setContextsExpanded(false);
            this._showSwitching(ctx);
            this.emit('context-selected', ctx);
        });
        return row;
    }

    // Instant feedback on switch: flip the title and show a loading state right
    // away, before the (possibly slow) poll for the new context arrives.
    /** @param {string} ctx */
    _showSwitching(ctx) {
        this._titleLabel.text = ctx;
        this._lastMonotonic = null;
        this._updateTime();
        this._renderPods(null);
        this._nodesSection.removeAll();
        this._nodeRows.clear();
        this._nodesSig = null;
        this._nodesSection.addMenuItem(new PopupMenu.PopupMenuItem('Loading…', {reactive: false}));
    }

    /** @param {import('./poller.js').PollState} state */
    update(state) {
        this._lastMonotonic = state.monotonic ?? null;
        if (state.context)
            this._titleLabel.text = state.context;

        if (state.error) {
            this._setPanelDot(NodeLevel.ERROR);
            this._setAccessibleSummary(state.error.title);
            this._renderPods(null);
            this._nodesSection.removeAll();
            this._nodeRows.clear();
            this._nodesSig = null;
            this._nodesSection.addMenuItem(this._makeErrorItem(state.error));
            this._updateTime();
            return;
        }

        this._setPanelDot(state.level);
        this._setAccessibleSummary(
            `${LEVEL_WORD[state.level ?? NodeLevel.UNKNOWN]}, ${state.readyCount} of ${state.total} nodes ready`);

        if (state.tier === 'detail') {
            this._renderPods(state.pods ?? null);
            this._renderNodes(/** @type {import('./model.js').DetailNode[]} */ (state.nodes));
        }

        this._updateTime();
    }

    // A failed poll: a short human headline and, beneath it, kubectl's own
    // de-noised words. Both labels wrap at WORD_CHAR so a long single-line
    // error (or an unbreakable URL) reflows inside the menu instead of
    // stretching it; max-width in the stylesheet is what caps the reflow.
    /**
     * @param {import('./model.js').ClassifiedError} err
     * @returns {PopupMenu.PopupBaseMenuItem}
     */
    _makeErrorItem(err) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kube-error'});
        box.add_child(this._wrapLabel(err.title, 'kube-error-title'));
        if (err.detail)
            box.add_child(this._wrapLabel(err.detail, 'kube-error-detail'));
        item.add_child(box);
        return item;
    }

    /**
     * @param {string} text
     * @param {string} styleClass
     * @returns {St.Label}
     */
    _wrapLabel(text, styleClass) {
        const label = new St.Label({text, style_class: styleClass, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        return label;
    }

    /** @param {import('./model.js').DetailNode[]} nodes */
    _renderNodes(nodes) {
        const all = [...nodes].sort(compareNodes);
        // Cap the rows. Each one is ~14 St actors built synchronously inside the
        // compositor, so a large cluster (thousands of nodes) would otherwise
        // spend the shell's main loop building tens of thousands of actors the
        // moment the menu opens. compareNodes puts the most severe first, so the
        // nodes worth looking at are always the ones that survive the cap.
        const sorted = all.slice(0, MAX_NODE_ROWS);
        const hidden = all.length - sorted.length;
        const sig = `${sorted.map(n => `${n.name}:${n.level}`).join('|')}#${hidden}`;

        if (sig === this._nodesSig && this._nodeRows.size === sorted.length) {
            for (const node of sorted) {
                const row = this._nodeRows.get(node.name);
                if (row)
                    this._updateRow(row, node);
            }
            return;
        }

        this._nodesSig = sig;
        this._nodesSection.removeAll();
        this._nodeRows.clear();

        if (sorted.length === 0) {
            this._nodesSection.addMenuItem(
                new PopupMenu.PopupMenuItem('No nodes', {reactive: false}));
            return;
        }
        for (const node of sorted) {
            const row = this._makeNodeItem(node);
            this._nodeRows.set(node.name, row);
            this._nodesSection.addMenuItem(row.item);
        }
        // Never silently truncate: say what was left out.
        if (hidden > 0) {
            const more = new PopupMenu.PopupMenuItem(
                `… and ${hidden} more ${hidden === 1 ? 'node' : 'nodes'}`, {reactive: false});
            more.label.add_style_class_name('kube-node-qual');
            this._nodesSection.addMenuItem(more);
        }
    }

    /**
     * @param {import('./model.js').DetailNode} node
     * @returns {NodeRow}
     */
    _makeNodeItem(node) {
        const item = new PopupMenu.PopupBaseMenuItem({style_class: 'kube-node-item'});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kube-node-box'});

        // Top row: status dot, name, qualifier (role/reason), up/down duration.
        const top = new St.BoxLayout({x_expand: true, style_class: 'kube-node-top'});
        const dot = new St.Widget({
            style_class: `kube-dot kube-dot-${node.level}`, y_align: Clutter.ActorAlign.CENTER,
        });
        const nameLabel = new St.Label({
            text: node.name, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER, style_class: 'kube-node-name',
        });
        const qualLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'kube-node-qual'});
        const durState = !node.ready ? 'down' : (node.level === NodeLevel.WARNING ? 'warn' : 'up');
        const durationLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER, style_class: `kube-node-duration kube-dur-${durState}`,
        });
        top.add_child(dot);
        top.add_child(nameLabel);
        top.add_child(qualLabel);
        top.add_child(durationLabel);
        box.add_child(top);

        // Meters row, indented to sit under the name.
        const meters = new St.BoxLayout({style_class: 'kube-node-meters'});
        const cpu = this._makeMeter('CPU');
        const mem = this._makeMeter('MEM');
        meters.add_child(cpu.box);
        meters.add_child(mem.box);
        box.add_child(meters);

        item.add_child(box);

        const row = {item, dot, nameLabel, qualLabel, durationLabel, meters, cpu, mem};
        this._updateRow(row, node);

        item.connect('activate', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD,
                `kubectl describe node ${node.name}`);
            // The extension owns the notifier; ask it to confirm the copy so the
            // toast comes from our source, not the generic "System" one.
            this.emit('node-copied', node.name);
        });
        return row;
    }

    /**
     * @param {string} label
     * @returns {Meter}
     */
    _makeMeter(label) {
        const box = new St.BoxLayout({style_class: 'kube-meter'});
        box.add_child(new St.Label({
            text: label, style_class: 'kube-meter-label', y_align: Clutter.ActorAlign.CENTER,
        }));
        const track = new St.BoxLayout({style_class: 'kube-meter-track', y_align: Clutter.ActorAlign.CENTER});
        const fill = new St.Widget({style_class: 'kube-meter-fill', y_expand: true});
        track.add_child(fill);
        box.add_child(track);
        const value = new St.Label({style_class: 'kube-meter-value', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(value);
        return {box, fill, value};
    }

    /**
     * @param {NodeRow} row
     * @param {import('./model.js').DetailNode} node
     */
    _updateRow(row, node) {
        row.qualLabel.text = nodeQualifier(node);
        row.durationLabel.text = `${node.ready ? '↑' : '↓'} ${node.since}`;
        this._setMeter(row.cpu, node.cpuPct);
        this._setMeter(row.mem, node.memPct);
        row.meters.visible = node.cpuPct != null || node.memPct != null;

        // One spoken sentence per row. The visual row leans on a coloured dot and
        // an arrow glyph, neither of which reads reliably; this spells the state
        // out, including the meters, which are otherwise bars plus bare numbers.
        const parts = [node.name, nodeQualifier(node) || (node.ready ? 'Ready' : 'NotReady')];
        parts.push(`${node.ready ? 'up' : 'down'} ${node.since}`);
        if (node.cpuPct != null)
            parts.push(`CPU ${node.cpuPct}%`);
        if (node.memPct != null)
            parts.push(`memory ${node.memPct}%`);
        row.item.accessible_name = parts.join(', ');
    }

    /**
     * @param {Meter} meter
     * @param {number | null} pct
     */
    _setMeter(meter, pct) {
        if (pct == null) {
            meter.box.visible = false;
            return;
        }
        meter.box.visible = true;
        meter.value.text = `${pct}%`;
        const clamped = Math.max(0, Math.min(100, pct));
        meter.fill.set_style(`width: ${Math.max(2, Math.round(METER_WIDTH * clamped / 100))}px;`);
        const level = meterLevel(pct);
        for (const l of ['ok', 'warning', 'error'])
            meter.fill.remove_style_class_name(`kube-meter-${l}`);
        meter.fill.add_style_class_name(`kube-meter-${level}`);
    }

    /** @param {import('./model.js').PodsSummary | null} pods */
    _renderPods(pods) {
        this._podsBox.destroy_all_children();
        const show = pods != null;
        this._podsItem.visible = show;
        this._podsSeparator.visible = show;
        if (!pods)
            return;

        const add = (/** @type {string} */ text, /** @type {string} */ cls) =>
            this._podsBox.add_child(new St.Label({
                text, y_align: Clutter.ActorAlign.CENTER, style_class: cls,
            }));
        add(`${pods.running} running`, 'kube-pods-ok');
        if (pods.pending > 0)
            add(`${pods.pending} pending`, 'kube-pods-warn');
        if (pods.crashloop > 0)
            add(`${pods.crashloop} crashing`, 'kube-pods-err');
        if (pods.failed > 0)
            add(`${pods.failed} failed`, 'kube-pods-err');
    }

    // Keep the panel button's spoken name in step with the dot, so the state is
    // available to assistive tech and not only to the eye.
    /** @param {string} summary */
    _setAccessibleSummary(summary) {
        this.accessible_name = `Kube Node Monitor: ${summary}`;
    }

    /** @param {import('./model.js').NodeLevelValue} [level] */
    _setPanelDot(level) {
        for (const cls of DOT_LEVEL_CLASSES)
            this._panelDot.remove_style_class_name(cls);
        this._panelDot.add_style_class_name(`kube-dot-${level ?? NodeLevel.UNKNOWN}`);
    }

    _updateTime() {
        if (this._lastMonotonic == null) {
            this._timeLabel.text = 'updating…';
            return;
        }
        const seconds = Math.max(0,
            Math.round((GLib.get_monotonic_time() - this._lastMonotonic) / GLib.TIME_SPAN_SECOND));

        let text;
        if (seconds < 5)
            text = 'now';
        else if (seconds < 60)
            text = `${seconds}s`;
        else if (seconds < 3600)
            text = `${Math.floor(seconds / 60)}m`;
        else
            text = `${Math.floor(seconds / 3600)}h`;

        this._timeLabel.text = text;
    }

    destroy() {
        if (this._styleChangedId) {
            Main.panel.disconnect(this._styleChangedId);
            this._styleChangedId = 0;
        }
        this._nodeRows.clear();
        super.destroy();
    }
});
