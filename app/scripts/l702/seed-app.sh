#!/bin/sh
# LIFE-702 최종 관문 ⓖ — 모의 출처 데모 씨앗에 오래된 완료를 심은 앱 사본(l670/fixture-app.sh 방식). 제품 소스는 고치지 않는다 —
# 빌드 산출물 사본(out/main/index.js)의 데모 씨앗 줄만 바꾼다. app/ 에서(먼저 `npx electron-vite build`):
#   sh scripts/l702/seed-app.sh <DIR=/tmp/l702g-*-app>   → 그 DIR 을 gate.mjs 의 [앱 폴더] 로 넘긴다.
# 덧대는 것(CORE 완료 칸, 서버 순서 = rank): CORE-7(g, doneAt null — 기존) · CORE-9(g5, 20일 전 완료 = 숨김) · CORE-10(g7, 3일 전 완료).
# 그리고 데모 쪽 크기 6 → 50(완료 칸 전부가 첫 쪽에 — 「더 불러오기」 없이).
set -eu
DIR=$1
case "$DIR" in /tmp/l702g-*) ;; *) echo "DIR 은 /tmp/l702g-*"; exit 2 ;; esac
APP=$(pwd -P)
rm -rf "$DIR"; mkdir -p "$DIR"
cp package.json "$DIR/"; cp -R out "$DIR/out"; ln -s "$APP/node_modules" "$DIR/node_modules"
[ -d resources ] && ln -s "$APP/resources" "$DIR/resources"
node -e '
const fs = require("fs"); const file = process.argv[1]
let text = fs.readFileSync(file, "utf8")
const swap = (from, to) => { if (text.split(from).length !== 2) { console.error("앵커가 하나가 아님: " + from.slice(0, 60)); process.exit(3) } text = text.replace(from, to) }
const m9 = "{ ...base, id: \"m-9\", key: \"CORE-8\", spaceKey: \"CORE\", title: \"백로그 아이디어\", kind: story, statusKey: \"core-todo\", rank: \"h\", placement: \"backlog\" }"
swap(m9, m9 + ",\n    { ...base, id: \"m-10\", key: \"CORE-9\", spaceKey: \"CORE\", title: \"L702 숨긴 이웃(20일 완료)\", kind: story, statusKey: \"core-done\", resolution: \"completed\", rank: \"g5\", placement: \"board\", doneAt: new Date(Date.now() - 20 * 864e5).toISOString() },\n    { ...base, id: \"m-11\", key: \"CORE-10\", spaceKey: \"CORE\", title: \"L702 보이는 이웃(3일 완료)\", kind: story, statusKey: \"core-done\", resolution: \"completed\", rank: \"g7\", placement: \"board\", doneAt: new Date(Date.now() - 3 * 864e5).toISOString() }")
swap("state.pageSize = 6;", "state.pageSize = 50;")
fs.writeFileSync(file, text)
' "$DIR/out/main/index.js"
grep -c 'L702 숨긴 이웃' "$DIR/out/main/index.js" | sed 's/^/seeded=/'
echo "copied_at_head=$(git rev-parse HEAD) out_mtime=$(stat -f %Sm -t %FT%T out/main/index.js)"
