#!/usr/bin/env bash
# Translation tooling. Dev-only: nothing in po/ ships with the extension --
# `gnome-extensions pack --podir=po` compiles the catalogues into locale/ and
# includes that instead.
#
#   ./po/i18n.sh pot       regenerate the .pot from the sources
#   ./po/i18n.sh update    merge the .pot into every .po (translators' entry point)
#   ./po/i18n.sh compile   build locale/<lang>/LC_MESSAGES/<uuid>.mo
#   ./po/i18n.sh check     the CI gate: consistent, complete and machine-valid
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

UUID="kube-monitor@cerobreath.dev"
POT="po/$UUID.pot"

# The default keyword set is switched off with a bare --keyword, so extraction
# follows our own wrappers rather than whatever xgettext guesses for JavaScript.
# Getting this list wrong is silent -- a string simply never reaches the .pot --
# which is why `check` compares a fresh extraction against the committed file.
#
#   _        gettext
#   N_       the no-op marker used by the static tables in model.js/indicator.js
#   ngettext (singular, plural)
#   pgettext (context, string)
xgettext_args=(
    --from-code=UTF-8
    --language=JavaScript
    --add-comments=Translators
    --keyword=
    --keyword=_
    --keyword=N_
    --keyword=ngettext:1,2
    --keyword=pgettext:1c,2
    --package-name="Kube Node Monitor"
    --package-version="$(node -p "JSON.parse(require('fs').readFileSync('metadata.json','utf8'))['version-name']")"
    --copyright-holder="Kube Node Monitor contributors"
    --files-from=po/POTFILES.in
    --directory=.
)

# Where a translator should report a bad English string. metadata.json carries no
# `url` yet (the repo is unpublished); the moment it does, the .pot gains the
# header and `check` will ask for a regeneration, which is the reminder we want.
bugs_url="$(node -p "JSON.parse(require('fs').readFileSync('metadata.json','utf8')).url ?? ''")"
[ -n "$bugs_url" ] && xgettext_args+=(--msgid-bugs-address="$bugs_url")

make_pot() {
    xgettext "${xgettext_args[@]}" --output="$1"
    # Replace xgettext's placeholder header, which is boilerplate nobody ever
    # fills in. Done inside make_pot rather than by hand so the committed .pot
    # and the freshness check in `check` produce byte-identical output.
    sed -i \
        -e 's|^# SOME DESCRIPTIVE TITLE\.$|# Translation template for the Kube Node Monitor GNOME Shell extension.|' \
        -e 's|^# Copyright (C) YEAR |# Copyright (C) 2026 |' \
        -e 's|^# FIRST AUTHOR <EMAIL@ADDRESS>, YEAR\.$|# Translators are credited in the Last-Translator field of each po/*.po file.|' \
        "$1"
}

# The languages we ship, in the order LINGUAS lists them.
linguas() { grep -v '^[[:space:]]*#' po/LINGUAS | tr -s '[:space:]' '\n' | grep -v '^$'; }

fail() { echo "i18n: $*" >&2; exit 1; }

# `npm run check` calls into here, so say plainly what is missing rather than
# failing with "xgettext: command not found" from three frames down.
for tool in xgettext msgmerge msgfmt msgattrib; do
    command -v "$tool" >/dev/null ||
        fail "$tool is missing. Install GNU gettext (Debian/Ubuntu: gettext, Arch: gettext)."
done

cmd_pot() {
    make_pot "$POT"
    echo "i18n: wrote $POT ($(grep -c '^msgid "' "$POT") entries)"
}

cmd_update() {
    make_pot "$POT"
    for lang in $(linguas); do
        [ -f "po/$lang.po" ] || fail "po/$lang.po is listed in LINGUAS but missing"
        msgmerge --quiet --previous --update --backup=none "po/$lang.po" "$POT"
    done
    echo "i18n: merged $POT into $(linguas | wc -l) catalogues"
}

cmd_compile() {
    rm -rf locale
    for lang in $(linguas); do
        mkdir -p "locale/$lang/LC_MESSAGES"
        msgfmt --check --output-file="locale/$lang/LC_MESSAGES/$UUID.mo" "po/$lang.po"
    done
    echo "i18n: compiled $(linguas | wc -l) catalogues into locale/"
}

cmd_check() {
    # 1. POTFILES.in must name exactly the shipped JavaScript. A new module with
    #    a translatable string in it would otherwise be missed in silence.
    local listed actual
    listed=$(grep -v '^[[:space:]]*#' po/POTFILES.in | grep -v '^[[:space:]]*$' | sort)
    actual=$(find extension.js prefs.js lib -name '*.js' | sort)
    if [ "$listed" != "$actual" ]; then
        diff <(echo "$listed") <(echo "$actual") || true
        fail 'po/POTFILES.in and the source tree disagree (see the diff above)'
    fi

    # 2. LINGUAS and the .po files on disk must agree, both ways.
    local declared present
    declared=$(linguas | sort)
    present=$(find po -maxdepth 1 -name '*.po' -exec basename {} .po \; | sort)
    if [ "$declared" != "$present" ]; then
        diff <(echo "$declared") <(echo "$present") || true
        fail 'po/LINGUAS and the .po files on disk disagree (see the diff above)'
    fi

    # 3. The committed .pot must match what the sources produce right now. The
    #    creation stamp is the one line that legitimately differs.
    local fresh
    fresh=$(mktemp)
    trap 'rm -f "$fresh"' RETURN
    make_pot "$fresh"
    if ! diff -q <(grep -v '^"POT-Creation-Date:' "$POT") \
                 <(grep -v '^"POT-Creation-Date:' "$fresh") >/dev/null; then
        diff <(grep -v '^"POT-Creation-Date:' "$POT") \
             <(grep -v '^"POT-Creation-Date:' "$fresh") | head -40 || true
        fail "$POT is stale -- run \`npm run i18n:pot\`"
    fi

    # 4. Every catalogue must be machine-valid AND complete. --check-format is
    #    the important one: it catches a translation that dropped or renamed a
    #    %s, which would otherwise reach a user as a missing node name.
    #    Untranslated and fuzzy entries fail too -- msgfmt silently omits both
    #    from the .mo, so "shipped" and "actually translated" must not diverge.
    for lang in $(linguas); do
        msgfmt --check --check-format --check-domain --output-file=/dev/null "po/$lang.po"
        local untranslated fuzzy
        untranslated=$(msgattrib --untranslated --no-obsolete "po/$lang.po" | grep -c '^msgid "' || true)
        fuzzy=$(msgattrib --only-fuzzy --no-obsolete "po/$lang.po" | grep -c '^msgid "' || true)
        # Both counts include the header entry (msgid ""), so 1 means empty.
        [ "$untranslated" -le 1 ] || fail "po/$lang.po has $((untranslated - 1)) untranslated messages"
        [ "$fuzzy" -le 1 ] || fail "po/$lang.po has $((fuzzy - 1)) fuzzy messages needing review"
    done

    echo "i18n: $(linguas | wc -l) catalogues complete and valid; $POT current"
}

case "${1:-}" in
    pot) cmd_pot ;;
    update) cmd_update ;;
    compile) cmd_compile ;;
    check) cmd_check ;;
    *) fail "usage: $0 {pot|update|compile|check}" ;;
esac
