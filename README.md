<!--
  Brand art in docs/images/brand/ is generated, not hand-edited.
  Each <picture> carries a dark and a light file; GitHub picks one by theme.
-->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/hero-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/brand/hero-light.svg">
    <img src="docs/images/brand/hero-light.svg" alt="Kube Node Monitor: Kubernetes node health in the GNOME top bar" width="880">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/cerobreath/gnome-kube-monitor/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/cerobreath/gnome-kube-monitor/ci.yml?branch=main&style=flat-square&label=CI&labelColor=1B1119&color=A82740" alt="CI"></a>
  <a href="https://github.com/cerobreath/gnome-kube-monitor/releases/latest"><img src="https://img.shields.io/github/v/release/cerobreath/gnome-kube-monitor?style=flat-square&label=release&labelColor=1B1119&color=A82740" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/GNOME_Shell-45--50-A82740?style=flat-square&labelColor=1B1119" alt="GNOME Shell 45 to 50">
  <img src="https://img.shields.io/badge/coverage-100%25-2EC27E?style=flat-square&labelColor=1B1119" alt="100% test coverage">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--2.0--or--later-A82740?style=flat-square&labelColor=1B1119" alt="GPL-2.0-or-later"></a>
</p>

<!--
  PUBLISH TODO: uncomment once the extension is live on extensions.gnome.org and
  the numeric <ID> is known.

  <p align="center">
    <a href="https://extensions.gnome.org/extension/<ID>/kube-node-monitor/">
      <img src="https://img.shields.io/badge/Get_it_on-GNOME_Extensions-A82740?style=flat-square&logo=gnome&logoColor=white&labelColor=1B1119" alt="Get it on GNOME Extensions">
    </a>
  </p>
-->

A GNOME Shell extension that puts Kubernetes node health in the top bar. A dot stays green while every node is Ready, amber when one degrades, red when one drops out. A node going down is something you see, not something you find out later. Open the menu for the detail; the rest of the time it says nothing.

It runs on the `kubectl` and kubeconfig you already have, so whatever context and auth work in your terminal work here. It never writes to your cluster.

<!-- MEDIA: demo  (replaces the 0.1.0 recording)
  ~30s walkthrough at 1.0.0: open the menu, node meters, click-to-copy, context
  switcher, preferences. Drag the .mp4 into any issue on this repo and paste the
  resulting user-attachments URL here. GitHub only plays <video> from its own hosts.

  <p align="center">
    <video src="https://github.com/user-attachments/assets/…" controls muted width="880"></video>
  </p>
-->

<p align="center">
  <img src="docs/images/hero.png" alt="The menu open over a desktop, showing three nodes with CPU and memory meters" width="880">
</p>

## Install

Needs GNOME Shell 45 to 50, `kubectl` on your `PATH`, and a working kubeconfig. Per-node CPU and memory bars need metrics-server in the cluster; nothing else depends on it.

Not on [extensions.gnome.org](https://extensions.gnome.org) yet, so install from source:

```bash
git clone https://github.com/cerobreath/gnome-kube-monitor.git
cd gnome-kube-monitor
./install.sh
gnome-extensions enable kube-monitor@cerobreath.dev
```

`install.sh` compiles the GSettings schema and symlinks the folder into `~/.local/share/gnome-shell/extensions`. On Wayland you have to log out and back in before the shell will pick up a new extension.

<details>
<summary>From a zip, or uninstalling</summary>

```bash
npm run pack   # builds kube-monitor@cerobreath.dev.shell-extension.zip
gnome-extensions install --force kube-monitor@cerobreath.dev.shell-extension.zip
```

Every tagged release attaches that same zip, built from source by CI.

```bash
gnome-extensions disable kube-monitor@cerobreath.dev
rm ~/.local/share/gnome-shell/extensions/kube-monitor@cerobreath.dev
dconf reset -f /org/gnome/shell/extensions/kube-monitor/
```

</details>

## What you get

The Kubernetes helm sits in the panel with a status dot in the corner, tracking the worst node in the cluster.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/panel-states-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/brand/panel-states-light.svg">
    <img src="docs/images/brand/panel-states-light.svg" alt="The panel dot in three states: green for all Ready, amber for degraded, red for a node down" width="760">
  </picture>
</p>

Open it and you get the current context, how stale the data is, a pods line (running, pending, crash-looping, failed), and your nodes worst-first: each with its state, how long it has been up or down, its role or the reason it is unhappy, and CPU/memory bars where metrics-server provides them. Plus a context switcher, a mute submenu, and settings.

Outside the menu it does two things. It posts a desktop notification when a node stays NotReady, when the cluster stops answering, and again on recovery, withdrawing the outage banner that the recovery answers so the tray never fills up with resolved alarms. And clicking a node copies `kubectl describe node <name>` to your clipboard.

<!-- MEDIA: notification
  The "worker-2 is down" banner, ideally with the red panel dot in frame.
  Reproduce with: docker stop k3d-demo-agent-1. Drop at docs/images/notification.png.

  <p align="center">
    <img src="docs/images/notification.png" alt="Desktop notification: worker-2 is down" width="520">
  </p>
-->

## Settings

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/prefs-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/brand/prefs-light.svg">
    <img src="docs/images/brand/prefs-light.svg" alt="The preferences window: Monitoring and Notifications at the top of the scroll, Connection and Advanced further down, with kubectl and the kubeconfig auto-detected" width="880">
  </picture>
</p>

Leave context, kubeconfig and kubectl empty and it finds your current context, `~/.kube/config` (or `$KUBECONFIG`), and `kubectl` on your `PATH`. A green check marks each one it resolves, and **Test** lists the contexts it can see. The rest is the refresh interval and the notification timings: how long something must stay broken before you hear about it, how long an alert is held after it clears so a flapping node only notifies once, how often to repeat, and how long to batch simultaneous alerts into one banner.

> [!NOTE]
> If your kubeconfig authenticates through SSO/OIDC (an exec plugin such as kubelogin), background polling will not pop a browser window at you. Log in once in a terminal and the extension reuses that token. When it expires the menu says so and polls fail quietly until you sign in again.

## How it works

Polling happens inside the compositor process, which means a slow poll is a stuttering desktop. So there are two tiers, chosen by whether the menu is open.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/polling-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/brand/polling-light.svg">
    <img src="docs/images/brand/polling-light.svg" alt="Poll payload over time: about 251 bytes per poll with the menu closed, and roughly 36 KB per node for the few polls while it is open" width="880">
  </picture>
</p>

With the menu closed, which is nearly always, one compact jsonpath query returns about 251 bytes for the whole cluster, and that is the entire steady-state cost. Opening the menu switches to full node detail at roughly 36 KB per node, measured rather than guessed. Rows update in place and the list is capped at 50, sorted most-severe-first, which holds menu-open cost flat however large the cluster gets. Without that cap a 1000-node cluster freezes the shell for nearly two seconds on every open.

An unreachable cluster backs off rather than hammering the network, and a watchdog kills any hung `kubectl` so the menu cannot wedge on "Loading". It also tells your cluster being down apart from your laptop being off the network: with no route there is no outage alert, just a quiet note, and the moment the connection returns it re-polls instead of sitting out the backoff.

Details on the module layering, the alert state machine and the benchmarks behind the row cap: [`docs/architecture.md`](docs/architecture.md). Threat model and trust boundaries: [`SECURITY.md`](SECURITY.md).

## Translations

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/languages-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/brand/languages-light.svg">
    <img src="docs/images/brand/languages-light.svg" alt="Nineteen locales: English, Arabic, German, Spanish, French, Italian, Japanese, Korean, Dutch, Polish, Portuguese for Portugal and Brazil, Russian, Turkish, Ukrainian, and Chinese for the mainland, Hong Kong, Singapore and Taiwan" width="880">
  </picture>
</p>

Eighteen catalogues covering fourteen languages, plus the English source. It follows your desktop's language with nothing to configure. Regional variants fall back to the base language, so `de_AT` and `fr_CA` are covered by `de` and `fr`. Chinese and Portuguese get a catalogue per region because gettext falls back *down* to the bare language but never *sideways*: without `zh_HK` of its own, a Hong Kong desktop would land on English rather than on `zh_TW`.

Kubernetes' own vocabulary stays in English on purpose. `Ready`, `NotReady`, `SchedulingDisabled`, the pressure conditions and node roles are what `kubectl get nodes` prints, and translating them would make the menu disagree with the command it is a window onto.

> [!IMPORTANT]
> English is the source text and is written by hand, as are `ru` and `uk`, which the maintainer reads. The other sixteen catalogues were machine-generated and then checked language by language against their GNOME translation team's conventions. That is review, not native sign-off. Corrections are very welcome and the `Last-Translator` field is yours to claim. See [`docs/translations.md`](docs/translations.md).

## Roadmap

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/brand/roadmap-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/images/brand/roadmap-light.svg">
    <img src="docs/images/brand/roadmap-light.svg" alt="Roadmap: GNOME Shell shipping now, other Linux shells, Windows and macOS planned" width="880">
  </picture>
</p>

The parts that do the thinking, parsing, severity, sorting, scheduling, alerting and formatting, have no `gi://` imports at all. About 40% of the shipped JavaScript. They already run unchanged under Node, plain GJS and gnome-shell, which is what the whole test suite depends on. The rule started life as a testability constraint. It turns out to be a portability one too.

So the plan is to keep that core and rewrite only the edges: KDE Plasma first as a Plasmoid, then a Windows tray app and a macOS menu bar app, each replacing the same three files. No dates on any of it. GNOME Shell stays the reference implementation and gets fixes first.

If you want a particular platform, an issue saying so is the most useful vote there is. If you would rather not wait, fork it. The core is the part worth taking, it is licensed to be taken, and a working port is more convincing than a roadmap entry.

## Development

Tooling needs Node 24 or newer; the extension itself runs on GJS and never touches Node. There is no build step, and TypeScript only type-checks through JSDoc.

```bash
npm install        # dev tooling only: eslint, typescript, @girs types. Never shipped.
npm test           # unit tests
npm run check      # THE GATE: lint + typecheck x2 + 100% coverage + i18n
npm run pack       # -> kube-monitor@cerobreath.dev.shell-extension.zip
```

`npm run check` is what the pre-commit hook and CI both run. Coverage is enforced at 100% by threshold rather than by convention, so a drop fails the build. Conventions a change is expected to follow are in [`AGENTS.md`](AGENTS.md).

Bug reports and pull requests are welcome. For a bug, the extension version, your GNOME Shell version and your `kubectl` version cover most of what is needed to reproduce it.

## License

Distributed under the terms of the [GNU General Public License, version 2 or later](LICENSE). © 2026 Denys Lysenok.
