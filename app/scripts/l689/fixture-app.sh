#!/bin/sh
# LIFE-689 g1 — 격리 회차용 앱 사본(l691/fixture-app.sh 에서 ① 만 남김). 제품 소스는 고치지 않는다 — 빌드 산출물 사본(out/)의 한 줄만 바꾼다:
#   ① main: 창을 `show()` 대신 `showInactive()` 로 띄운다 — 격리 창이 사용자 키보드 포커스를 가져가지 않게(입력은 제어 소켓 sendInputEvent 라 창 포커스와 무관).
# 사용(app/ 에서): sh scripts/l689/fixture-app.sh <원본 app 폴더(out/ 이 빌드된 곳)> <DIR=/tmp/l689g-*-app>
set -eu
SRC=$1; DIR=$2
case "$DIR" in /tmp/l689g-*) ;; *) echo "DIR 은 /tmp/l689g-*"; exit 2 ;; esac
rm -rf "$DIR"; mkdir -p "$DIR"
cp "$SRC/package.json" "$DIR/"; cp -R "$SRC/out" "$DIR/out"; ln -s "$(cd "$SRC" && pwd -P)/node_modules" "$DIR/node_modules"
[ -d "$SRC/resources" ] && ln -s "$(cd "$SRC" && pwd -P)/resources" "$DIR/resources"
[ -d "$SRC/build" ] && ln -s "$(cd "$SRC" && pwd -P)/build" "$DIR/build"
node -e '
const fs = require("fs")
const swap = (file, from, to) => { const text = fs.readFileSync(file, "utf8"); if (text.split(from).length !== 2) { console.error("앵커가 하나가 아님: " + file + " " + from.slice(0, 60)); process.exit(3) } fs.writeFileSync(file, text.replace(from, to)) }
swap(process.argv[1] + "/out/main/index.js", "window.on(\"ready-to-show\", () => window?.show());", "window.on(\"ready-to-show\", () => window?.showInactive());")
' "$DIR"
echo "app_copy=$DIR src=$SRC src_head=$(git -C "$SRC" rev-parse --short HEAD) src_porcelain=$(git -C "$SRC" status --porcelain | wc -l | tr -d ' ') out_mtime=$(stat -f %Sm -t %FT%T "$SRC/out/main/index.js")"
grep -c 'showInactive()' "$DIR/out/main/index.js" | sed 's/^/show_inactive=/'
