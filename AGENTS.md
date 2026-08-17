# AGENTS.md

Instructions for AI coding agents, and a decent orientation for any new contributor.
Deeper reference lives in `docs/` and is read on demand.

## What this is

A GNOME Shell extension showing Kubernetes node health in the top bar. Plain GJS/ESM with
**no build step**: gnome-shell loads the `.js` files directly, and TypeScript only
type-checks through JSDoc. `package.json`, `tests/`, `eslint.config.js`, `tsconfig*.json`
and CI are dev-only and never ship.

## Where the rest of the guidance lives

This file holds what applies to every change. Topic rules live in `.agents/rules/`, one per
area, each carrying `paths:` frontmatter so it loads only when work touches those files.

| Topic | File | Applies to |
| --- | --- | --- |
| Translation plumbing and catalogue rules | `.agents/rules/i18n.md` | `po/**`, `lib/i18n.js` |
| St theming traps, RTL, menu layout cost | `.agents/rules/ui.md` | `lib/indicator.js`, `lib/notifier.js`, `stylesheet.css` |
| Harness, stubs, coverage policy, types | `.agents/rules/testing.md` | `tests/**` |
| Poll-loop invariants and the kubectl edge | `.agents/rules/poll-loop.md` | `lib/poller.js`, `lib/client.js`, `lib/schedule.js` |
| Module map, alerting, two-tier polling, benchmarks | `docs/architecture.md` | on demand |
| Locale coverage, what is verified at runtime | `docs/translations.md` | on demand |

**Wiring, if your tool needs it.** Claude Code reads `CLAUDE.md` and `.claude/rules/`, not
this file and not `.agents/`. Both are gitignored here, so a fresh clone has neither and
the rules above will not load. Recreate them locally: a one-line `CLAUDE.md` containing
`@AGENTS.md`, and one stub per rule that repeats the frontmatter and imports the real file.

```markdown
---
paths:
  - "tests/**"
---

@../../.agents/rules/testing.md
```

## Commands

Dev tooling needs Node 24+ (`engines`, enforced by `.npmrc`). The extension never runs on
Node.

```bash
npm install                  # dev tooling only (eslint, typescript, @girs types)
npm run check                # THE GATE: lint + typecheck x2 + 100% coverage + i18n
npm test                     # unit tests only; no cluster, no gnome-shell needed
npm run pack                 # -> kube-monitor@cerobreath.dev.shell-extension.zip

npm run i18n:pot             # re-extract po/<uuid>.pot from the sources
npm run i18n:update          # merge the .pot into all 18 po/*.po
npm run i18n:check           # POTFILES/LINGUAS consistent, .pot current, no fuzzy

./install.sh                 # compile schema + symlink into ~/.local/share/gnome-shell
glib-compile-schemas schemas/    # MUST re-run after editing the gschema.xml
gnome-extensions prefs kube-monitor@cerobreath.dev
```

`install.sh` creates a **symlink**, so a code edit only needs a shell restart. Reinstall
only after touching the schema.

### Verifying a shell-side change

Unit tests prove the logic; only a real gnome-shell proves the extension *loads* (schema
compiled, no `resource:///` typo, no St property that does not exist). Silence proves
nothing, so check the state explicitly:

```bash
dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800 --wayland &
gnome-extensions info kube-monitor@cerobreath.dev   # want: State: ACTIVE
journalctl -f -o cat /usr/bin/gnome-shell | grep -i kube
```

**`--nested` exists up to GNOME 49 and is gone in 50.** It was `#ifdef HAVE_X11` in
mutter's `meta-context-main.c`, so mutter's "Drop the X11 backend" commit took it out along
with `--x11`. On 50, nested is simply the default when `--display-server` is absent.
`--headless` is preferred on every version anyway, because it does not steal focus.

For "why did I (not) get a notification?", turn on diagnostics and watch the same journal:

```bash
gsettings --schemadir schemas set org.gnome.shell.extensions.kube-monitor debug-logging true
```

## Hard rules

- **`npm run check` must pass.** A husky pre-commit hook and CI both run it. Do not bypass
  with `git commit --no-verify`. The i18n step needs GNU gettext installed.
- **Coverage is 100%** on every shipped file, enforced by threshold, not by convention. A
  drop fails the build.
- **Keep the pure core gi-free.** `lib/model.js`, `lib/schedule.js`, `lib/alerts.js`,
  `lib/i18n.js`, `lib/theme.js` and `lib/log.js` must have **no `gi://` imports**: that is what lets them
  run under node and carry the tests. New parsing, severity, scheduling, alerting or
  formatting logic goes there with a matching `tests/*.test.js`. IO stays in `client.js`,
  the timer loop in `poller.js`, widgets in `indicator.js`.
- **Never use class fields in a `GObject.registerClass` class** (`_x;` or `_x = …` in the
  class body). Their initializers run *after* `_init()` and reset whatever `_init` set back
  to `undefined` (verified on GJS 1.88). Assign all instance state inside `_init()`.
- **Annotate new code with JSDoc** so both `tsc --checkJs` passes stay clean.
- **Conventional Commits**, subject line only, no body. Match the existing history.

## Two execution contexts that cannot share runtime code

This is the trap most likely to produce code that passes review and then throws at runtime.

| | Shell process | Preferences process |
| --- | --- | --- |
| Files | `extension.js`, everything in `lib/` | `prefs.js` |
| Has | `St`, `Clutter`, `Main`, `PanelMenu`/`PopupMenu` | `Adw`, `Gtk`, `Gio`, `GLib` |
| Does not have | Gtk | `St`, `Clutter`, `Main` |

`prefs.js` may import the gi-free modules and `lib/client.js` (it reuses it to list
contexts), but never `lib/indicator.js` or `lib/notifier.js`. The two processes share only
the GSettings schema and the gettext domain, so all cross-context state travels through
settings keys.

## Comments

House style is gnome-shell's own: short, factual, written for the next maintainer.

- A `//` block is at most 3 lines, a file header at most 4. One line is the normal case.
- No em dashes, and no `--` standing in for one. No markdown or `*` emphasis. No "we/our".
- Do not restate the code. A comment earns its line by naming a constraint, an API quirk,
  or a bug it prevents, not by narrating how the decision was reached.
- **Rationale, benchmarks and measurement notes go in `docs/`,** not into a comment block.
- JSDoc tags are the type layer and stay. Their prose gets one line.
- The `SPDX-FileCopyrightText` / `SPDX-License-Identifier` block heading every shipped
  source file is licensing metadata, not a comment. It does not count against the header
  limit, and removing it drops the only copyright notice those files carry.
- `// Translators:` comments stay directly above their string. Rewording one makes the
  `.pot` stale, so re-run `npm run i18n:pot && npm run i18n:update`.

## User-facing wording

Follow the GNOME HIG: sentence case, no trailing period on a row title or a fragment
subtitle, no jargon where a plain word works, and **never a shell command in a preferences
subtitle**.

- Prometheus/Alertmanager vocabulary (`for`, `keep_firing_for`, `group_wait`, "debounce")
  is fine in `lib/alerts.js` and in `docs/`. In the preferences window it becomes Node
  delay, Hold time, Batch window.
- Kubernetes API identifiers stay verbatim everywhere: `Ready`, `NotReady`,
  `SchedulingDisabled`, the pressure condition types, role names, `kubectl`, `kubeconfig`.
  They are what `kubectl get nodes` prints, and translating them would make the menu
  disagree with the command it is a window onto. The `CPU`/`MEM` meter abbreviations stay
  in Latin for the same reason: they mirror `kubectl top`'s `CPU%`/`MEMORY%` columns.
- Keep the gschema summaries in step with the UI. Only dconf-editor reads them, but
  wording that disagrees is still a bug.
- A new user-facing string must be wrapped and translated in the same change. `npm run
  check` fails on an untranslated or fuzzy message. See `.agents/rules/i18n.md`.

## Release

`npm run pack` builds the EGO-upload zip. CI cannot call it, because `gnome-extensions`
lives inside the heavy gnome-shell package, so both workflows build the zip through
`.github/pack-zip.sh` instead. **Its file list mirrors the pack script in `package.json`,
the one pairing left to keep by hand.** A `v*` tag runs the full gate and publishes that
zip as a GitHub release.

The panel icon is the official Kubernetes helm: regenerate it by extracting the helm path
from the source logo SVG rather than hand-editing path data.

<!-- Maintainer note, stripped before this file reaches an agent's context.
     Keep it under 200 lines: past that, adherence drops and rules get lost.
     Anything longer belongs in a path-scoped rule under .agents/rules/ or,
     if it is reference rather than instruction, in docs/. -->
