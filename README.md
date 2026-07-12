<!--
  Media for this README lives in docs/images/. Every <!-- MEDIA: ... --> block below
  is a slot: read the brief, drop the file at the given path, done. Screenshots on a
  dark theme read best for a panel extension.
-->

<p align="center">
  <!-- The Kubernetes helm (same path as icons/kubernetes-symbolic.svg), recolored
       per GitHub theme: black on light, white on dark. -->
  <img src="docs/images/logo-dark.svg#gh-light-mode-only" alt="Kube Node Monitor" width="96">
  <img src="docs/images/logo-light.svg#gh-dark-mode-only" alt="Kube Node Monitor" width="96">
</p>

<h1 align="center">Kube Node Monitor</h1>

<p align="center">
  Kubernetes cluster node health in the GNOME top bar.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME_Shell-45--50-4A86CF?style=for-the-badge&logo=gnome&logoColor=white" alt="GNOME Shell 45 to 50">
  <img src="https://img.shields.io/badge/License-GPL--2.0--or--later-blue?style=for-the-badge" alt="License: GPL-2.0-or-later">
  <img src="https://img.shields.io/badge/version-0.1.0-blueviolet?style=for-the-badge" alt="Version 0.1.0">
</p>

<!--
  PUBLISH TODO. Uncomment once the repo is public and the extension is on EGO,
  and fill in <OWNER>/<REPO> and the EGO numeric id:

  <p align="center">
    <a href="https://extensions.gnome.org/extension/<ID>/kube-node-monitor/">
      <img src="https://img.shields.io/badge/Get_it_on-GNOME_Extensions-4A86CF?style=for-the-badge&logo=gnome&logoColor=white" alt="Get it on GNOME Extensions">
    </a>
    <a href="https://github.com/<OWNER>/<REPO>/actions/workflows/ci.yml">
      <img src="https://img.shields.io/github/actions/workflow/status/<OWNER>/<REPO>/ci.yml?style=for-the-badge&label=CI" alt="CI status">
    </a>
  </p>
-->

<p align="center">
  <img src="docs/images/hero.png" alt="Kube Node Monitor: cluster health in the GNOME top bar" width="820">
</p>

<p align="center">
  <a href="docs/images/demo.mp4"><b>▶ Watch the full ~30-second walkthrough</b></a>
</p>

<!-- The still above is a frame from docs/images/demo.mp4, the full ~28s walkthrough
     (open the menu, node meters, click-to-copy, context switcher, preferences).
     To show it as an inline player on GitHub, upload demo.mp4 to a Release (or drag it
     into any issue/PR comment) and paste the resulting user-attachments URL here:
       <video src="https://github.com/user-attachments/assets/…" controls muted width="820"></video>
     A committed-file form also plays once the repo is pushed:
       <video src="https://github.com/<OWNER>/<REPO>/raw/main/docs/images/demo.mp4" controls muted width="820"></video> -->


## Why

You already run `kubectl get nodes` a dozen times a day to check nothing is broken. This shows the same thing on the panel instead: a status dot that stays green while every node is Ready, goes amber when one is degraded, and turns red when a node drops. Open the menu for the detail; the rest of the time it stays quiet.

It reads through the `kubectl` and kubeconfig you already have, so any context and any auth that works in your terminal works here too. It only ever reads: nothing it does can change your cluster.

**Requirements:** GNOME Shell 45 to 50, `kubectl`, and a working kubeconfig. Per-node CPU and memory need metrics-server in the cluster; everything else works without it.

## What it shows

**On the panel:** the Kubernetes helm with a status dot in the corner, tracking the worst node in the cluster. The dot follows your panel's light or dark theme.

<!-- MEDIA: panel-states
  What: a tight crop of just the panel icon in all three states, stacked or side by side:
        green (all Ready), amber (pressure / cordoned), red (a node down). Label each if you can.
  Type: PNG, a single composited strip.
  Size: ~600px wide.
  Drop at: docs/images/panel-states.png
-->
<p align="center">
  <img src="docs/images/panel-states.png" alt="Panel dot: green, amber, red" width="420">
</p>

**In the menu:**

- the current context, a refresh button, and how fresh the data is (`now`, `45s`, `3m`, …);
- a pods line: running, pending, crash-looping, failed;
- your nodes, worst first: dot, name, how long each has been up or down, its role (or the reason it is unhappy), and CPU/memory bars when metrics-server is present;
- a one-click context switcher, then Settings.

Two more things:

- desktop notifications when a node crosses Ready to NotReady, and again when it recovers;
- click any node to copy `kubectl describe node <name>` to the clipboard.

<!-- MEDIA: notification  (screenshot)
  What: the desktop notification "worker-2 is down" from Kube Node Monitor, ideally with
        the panel's red status dot in frame. Trigger it with: docker stop k3d-demo-agent-1.
  Type: PNG.
  Size: ~560px wide.
  Drop at: docs/images/notification.png
-->
<p align="center">
  <img src="docs/images/notification.png" alt="Desktop notification: worker-2 is down" width="480">
</p>

## Install

Not on [extensions.gnome.org](https://extensions.gnome.org) yet. For now, from source:

```bash
git clone <this-repo> kube-monitor && cd kube-monitor
./install.sh
gnome-extensions enable kube-monitor@cerobreath.dev
```

`install.sh` compiles the settings schema and symlinks the folder into `~/.local/share/gnome-shell/extensions`. On Wayland, log out and back in before the shell loads a new extension.

To install from a zip instead: `npm run pack` builds `kube-monitor@cerobreath.dev.shell-extension.zip`, and `gnome-extensions install --force <that-zip>` installs it.

## Settings

```bash
gnome-extensions prefs kube-monitor@cerobreath.dev
```

<!-- MEDIA: prefs
  What: the preferences window with the Connection group: green checks next to kubectl
        and kubeconfig (auto-detected), the context dropdown open, and the Test
        "Connected. Found N contexts" toast if you can catch it.
  Type: PNG.
  Size: ~700px wide.
  Drop at: docs/images/prefs.png
-->
<p align="center">
  <img src="docs/images/prefs.png" alt="Preferences: auto-detected connection" width="560">
</p>

- **Refresh interval**, in seconds.
- **Notify on node up/down.**
- **Context, kubeconfig path(s), kubectl path.** Leave them empty and it detects your current context, `~/.kube/config` (or `$KUBECONFIG`), and `kubectl` on your `PATH`. The window shows a green check next to each one it finds, plus a Test button that lists your contexts.

If your kubeconfig logs in through SSO/OIDC (an exec plugin such as kubelogin), the extension will not open a browser while it polls in the background. Log in once in a terminal and it reuses that token. If the token later expires, a poll fails quietly until you log in again.

## How it works

Polling runs inside the compositor process, so it has to stay cheap. It works in two tiers:

- **Menu closed** (almost always): one small `kubectl` query, about 250 bytes, that feeds the panel dot and the notifications. That is the entire steady-state cost.
- **Menu open:** full node detail, per-node metrics, and the pods summary, fetched only while you are looking. Rows update in place instead of being rebuilt.

If the cluster goes unreachable it backs off instead of hammering the network: 10 seconds, then longer, capped at 5 minutes. Every poll arms a watchdog that kills a hung `kubectl`, so an unreachable cluster cannot wedge the menu on "Loading".

## Layout

```
extension.js     enable/disable, wiring, node up/down notifications
prefs.js         preferences window (libadwaita)
lib/model.js     pure parsers + severity/formatting; no gi imports, unit-tested
lib/schedule.js  poll-cadence math (interval clamp, backoff), unit-tested
lib/client.js    runs kubectl (Gio.Subprocess): health, detail, metrics, pods
lib/poller.js    the poll loop: two-tier fetch, backoff, watchdog, reentrancy
lib/indicator.js panel button + dropdown menu (St/Clutter)
tests/           node --test over lib/model.js and lib/schedule.js; no cluster needed
schemas/         GSettings schema
stylesheet.css   Adwaita palette, light and dark
icons/           the symbolic helm
```

Everything worth testing is pure and free of `gi://` imports, so the parsing and severity logic runs identically under Node, plain gjs, and gnome-shell. That is what the test suite covers.

## Develop

```bash
npm install       # dev tooling only: eslint, typescript, @girs types. Not shipped.
npm test          # unit tests (node --test)
npm run lint      # eslint
npm run typecheck # tsc --checkJs over JSDoc + @girs types
npm run check     # all three; the pre-commit and CI gate
```

There is no build step. The extension ships as the same plain `.js` gnome-shell loads; TypeScript only type-checks through JSDoc. `tsconfig.json` runs strict over the logic, and `tsconfig.ui.json` relaxes strict-null for the GObject view, because widgets are assigned in `_init` and JSDoc cannot mark them definitely-assigned.

To try a shell-side change without logging out, run a nested shell:

```bash
dbus-run-session -- gnome-shell --devkit             # GNOME 49+ (needs the mutter-devkit package)
dbus-run-session -- gnome-shell --nested --wayland   # GNOME 45-48 (--nested was removed in 49)
```

## Packaging

```bash
npm run pack      # → kube-monitor@cerobreath.dev.shell-extension.zip
```

That zip is what you install locally or upload to EGO. CI builds the same one on every push and PR.

## License

[GPL-2.0-or-later](LICENSE), © 2026 Denys Lysenok. The extension imports GNOME Shell, which is GPL-2.0+, so it inherits the same license.
