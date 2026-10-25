#!/bin/sh
# LIFE-692 최종 관문 — 격리 회차용 앱 사본(l691/fixture-app.sh 에서 창 줄만). 제품 소스는 고치지 않는다 — 빌드 산출물 사본(out/)의 한 줄만 바꾼다:
#   main: 창을 `show()` 대신 `showInactive()` 로 띄운다 — 격리 창이 사용자 키보드 포커스를 가져가지 않게(입력은 CDP Input.dispatchKeyEvent 라 창 포커스와 무관).
# 사용(app/ 에서): sh scripts/l692/fixture-app.sh <원본 app 폴더(out/ 이 빌드된 곳)> <DIR=/tmp/l692q-*-app>
set -eu
SRC=$1; DIR=$2
case "$DIR" in /tmp/l692q-*) ;; *) echo "DIR 은 /tmp/l692q-*"; exit 2 ;; esac
rm -rf "$DIR"; mkdir -p "$DIR"
cp "$SRC/package.json" "$DIR/"; cp -R "$SRC/out" "$DIR/out"; ln -s "$(cd "$SRC" && pwd -P)/node_modules" "$DIR/node_modules"
[ -d "$SRC/resources" ] && ln -s "$(cd "$SRC" && pwd -P)/resources" "$DIR/resources"
[ -d "$SRC/build" ] && ln -s "$(cd "$SRC" && pwd -P)/build" "$DIR/build"
node -e '
const fs = require("fs")
const swap = (file, from, to) => { const text = fs.readFileSync(file, "utf8"); if (text.split(from).length !== 2) { console.error("앵커가 하나가 아님: " + file + " " + from.slice(0, 60)); process.exit(3) } fs.writeFileSync(file, text.replace(from, to)) }
swap(process.argv[1] + "/out/main/index.js", "window.on(\"ready-to-show\", () => window?.show());", "window.on(\"ready-to-show\", () => window?.showInactive());")
' "$DIR"
echo "app_copy=$DIR src=$SRC src_head=$(git -C "$SRC" rev-parse --short HEAD) out_mtime=$(stat -f %Sm -t %FT%T "$SRC/out/main/index.js")"
grep -c 'showInactive()' "$DIR/out/main/index.js" | sed 's/^/show_inactive=/'
grep -c 'markdown.togglePreview' "$DIR/out/main/index.js" | sed 's/^/has_629=/'
