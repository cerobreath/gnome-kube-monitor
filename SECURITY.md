# Security policy

## Reporting a vulnerability

Please report security issues privately, not as a public issue.

- Preferred: GitHub's [private vulnerability reporting][ghsa] on this repository
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

[ghsa]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## Supported versions

Only the latest release is supported. GNOME Shell 45 through 50 are targeted
(`metadata.json` → `shell-version`).

## What this extension does, and does not, do

Useful context for judging severity:

- **It is read-only against your cluster.** It runs `kubectl get` / `kubectl
  config` and never mutates cluster state. It holds no credentials of its own; it
  uses the kubeconfig you already have.
- **It shells out to `kubectl`**, always via an argv array (never a shell) with
  `--request-timeout=5s` plus a local watchdog. An explicit `kubectl-path` must be
  an absolute path to an executable regular file, or it is ignored in favour of a
  PATH lookup.
- **The child environment is an allowlist**, not the session's. The shell's own
  environment (SSH agent socket, bus address, keyring control, anything
  `environment.d` set) is deliberately not forwarded, because `kubectl` passes its
  environment on to exec credential plugins. `DISPLAY`/`WAYLAND_DISPLAY` are
  unset and `BROWSER` neutralised so a background poll cannot pop an OIDC login
  window.
- **Credential material is redacted before display.** A credential plugin's stderr
  is merged into kubectl's, so error text can contain presigned URLs or JWT
  fragments. Anything credential-shaped is stripped before it reaches the menu,
  and notification bodies carry no kubectl detail at all, because GNOME shows
  notification bodies on the lock screen.
- **Nothing is logged by default.** Diagnostics are opt-in (Preferences →
  Advanced); even then, every line is redacted and raw kubectl output is never
  written.
- **Stored data**: node names and the context name, in dconf, so alerts survive a
  restart. No tokens, no server URLs.

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
then packs and attaches the zip. `npm run pack` from the tagged commit produces
the same file set, so an upload can be checked against the tree it claims to be.
