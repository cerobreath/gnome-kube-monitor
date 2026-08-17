// SPDX-FileCopyrightText: 2026 Denys Lysenok
//
// SPDX-License-Identifier: GPL-2.0-or-later

// The view: a PanelMenu.Button and its dropdown menu (St/Clutter). Emits
// refresh-requested, context-selected and menu-open-changed; never reads
// GSettings. Node rows are keyed by name and updated in place between polls.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NodeLevel, compareNodes, nodeQualifier, meterLevel, formatDuration} from './model.js';
import {styleVariant} from './theme.js';
import {_, N_, ngettext, format} from './i18n.js';

// Not translated: this is the name the extension is published under, and a
// screen reader saying anything else would not match what is installed.
const APP_NAME = 'Kube Node Monitor';

const DOT_LEVEL_CLASSES = ['kube-dot-ok', 'kube-dot-warning', 'kube-dot-error', 'kube-dot-unknown'];

// Scopes the light half of stylesheet.css. St has no media queries, so the
// palette can only follow the theme through a class set from here.
const LIGHT_CLASS = 'kube-light';

/**
 * Point one surface at the palette its own foreground implies.
 * @param {St.Widget} actor the panel button or the menu box
 * @param {'light' | 'dark'} variant
 */
function applyVariant(actor, variant) {
    const light = variant === 'light';
    // Setting the class restyles the actor, so re-entry has to stop here.
    if (light === actor.has_style_class_name(LIGHT_CLASS))
        return;
    if (light)
        actor.add_style_class_name(LIGHT_CLASS);
    else
        actor.remove_style_class_name(LIGHT_CLASS);
}

// Spoken form of each level; the panel's only visual state is a 10px coloured
// dot. N_() because the table is built at module load, before any locale is
// bound; _() happens at lookup.
const LEVEL_WORD = {
    // Translators: spoken cluster state. Every node is Ready.
    ok: N_('healthy'),
    // Translators: spoken cluster state. Something is wrong, nothing is down.
    warning: N_('degraded'),
    // Translators: spoken cluster state. At least one node is down.
    error: N_('critical'),
    // Translators: spoken cluster state. No reading yet, or kubectl failed.
    unknown: N_('status unknown'),
};

// Meter track width in px; must match .kube-meter-track in stylesheet.css.
const METER_WIDTH = 64;

// How long the "Mute alerts" submenu can mute for, in seconds.
const MUTE_DURATIONS = [900, 3600, 28800];

/**
 * "For 15 minutes" / "For 1 hour". Spelled out rather than abbreviated because
 * this is a menu of choices, not a status readout.
 * @param {number} seconds
 * @returns {string}
 */
function muteDurationLabel(seconds) {
    if (seconds < 3600) {
        const minutes = Math.round(seconds / 60);
        // Translators: a choice in the "Mute alerts" submenu. %d is a number
        // of minutes.
        return format(ngettext('For %d minute', 'For %d minutes', minutes), minutes);
    }
    const hours = Math.round(seconds / 3600);
    // Translators: a choice in the "Mute alerts" submenu. %d is a number of hours.
    return format(ngettext('For %d hour', 'For %d hours', hours), hours);
}

// Most node rows to build at once. Rows are built synchronously on the
// compositor's main loop at roughly 2.5 ms each, so the cap keeps menu-open
// cost flat whatever the cluster size. The remainder is summarised, not dropped.
const MAX_NODE_ROWS = 50;

// Network-shaped failures often heal on the next poll, so the first one keeps
// the previous data on show with a note. Config errors replace the view at once.
const TRANSIENT_ERRORS = new Set(['timeout', 'unreachable', 'offline']);

/**
 * A CPU or MEM meter bar (label + track + fill + value), updated in place.
 * @typedef {object} Meter
 * @property {St.BoxLayout} box
 * @property {St.Widget} fill
 * @property {St.Label} value
 */

/**
 * A rendered node row, kept for in-place updates between polls.
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
    // No class fields: in a GObject.registerClass class their initializers run
    // after _init() and would clobber what it set.
    // @ts-expect-error: PanelMenu.Button._init has a wider signature; GObject construction passes the one extension argument.
    _init(/** @type {{path: string, openPreferences: () => void}} */ extension) {
        super._init(0.5, APP_NAME, false);

        this._extension = extension;
        /** @type {number | null} */
        this._lastMonotonic = null;
        // Wall-ms until which alerts are muted (0 = not muted); set by the extension.
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

        // get_theme_node() logs a critical outside the stage, and the panel adopts
        // this button only after _init returns: the first read borrows its node.
        this._syncPanelStyle(Main.panel);
        this._styleChangedId = this.connect('style-changed', () => this._syncPanelStyle(this));

        this._buildMenu();

        // The popup is a second surface: a theme can restyle the panel alone.
        this._menuBox = /** @type {PopupMenu.PopupMenu} */ (this.menu).box;
        this._syncMenuStyle();
        this._menuStyleId = this._menuBox.connect('style-changed', () => this._syncMenuStyle());
    }

    /**
     * Colour the logo and pick the panel palette, both from one foreground.
     * @param {St.Widget} surface
     */
    _syncPanelStyle(surface) {
        const fg = surface.get_theme_node().get_foreground_color();
        this._icon.set_style(`color: rgba(${fg.red}, ${fg.green}, ${fg.blue}, ${fg.alpha / 255});`);
        applyVariant(this, styleVariant(fg));
    }

    _syncMenuStyle() {
        const box = this._menuBox;
        applyVariant(box, styleVariant(box.get_theme_node().get_foreground_color()));
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
            // Translators: placeholder in the menu header before the first poll lands.
            text: _('Loading…'), style_class: 'kube-title', y_align: Clutter.ActorAlign.CENTER,
        });
        // Long context names (gke_project_zone_cluster) must not stretch the
        // header; max-width in CSS caps it, the ellipsis trims what is left.
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
            // St.Widget defaults can-focus to FALSE, which left this the one
            // control in the menu a keyboard user could not reach.
            can_focus: true,
            // Translators: spoken name of the icon-only refresh button.
            accessible_name: _('Refresh now'),
        });
        refreshBtn.connect('clicked', () => {
            // Instant feedback: the poll's answer can be up to a watchdog away.
            // Translators: shown under the context name after a manual refresh,
            // until the poll answers.
            this._timeLabel.text = _('updating…');
            this.emit('refresh-requested');
        });

        headerItem.add_child(this._contextButton);
        headerItem.add_child(new St.Widget({x_expand: true}));   // spacer: refresh sits right
        headerItem.add_child(refreshBtn);
        menu.addMenuItem(headerItem);

        // Collapsible context list. Rows are buttons, so selecting one switches
        // context without closing the menu.

        // St ties :insensitive to an actor's reactivity, so reactive: false here
        // would have the theme's disabled colour inherited by the live buttons
        // inside. Reactive but non-activatable keeps the ordinary foreground.
        this._contextItem = new PopupMenu.PopupBaseMenuItem({
            reactive: true, activate: false, hover: false,
            can_focus: false, style_class: 'kube-context-list',
        });
        // PopupBaseMenuItem derives track_hover from reactive, which would paint
        // the theme's hover fill across the whole block. Rows highlight themselves.
        this._contextItem.track_hover = false;
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

        // A single transient failure keeps the last data on show; this strip
        // names the failure above it. See update().
        this._errorStrip = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._errorStripLabel = this._wrapLabel('', 'kube-error-strip');
        this._errorStrip.add_child(this._errorStripLabel);
        this._errorStrip.visible = false;
        menu.addMenuItem(this._errorStrip);

        this._nodesSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._nodesSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Muting withholds the banners only: the alert machine keeps tracking,
        // and an alert still firing when the mute expires notifies then.
        // Translators: submenu that mutes alert banners for a while.
        this._muteItem = new PopupMenu.PopupSubMenuMenuItem(_('Mute alerts'), true);
        this._muteItem.icon.icon_name = 'notifications-disabled-symbolic';
        for (const seconds of MUTE_DURATIONS) {
            const row = new PopupMenu.PopupMenuItem(muteDurationLabel(seconds));
            row.connect('activate', () => this.emit('snooze-requested', seconds));
            this._muteItem.menu.addMenuItem(row);
        }
        // Translators: menu row that cancels an active mute.
        this._unmuteItem = new PopupMenu.PopupMenuItem(_('Turn muting off'));
        this._unmuteItem.connect('activate', () => this.emit('snooze-requested', 0));
        this._muteItem.menu.addMenuItem(this._unmuteItem);
        menu.addMenuItem(this._muteItem);
        // Set the initial label here rather than waiting for the first
        // setSnoozeUntil(), so "Turn muting off" is not offered before a mute.
        this._syncMuteLabel();

        // Translators: menu row that opens the extension's preferences window.
        const settingsItem = new PopupMenu.PopupImageMenuItem(_('Settings'), 'preferences-system-symbolic');
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

    // Title carries the remaining time; the "off" row only appears while muted.
    // Every caller runs after _buildMenu, so no existence guard is needed.
    _syncMuteLabel() {
        const leftMs = this._snoozeUntil - Date.now();
        if (leftMs > 0) {
            // Round up to whole minutes (whole hours past an hour) so the
            // countdown reads "1m left" rather than "3s left" as it runs out.
            const mins = Math.ceil(leftMs / 60000);
            const left = formatDuration(mins >= 60 ? Math.round(mins / 60) * 3600 : mins * 60);
            // Translators: the "Mute alerts" row while muting is active. %s is a
            // short duration such as "45m" or "2h".
            this._muteItem.label.text = format(_('Muted · %s left'), left);
            this._unmuteItem.visible = true;
        } else {
            this._muteItem.label.text = _('Mute alerts');
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
        // St has no ATK expanded state to set here, so the caret's meaning has
        // to be spoken.
        const state = expanded
            // Translators: spoken state of the cluster switcher when its list is open.
            ? _('expanded')
            // Translators: spoken state of the cluster switcher when its list is closed.
            : _('collapsed');
        // Translators: spoken name of the menu header button. %1$s is the current
        // context name, %2$s is "expanded" or "collapsed".
        const name = _('%1$s, %2$s, cluster switcher');
        this._contextButton.accessible_name = format(name, this._titleLabel.text, state);
    }

    /**
     * @param {string[]} contexts
     * @param {string} current
     */
    setContexts(contexts, current) {
        this._contextList.destroy_all_children();
        if (contexts.length === 0) {
            this._contextList.add_child(new St.Label({
                // Translators: shown in the cluster switcher when the kubeconfig
                // defines no contexts.
                text: _('No contexts'), style_class: 'kube-context-empty',
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
            // Translators: last row of the cluster switcher; opens preferences so
            // another kubeconfig can be added.
            text: _('Add connection…'), x_expand: true, y_align: Clutter.ActorAlign.CENTER,
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
        // Opacity 0 hides the checkmark but leaves it in the accessibility tree,
        // so the current context has to be named instead.
        // Translators: spoken name of the selected row in the cluster switcher.
        // %s is the context name, a cluster identifier, so leave it as it is.
        row.accessible_name = current ? format(_('%s, current'), ctx) : ctx;
        row.connect('clicked', () => {
            this._setContextsExpanded(false);
            this._showSwitching(ctx);
            this.emit('context-selected', ctx);
        });
        return row;
    }

    // Flip the title and show a loading state before the new context's poll
    // arrives, which can be slow.
    /** @param {string} ctx */
    _showSwitching(ctx) {
        this._titleLabel.text = ctx;
        this._lastMonotonic = null;
        this._errorStrip.visible = false;
        this._updateTime();
        this._renderPods(null);
        this._nodesSection.removeAll();
        this._nodeRows.clear();
        this._nodesSig = null;
        this._nodesSection.addMenuItem(new PopupMenu.PopupMenuItem(_('Loading…'), {reactive: false}));
    }

    /** @param {import('./poller.js').PollState} state */
    update(state) {
        if (state.context)
            this._titleLabel.text = state.context;

        if (state.error) {
            this._setPanelDot(NodeLevel.ERROR);
            this._setAccessibleSummary(state.error.title);
            // First network-shaped failure: the data on show is likelier to be
            // useful than a full error view, so it stays, under a note. The
            // header keeps the shown data's age, not this failure's.
            if (TRANSIENT_ERRORS.has(state.error.key) && (state.failures ?? 0) < 2) {
                this._errorStripLabel.text = state.error.title;
                this._errorStrip.visible = true;
                this._updateTime();
                return;
            }
            this._lastMonotonic = state.monotonic ?? null;
            this._errorStrip.visible = false;
            this._renderPods(null);
            this._nodesSection.removeAll();
            this._nodeRows.clear();
            this._nodesSig = null;
            this._nodesSection.addMenuItem(this._makeErrorItem(state.error));
            this._updateTime();
            return;
        }

        this._lastMonotonic = state.monotonic ?? null;
        this._errorStrip.visible = false;
        this._setPanelDot(state.level);
        // Translators: spoken summary of the whole cluster. %1$s is a state word
        // ("healthy", "degraded", …), %2$d is how many nodes are Ready and %3$d
        // how many there are. The plural form follows the total, %3$d.
        const summary = ngettext('%1$s, %2$d of %3$d node ready',
            '%1$s, %2$d of %3$d nodes ready', state.total);
        this._setAccessibleSummary(format(summary,
            _(LEVEL_WORD[state.level ?? NodeLevel.UNKNOWN]), state.readyCount, state.total));

        if (state.tier === 'detail') {
            this._renderPods(state.pods ?? null);
            this._renderNodes(/** @type {import('./model.js').DetailNode[]} */ (state.nodes));
        }

        this._updateTime();
    }

    // A headline plus kubectl's own de-noised words. Both labels wrap at
    // WORD_CHAR so a long error (or an unbreakable URL) reflows inside the menu
    // instead of stretching it; max-width in the stylesheet caps the reflow.
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
        // compareNodes puts the most severe first, so those survive the cap.
        // Rows are keyed by name, so a duplicate would leave _nodeRows smaller
        // than the list and make the reuse check below permanently false.
        const seen = new Set();
        const unique = all.filter(n => !seen.has(n.name) && seen.add(n.name));
        const sorted = unique.slice(0, MAX_NODE_ROWS);
        const hidden = unique.length - sorted.length;
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
                // Translators: shown in place of the node list when the cluster
                // reports no nodes at all.
                new PopupMenu.PopupMenuItem(_('No nodes'), {reactive: false}));
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
                // Translators: closes a truncated node list. %d is how many
                // further nodes exist that the menu did not draw.
                format(ngettext('… and %d more node', '… and %d more nodes', hidden), hidden),
                {reactive: false});
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

        // One spoken sentence per row: the coloured dot, the arrow glyph and the
        // meter bars carry state that does not read out on its own.
        const parts = [node.name, nodeQualifier(node) || (node.ready ? 'Ready' : 'NotReady')];
        parts.push(node.ready
            // Translators: spoken uptime on a node row: how long it has been
            // Ready. %s is a short duration such as "3d".
            ? format(_('up %s'), node.since)
            // Translators: spoken downtime on a node row: how long it has been
            // NotReady. %s is a short duration such as "3d".
            : format(_('down %s'), node.since));
        if (node.cpuPct != null) {
            // Translators: spoken CPU load on a node row. %d is a percentage.
            parts.push(format(_('CPU %d%%'), node.cpuPct));
        }
        if (node.memPct != null) {
            // Translators: spoken memory load on a node row. %d is a percentage.
            parts.push(format(_('memory %d%%'), node.memPct));
        }
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

        const add = (/** @type {string} */ text, /** @type {string} */ cls) => {
            const label = new St.Label({
                text, y_align: Clutter.ActorAlign.CENTER, style_class: cls,
            });
            // Up to four of these share one row in a menu whose width is fixed
            // by the header. Ellipsizing (with .kube-pods' max-width) keeps a
            // long translation from stretching the popup; the count comes first.
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._podsBox.add_child(label);
        };
        // Translators: pod counts under the menu header. English has one form for
        // all counts, but %d selects the plural form your language needs. Keep
        // these very short: up to four of them share one row.
        add(format(ngettext('%d running', '%d running', pods.running), pods.running),
            'kube-pods-ok');
        if (pods.pending > 0) {
            // Translators: pods accepted but not yet started. Keep it very short.
            add(format(ngettext('%d pending', '%d pending', pods.pending), pods.pending),
                'kube-pods-warn');
        }
        if (pods.crashloop > 0) {
            // Translators: pods stuck restarting (CrashLoopBackOff). Keep it very short.
            add(format(ngettext('%d crashing', '%d crashing', pods.crashloop), pods.crashloop),
                'kube-pods-err');
        }
        if (pods.failed > 0) {
            // Translators: pods that terminated in failure. Keep it very short.
            add(format(ngettext('%d failed', '%d failed', pods.failed), pods.failed),
                'kube-pods-err');
        }
    }

    // Keeps the panel button's spoken name in step with the dot.
    /** @param {string} summary */
    _setAccessibleSummary(summary) {
        // Translators: spoken name of the panel button. "Kube Node Monitor" is
        // the extension's name, so leave it as it is. %s is the cluster summary.
        this.accessible_name = format(_('Kube Node Monitor: %s'), summary);
    }

    /** @param {import('./model.js').NodeLevelValue} [level] */
    _setPanelDot(level) {
        for (const cls of DOT_LEVEL_CLASSES)
            this._panelDot.remove_style_class_name(cls);
        this._panelDot.add_style_class_name(`kube-dot-${level ?? NodeLevel.UNKNOWN}`);
    }

    _updateTime() {
        if (this._lastMonotonic == null) {
            // Translators: shown under the context name while the first poll of a
            // cluster is still in flight.
            this._timeLabel.text = _('updating…');
            return;
        }
        const seconds = Math.max(0,
            Math.round((GLib.get_monotonic_time() - this._lastMonotonic) / GLib.TIME_SPAN_SECOND));

        // Translators: shown under the context name when the reading is only a
        // few seconds old, in place of a duration.
        this._timeLabel.text = seconds < 5 ? _('now') : formatDuration(seconds);
    }

    destroy() {
        // Unparenting restyles an actor, so a handler left connected would read
        // a theme node that is no longer in the stage.
        if (this._styleChangedId) {
            this.disconnect(this._styleChangedId);
            this._styleChangedId = 0;
        }
        if (this._menuStyleId) {
            this._menuBox.disconnect(this._menuStyleId);
            this._menuStyleId = 0;
        }
        this._nodeRows.clear();
        super.destroy();
    }
});
