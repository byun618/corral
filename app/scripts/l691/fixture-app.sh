#!/bin/sh
# LIFE-691 g1 — 격리 회차용 앱 사본. 제품 소스는 고치지 않는다 — 빌드 산출물 사본(out/)의 두 줄만 바꾼다:
#   ① main: 창을 `show()` 대신 `showInactive()` 로 띄운다 — 격리 창이 사용자 키보드 포커스를 가져가지 않게(입력은 제어 소켓 sendInputEvent 라 창 포커스와 무관).
#   ② preload: getState·getUiPrefs 응답과 첫 onState 수신 시각을 기록하고 `window.corral.l691Order()` 로 읽게 한다(ⓗ 커밋 순서 로그 — preload 기준 도착 순서).
# 사용(app/ 에서): sh scripts/l691/fixture-app.sh <원본 app 폴더(out/ 이 빌드된 곳)> <DIR=/tmp/l691q-*-app>
set -eu
SRC=$1; DIR=$2
case "$DIR" in /tmp/l691q-*) ;; *) echo "DIR 은 /tmp/l691q-*"; exit 2 ;; esac
rm -rf "$DIR"; mkdir -p "$DIR"
cp "$SRC/package.json" "$DIR/"; cp -R "$SRC/out" "$DIR/out"; ln -s "$(cd "$SRC" && pwd -P)/node_modules" "$DIR/node_modules"
[ -d "$SRC/resources" ] && ln -s "$(cd "$SRC" && pwd -P)/resources" "$DIR/resources"
[ -d "$SRC/build" ] && ln -s "$(cd "$SRC" && pwd -P)/build" "$DIR/build"
node -e '
const fs = require("fs")
const swap = (file, from, to) => { const text = fs.readFileSync(file, "utf8"); if (text.split(from).length !== 2) { console.error("앵커가 하나가 아님: " + file + " " + from.slice(0, 60)); process.exit(3) } fs.writeFileSync(file, text.replace(from, to)) }
const dir = process.argv[1]
swap(dir + "/out/main/index.js", "window.on(\"ready-to-show\", () => window?.show());", "window.on(\"ready-to-show\", () => window?.showInactive());")
const pre = dir + "/out/preload/index.cjs"
swap(pre, "getState: () => electron.ipcRenderer.invoke(\"corral:getState\"),", "getState: () => electron.ipcRenderer.invoke(\"corral:getState\").then((v) => { __l691.push({ what: \"getState\", t: performance.now(), tabs: (v?.repos ?? []).flatMap((r) => r.worktrees).reduce((n, w) => n + (w.workspace?.tabs.length ?? 0), 0) }); return v }),")
swap(pre, "getUiPrefs: () => electron.ipcRenderer.invoke(\"corral:getUiPrefs\"),", "getUiPrefs: () => electron.ipcRenderer.invoke(\"corral:getUiPrefs\").then((v) => { __l691.push({ what: \"getUiPrefs\", t: performance.now(), layouts: Array.isArray(v?.groupLayouts) ? v.groupLayouts.length : null }); return v }),")
swap(pre, "onState: (listener) => {\n    const handler = (_event, state) => listener(state);", "onState: (listener) => {\n    const handler = (_event, state) => { if (!__l691.some((e) => e.what === \"onState\")) __l691.push({ what: \"onState\", t: performance.now() }); listener(state) };")
swap(pre, "const api = {", "const __l691 = [];\nconst api = {\n  l691Order: () => __l691.map((e) => ({ ...e })),")
' "$DIR"
echo "app_copy=$DIR src=$SRC src_head=$(git -C "$SRC" rev-parse --short HEAD) out_mtime=$(stat -f %Sm -t %FT%T "$SRC/out/main/index.js")"
grep -c 'showInactive()' "$DIR/out/main/index.js" | sed 's/^/show_inactive=/'
grep -c '__l691' "$DIR/out/preload/index.cjs" | sed 's/^/order_probe_lines=/'
