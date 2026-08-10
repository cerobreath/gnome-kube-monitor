#!/usr/bin/env bash
set -euo pipefail

UUID="kube-monitor@cerobreath.dev"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$HOME/.local/share/gnome-shell/extensions"
DEST_DIR="$EXT_ROOT/$UUID"

echo "==> Compiling GSettings schema"
glib-compile-schemas "$SRC_DIR/schemas"

# The install is a symlink, so bindtextdomain() looks for locale/ inside this
# checkout. The .mo files are build output, not committed.
echo "==> Compiling translations"
"$SRC_DIR/po/i18n.sh" compile

echo "==> Symlink $DEST_DIR -> $SRC_DIR"
mkdir -p "$EXT_ROOT"
if [ -e "$DEST_DIR" ] && [ ! -L "$DEST_DIR" ]; then
    echo "ERROR: $DEST_DIR exists and is not a symlink; remove it manually." >&2
    exit 1
fi
ln -sfn "$SRC_DIR" "$DEST_DIR"

echo
echo "==> Done."
echo
echo "Enable:    gnome-extensions enable $UUID"
echo "Prefs:     gnome-extensions prefs $UUID"
echo
echo "Wayland: the shell picks up a new extension after you log out and back in."
echo "To test without logging out, run a nested shell:"
echo "    dbus-run-session -- gnome-shell --devkit             # GNOME 49+ (needs mutter-devkit)"
echo "    dbus-run-session -- gnome-shell --nested --wayland   # GNOME 45-49"
echo
echo "Extension logs:"
echo "    journalctl -f -o cat /usr/bin/gnome-shell | grep -i kube"
