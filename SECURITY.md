# Security policy

## Reporting a vulnerability

Please report security issues privately, not as a public issue.

- Preferred: [private vulnerability reporting][ghsa] on this repository
  (Security → Report a vulnerability).
- Otherwise: open an issue containing only "security report, please provide a
  private channel", with no details, and a maintainer will follow up.

Please include the extension version (`metadata.json` → `version-name`), your
GNOME Shell version (`gnome-shell --version`), your `kubectl` version, and what
an attacker would gain. A reproducer helps enormously.

**Do not include real credentials in a report.** If you have a log or an error
string that leaked a token, redact it to the first and last four characters. Rotate
that credential as well, since it must be treated as compromised.

Expect an acknowledgement within a week. There is no bounty programme.

Disclosure is coordinated: a fix ships before details go public, and you are
credited in the release notes unless you ask not to be. If a report goes
unanswered for 30 days, disclose at your own discretion.

[ghsa]: https://github.com/cerobreath/gnome-kube-monitor/security/advisories/new

## Supported versions

Only the latest release is supported. GNOME Shell 45 through 50 are targeted
(`metadata.json` → `shell-version`).

The extension is distributed through extensions.gnome.org, where a new version
waits for review before anyone can install it. The GitHub release carries the
same zip and appears as soon as the tag is pushed, so a fix can be installed by
hand while the reviewed version is still queued.

## What this extension does, and does not, do

Useful context for judging severity:

- **It runs inside the gnome-shell process.** Nothing sandboxes an extension from
  the compositor, so a bug here is a bug in the process that draws your session,
  and a crash takes the session down with it. Only `prefs.js` runs separately.
- **It is read-only against your cluster.** It runs `kubectl get` / `kubectl
  config` and never mutates cluster state. It holds no credentials of its own; it
  uses the kubeconfig you already have.
- **It shells out to `kubectl`**, always via an argv array, never through a
  shell. A poll carries `--request-timeout=5s` and a 12 second watchdog. The node
  watch is a long-lived child that omits the flag on purpose, because it would
  end the stream on expiry and read as a healthy server close; a 30 second
  startup guard, a heartbeat and a 5 minute cross-check bound it instead. An
  explicit `kubectl-path` must be an absolute path to an executable regular file,
  or it is ignored in favour of a PATH lookup.
- **The child environment is an allowlist**, not the session's. The shell's own
  environment (SSH agent socket, bus address, keyring control, anything
  `environment.d` set) is deliberately not forwarded, because `kubectl` passes its
  environment on to exec credential plugins. `DISPLAY`/`WAYLAND_DISPLAY` are
  unset and `BROWSER` neutralised so a background poll cannot pop an OIDC login
  window.
- **Cluster data is untrusted input.** Node names, condition messages and
  kubectl's stderr all reach the menu. Names are shape-checked and length-capped
  before display, error detail is redacted before it is truncated so a cut cannot
  strand half a token, and no label in either process parses Pango markup.
- **Credential material is redacted before display.** A credential plugin's stderr
  is merged into kubectl's, so error text can contain presigned URLs or JWT
  fragments. Anything credential-shaped is stripped before it reaches the menu,
  and notification bodies carry no kubectl detail at all, because GNOME shows
  notification bodies on the lock screen.
- **Nothing is logged by default.** Diagnostics are opt-in (Preferences →
  Advanced); even then, every line is redacted and raw kubectl output is never
  written.
- **Stored data**: in dconf, the context name, the kubeconfig and kubectl paths
  you set, and the node names behind active alerts, so alerts survive a restart.
  No tokens, no server URLs.

### Known trust boundaries (by design, not bugs)

- A kubeconfig may contain an `exec:` stanza, which makes `kubectl` run an
  arbitrary command. Adding an untrusted kubeconfig is equivalent to running that
  command, the same as with `kubectl` in a terminal, except it happens on a timer.
- Settings live in dconf, which has no per-key access control. Any process running
  as your user can change them. `kubectl-path` is validated, but a same-UID
  attacker can already do far more than change a setting.

## Verifying a release

Releases are built from source in CI: a `v*` tag runs the full gate (lint, two
type-check passes, the test suite at 100% coverage, and the translation checks),
then packs and attaches the zip.

The zip ships with a signed build provenance attestation, so it can be tied to
the workflow run and the commit it came from:

```bash
gh attestation verify kube-monitor@cerobreath.dev.shell-extension.zip \
  --repo cerobreath/gnome-kube-monitor
```

CI packs through `.github/pack-zip.sh` instead of `npm run pack`, because
`gnome-extensions` ships inside gnome-shell and CI has no shell installed. Both
produce the same file set, so the contents can still be checked by hand against
the tagged tree.
