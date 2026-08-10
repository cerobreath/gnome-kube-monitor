---
paths:
  - "lib/indicator.js"
  - "lib/notifier.js"
  - "stylesheet.css"
---

# Menu and stylesheet conventions

The menu is built on the compositor's main loop, so cost here is desktop-wide jank, and
St's CSS subset behaves differently from a browser's in ways that have already caused
shipped bugs. Each rule below exists because something broke.

## St and theming traps

- **`reactive: false` on a `PopupBaseMenuItem` makes the theme grey it out.** St ties
  `:insensitive` to reactivity, and gnome-shell's theme paints
  `.popup-inactive-menu-item:insensitive` in the disabled colour (#9b9b9d dark, #78787b
  light), which the item then inherits down to live buttons inside it. For a container
  holding working controls use `{reactive: true, activate: false, hover: false}`:
  `_activatable` is `reactive && activate`, so it still matches plain
  `.popup-inactive-menu-item` while its click gesture stays unwired. `_contextItem` does
  this and a test pins it.
- **Never fix a colour problem by naming a colour.** A hardcoded `#ffffff` here is the
  regression that once made rows white-on-white under the Light style.
- **`reactive: true` also turns on `track_hover`**, which lets the theme paint
  `.popup-menu-item:hover` across a whole container. Hover must mark the row under the
  pointer, not the block around it, so `_contextItem` clears `track_hover` while the rows
  inside keep `.kube-context-row:hover`. Removing a per-row fill leaves that control with
  no mouse affordance, which is not a tidy-up.
- Beating a shell-theme rule takes **specificity, not load order**:
  `.popup-menu-item:hover, :selected, :checked` is one rule at (0,2,0), so a single-class
  override only ties.
- Purely informational rows (`_podsItem`, the header, the error item) are left dim on
  purpose. There the disabled colour reads as "secondary", which is what they are.

## Direction-sensitive CSS must be split

`margin-left`/`margin-right` and the padding/border equivalents have to be written twice,
under `:ltr` and `:rtl`. St has no logical properties, while `StBoxLayout` *does* reverse
child order under RTL, so a bare `margin-left` keeps pushing right in Arabic after the
neighbour it was clearing has moved. `tests/stylesheet.test.js` fails the build if a
directional property appears outside an `:ltr`/`:rtl` selector, or if one side is declared
without the other.

## Layout and performance

- **Actor reuse**: node rows are keyed by name in `_nodeRows`. A full rebuild happens only
  when the signature (sorted names plus levels) changes; otherwise only the duration and
  CPU/MEM values are updated in place, so an open menu does not churn.
- **`MAX_NODE_ROWS` caps rows at 50.** Rows are built synchronously at roughly 2.5 ms
  each, so the cap is what keeps menu-open cost flat regardless of cluster size. The
  remainder is summarised, never silently dropped. Figures: `docs/architecture.md`.
- **Stable width**: the menu width is `.kube-header`'s `min-width`. St clamps an actor's
  preferred width to its CSS `max-width`, so a `max-width` plus `line_wrap` label reflows
  instead of widening the popup. Never let unbounded text into the menu.
- Status colour is class-based (`kube-dot-<level>`, `kube-meter-<level>`, level in
  `ok|warning|error|unknown`), not inline. The one exception is the panel logo:
  `_syncIconColor()` pins it to the panel foreground and re-runs on `Main.panel`
  `style-changed` so it tracks light and dark themes.
- The "updated N ago" label uses `GLib.get_monotonic_time()`, immune to wall-clock jumps.

## Accessibility

The panel's only visual state is a 10px dot, so an icon-only control without an
`accessible_name` is silent to a screen reader, and `St.Widget` defaults `can_focus` to
`FALSE`. Both have been real bugs here.
