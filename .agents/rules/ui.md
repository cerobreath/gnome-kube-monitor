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

## Light surfaces

- **Declare every hue and every dimming twice.** `stylesheet.css` carries a `.kube-light`
  half, scoped by a class `indicator.js` sets, because St's CSS subset has no media queries.
- **Why both halves are needed**: the palette was measured on the dark popup (`#36363a`).
  On the light one (`#fafafb`) its greens reach 1.6:1, and the same `opacity` buys about a
  fifth less contrast, because dark text loses more per step than white text gains.
- **A neutral `rgba(128, 128, 128, …)` is exempt.** It reads the same either way, which is
  what makes it the right way to write a hover fill in the first place.
- **Read the surface, not the setting.** `color-scheme` is `prefer-light` only for GNOME's
  own Light style. It says nothing about a user theme or high contrast, and a shell as old
  as the 45 in `metadata.json` may ship no light stylesheet for the setting to select.
  `styleVariant()` in `theme.js` reads the foreground instead: dark text means a light
  surface. Foreground, not background, which a theme may leave transparent.
- **Two surfaces, probed separately**: the panel button and `menu.box`. A theme can restyle
  one and not the other, so a single shared read puts the wrong palette on one of them.
  blur-my-shell's `force-light-text` does exactly that to the panel.
- **`get_theme_node()` logs a critical outside the stage.** The panel adopts the button only
  after `_init` returns, so the first read borrows `Main.panel`'s node. `menu.box` needs no
  such workaround: `setMenu()` has already put it in `Main.uiGroup`.
- **Disconnect both `style-changed` handlers in `destroy()`.** Unparenting restyles an actor,
  and a handler still connected would read a theme node that has left the stage.
- Values, their measured ratios and where they come from: `docs/architecture.md`.

## Direction-sensitive CSS must be split

- **Write `margin-left`/`margin-right` twice**, once under `:ltr` and once under `:rtl`.
  Same for the padding and border equivalents.
- **Why**: St has no logical properties, while `StBoxLayout` *does* reverse child order
  under RTL. A bare `margin-left` therefore keeps pushing right in Arabic, after the
  neighbour it was clearing has already moved to the other side.
- **Enforced**: `tests/stylesheet.test.js` fails the build if a directional property
  appears outside an `:ltr`/`:rtl` selector, or if one side is declared without the other.

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
  `_syncPanelStyle()` pins it to the surface's own foreground and re-runs on
  `style-changed` so it tracks light and dark themes.
- The "updated N ago" label uses `GLib.get_monotonic_time()`, immune to wall-clock jumps.

## Accessibility

The panel's only visual state is a 10px dot, so an icon-only control without an
`accessible_name` is silent to a screen reader, and `St.Widget` defaults `can_focus` to
`FALSE`. Both have been real bugs here.
