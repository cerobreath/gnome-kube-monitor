#!/usr/bin/env bash

set -euo pipefail

UUID="kube-monitor@cerobreath.dev"

glib-compile-schemas --strict --dry-run schemas/
./po/i18n.sh compile

zip -r "$UUID.shell-extension.zip" \
    metadata.json extension.js prefs.js stylesheet.css LICENSE \
    lib icons schemas locale \
    -x 'schemas/gschemas.compiled' '*/.*' '*~' '*.orig' '*.rej'
unzip -l "$UUID.shell-extension.zip"
