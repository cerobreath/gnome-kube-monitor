# Kube Node Monitor

A GNOME Shell extension (45–50) showing Kubernetes cluster node status in the top bar.

- **In the panel:** the Kubernetes logo with a status dot in the bottom-right corner —
  green = all healthy, amber = degraded/pressure, red = a node is down.
- **In the menu:**
  - cluster context + a refresh button and a short "updated" time (now / 1m / …);
  - a pods summary — running / pending / crash-loop / failed counts;
  - nodes sorted by severity (problems first): status dot, name, how long it has been
    **up/down**, its role or failure reason, and per-node **CPU % / MEM %**
    (via metrics-server);
  - a **cluster switcher** to change kubectl context, then Settings.
- **Notifications** when a node crosses Ready ↔ NotReady (toggle in settings).
- Clicking a node copies its name to the clipboard.

## Install (dev, symlink)

```bash
./install.sh
gnome-extensions enable kube-monitor@cerobreath.dev
```

On Wayland a new extension is picked up after you log out and back in. To iterate
without logging out, use a nested session:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

## Settings

`gnome-extensions prefs kube-monitor@cerobreath.dev`

- Refresh interval (sec)
- Notify on node up/down (on/off)
- Context / kubeconfig path / kubectl path (empty = defaults)

## How it works

To stay cheap inside the compositor, polling is **two-tier**:

- **Menu closed** (almost always): one tiny `kubectl` health query (~250 B) drives the
  panel dot and up/down notifications.
- **Menu open**: full node detail + per-node metrics + a pods summary, refreshed only
  while you're looking, with menu rows updated in place rather than rebuilt.

An unreachable cluster backs off exponentially (10 s → … → 5 min) instead of retrying
every interval, and a per-poll watchdog prevents a hung `kubectl` from wedging the loop.

## Layout

```
extension.js        enable/disable, wiring, node up/down notifications
prefs.js            preferences window (libadwaita)
lib/model.js        pure parsers + severity/formatting (no gi imports; unit-tested)
lib/client.js       runs kubectl (Gio.Subprocess): health + detail/metrics/pods queries
lib/poller.js       the poll loop: two-tier fetch, backoff, watchdog, reentrancy
lib/indicator.js    panel indicator + dropdown menu (St/Clutter)
tests/              node --test suite over lib/model.js (no deps, no cluster needed)
schemas/            GSettings schema
stylesheet.css      styles (Adwaita palette, light/dark theme)
icons/              symbolic icon
```

## Develop / test

```bash
npm install           # dev tooling only (eslint, typescript, @girs types) — not shipped
npm test              # pure-logic unit tests (node --test)
npm run lint          # eslint
npm run typecheck     # type-check the JS via JSDoc + @girs types (tsc --checkJs, no emit)
npm run check         # lint + typecheck + test
```

Types are JSDoc-only: there is **no build step** — the extension ships as the same plain
`.js` gnome-shell loads. `tsconfig.json` type-checks the logic strictly; `tsconfig.ui.json`
covers the GObject view layer with `strictNullChecks` relaxed (widgets are assigned in
`_init`, which JSDoc can't mark as definitely-assigned).

A husky pre-commit hook runs lint-staged + type-check + tests; GitHub Actions runs the same
gate on every push/PR.

## Packaging

```bash
npm run pack          # → kube-monitor@cerobreath.dev.shell-extension.zip (install / upload to EGO)
```

CI also builds that zip as a downloadable artifact on every push/PR.

## License

[GPL-2.0-or-later](LICENSE) © 2026 Denys Lysenok — the GNOME-standard license (GNOME Shell,
which the extension imports, is GPL-2.0+).
