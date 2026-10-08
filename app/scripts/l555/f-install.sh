#!/bin/sh
# LIFE-555 설치(01-criteria 「사용자 기계 변경 계획」) + A1 최종 + A2. 사용: sh f-install.sh <dmg> <원자료 폴더>
# dmg 마운트 → /Applications/corral.app 복사(ditto) → 분리 → ~/.local/bin/corral 심링크. 설치본 cdhash = dmg 안 번들 cdhash.
. "$(dirname "$0")/f-lib.sh"
DMG=$1; OUT=$2; MNT=/tmp/l555f-dmg
[ -e "$INST" ] && { echo "$INST 가 이미 있다 — 덮어쓰지 않고 멈춘다"; exit 2; }
[ -e "$SHIM_LINK" ] && { echo "$SHIM_LINK 가 이미 있다 — 멈춘다"; exit 2; }
echo "dmg=$DMG sha256=$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" > /dev/null; RC=$?; check dmg_attach "$RC" 0
cdhash() { codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
DMG_CDH=$(cdhash "$MNT/corral.app"); echo "dmg 안 번들 CDHash=$DMG_CDH"
ditto "$MNT/corral.app" "$INST"; RC=$?; check ditto_exit0 "$RC" 0
hdiutil detach "$MNT" > /dev/null; RC=$?; check dmg_detach "$RC" 0
mkdir -p "$HOME/.local/bin"; ln -s "$INST/Contents/Resources/bin/corral" "$SHIM_LINK"; RC=$?; check symlink "$RC" 0
ls -l "$SHIM_LINK"
echo "## quarantine xattr"; xattr -l "$INST" | grep -c quarantine | sed 's/^/quarantine_attrs=/'
echo "## A1 Info.plist"
P="$INST/Contents/Info.plist"; pl() { /usr/libexec/PlistBuddy -c "Print :$1" "$P"; }
check CFBundleName "$(pl CFBundleName)" corral
check CFBundleExecutable "$(pl CFBundleExecutable)" corral
check CFBundleIdentifier "$(pl CFBundleIdentifier)" io.github.byun618.corral
check CFBundleShortVersionString "$(pl CFBundleShortVersionString)" "$("$N" -p "require('$APPDIR/package.json').version")"
check icon_file "$(pl CFBundleIconFile)" icon.icns
check icns_exists "$([ -s "$INST/Contents/Resources/icon.icns" ] && echo yes)" yes
echo "## A1 codesign -dv"; codesign -dvvv "$INST" 2>&1 | grep -E '^(Executable|Identifier|Format|CodeDirectory|Signature|CDHash|TeamIdentifier)'
SIG=$(codesign -dv "$INST" 2>&1 | sed -n 's/^Signature=//p'); check signature_adhoc "$SIG" adhoc
check identifier "$(codesign -dv "$INST" 2>&1 | sed -n 's/^Identifier=//p')" io.github.byun618.corral
codesign --verify --deep --strict "$INST"; RC=$?; check verify_deep_strict "$RC" 0
INST_CDH=$(cdhash "$INST"); echo "설치본 CDHash=$INST_CDH"
check cdhash_matches_dmg "$INST_CDH" "$DMG_CDH"
control cdhash_matches_dmg "$INST_CDH" "$(cdhash "$APPDIR/node_modules/electron/dist/Electron.app")"
echo "## A2 fuse (설치본)"; "$N" "$APPDIR/node_modules/.bin/electron-fuses" read --app "$INST" 2>&1 || npx --yes @electron/fuses read --app "$INST"
FUSE=$(npx --yes @electron/fuses read --app "$INST" 2>&1 | grep -c 'RunAsNode is Enabled'); check runAsNode_enabled "$FUSE" 1
control runAsNode_enabled "$(npx --yes @electron/fuses read --app "$INST" 2>&1 | grep -c 'RunAsNode is Disabled')" 1
echo "fails=$FAILS"; exit $FAILS
