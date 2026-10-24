#!/bin/sh
# LIFE-693 g1 — 격리 회차용 앱 사본(l691/fixture-app.sh 를 줄여 옮김). 제품 소스는 고치지 않는다 — 빌드 산출물 사본의 한 줄만 바꾼다:
#   main: 창을 `show()` 대신 `showInactive()` 로 띄운다 — 격리 창이 사용자 키보드 포커스를 가져가지 않게.
# 사용(app/ 에서): sh scripts/l693/fixture-app.sh <빌드된 out 폴더(/tmp/l693q-out-impl|base)> <DIR=/tmp/l693q-*-app>
set -eu
OUT=$1; DIR=$2
case "$DIR" in /tmp/l693q-*) ;; *) echo "DIR 은 /tmp/l693q-*"; exit 2 ;; esac
APP=$(pwd -P)
rm -rf "$DIR"; mkdir -p "$DIR"
cp "$APP/package.json" "$DIR/"; cp -R "$OUT" "$DIR/out"; ln -s "$APP/node_modules" "$DIR/node_modules"
[ -d "$APP/resources" ] && ln -s "$APP/resources" "$DIR/resources"
[ -d "$APP/build" ] && ln -s "$APP/build" "$DIR/build"
node -e '
const fs = require("fs")
const file = process.argv[1] + "/out/main/index.js"
const from = "window.on(\"ready-to-show\", () => window?.show());"
const text = fs.readFileSync(file, "utf8")
if (text.split(from).length !== 2) { console.error("앵커가 하나가 아님"); process.exit(3) }
fs.writeFileSync(file, text.replace(from, "window.on(\"ready-to-show\", () => window?.showInactive());"))
' "$DIR"
echo "app_copy=$DIR out=$OUT css=$(ls "$DIR"/out/renderer/assets/*.css | xargs -n1 basename) modal_confirm_close=$(cat "$DIR"/out/renderer/assets/*.css | grep -o modal-confirm-close | wc -l | tr -d ' ')"
grep -c 'showInactive()' "$DIR/out/main/index.js" | sed 's/^/show_inactive=/'
