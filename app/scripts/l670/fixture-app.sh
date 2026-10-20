#!/bin/sh
# LIFE-670 — 격리 회차용 앱 사본. 모의 씨앗(CORE: 칸 4 + 칸 없는 상태 1 = 5칸)에 진행 중 상태 2개(QA · Staging)를 덧대 보드 칸 7개로 만든다.
# 수정 1(r1 L5·M1) — 모의 연결에 질의 모양(`jql:` 로 시작)을 주고 질의 검색이 긴 안내(note)+잘림을 돌려주게 해, 필터 줄의 검색 안내를 띄운다(넘침 검사용).
# 제품 소스(src/main/work/mock-source.ts)는 고치지 않는다 — 빌드 산출물 사본(out/main/index.js)의 씨앗·descriptor·searchItems 줄만 바꾼다. app/ 에서(먼저 `npm run build`):
# out/ 이 어느 소스에서 빌드됐는지는 빌드 원자료 머리(git rev-parse HEAD)가 기록한다 — 여기서는 복사 시각의 HEAD·out 시각을 찍는다.
#   sh scripts/l670/fixture-app.sh <DIR=/tmp/l670q-*-app>   → 그 DIR 을 L670_APP_DIR 로 up.sh 에 넘긴다.
set -eu
DIR=$1
case "$DIR" in /tmp/l670q-*) ;; *) echo "DIR 은 /tmp/l670q-*"; exit 2 ;; esac
APP=$(pwd -P)
rm -rf "$DIR"; mkdir -p "$DIR"
cp package.json "$DIR/"; cp -R out "$DIR/out"; ln -s "$APP/node_modules" "$DIR/node_modules"
[ -d resources ] && ln -s "$APP/resources" "$DIR/resources"
ANCHOR='      status({ key: "core-done", label: "Done", category: "done", order: 3 })'
grep -qF "$ANCHOR" "$DIR/out/main/index.js" || { echo "씨앗 줄을 못 찾음"; exit 3; }
node -e '
const fs = require("fs"); const file = process.argv[1]; const anchor = process.argv[2]
const extra = `      status({ key: "core-qa", label: "QA", category: "in_progress", order: 2.1 }),\n      status({ key: "core-staging", label: "Staging", category: "in_progress", order: 2.2 }),\n`
const text = fs.readFileSync(file, "utf8"); fs.writeFileSync(file, text.replace(anchor, extra + anchor))
' "$DIR/out/main/index.js" "$ANCHOR"
grep -c 'core-staging' "$DIR/out/main/index.js" | sed 's/^/patched=/'
node -e '
const fs = require("fs"); const file = process.argv[1]
let text = fs.readFileSync(file, "utf8")
const swap = (from, to) => { if (text.split(from).length !== 2) { console.error("앵커가 하나가 아님: " + from.slice(0, 60)); process.exit(3) } text = text.replace(from, to) }
swap("tokenPrefix: MOCK_TOKEN_PREFIX,\n  keyPattern: \"[A-Z][A-Z0-9]*-\\\\d+\",\n  queryPattern: null", "tokenPrefix: MOCK_TOKEN_PREFIX,\n  keyPattern: \"[A-Z][A-Z0-9]*-\\\\d+\",\n  queryPattern: \"^jql:\"")
swap("return { ok: false, error: workError({ kind: \"unsupported\", message: \"모의 출처에는 질의 검색이 없습니다.\" }) };", "return { ok: true, result: { op: \"searchItems\", items: [], mode: \"text\", note: \"질의를 출처가 거부해 제목 글자로 찾았습니다 — 모의 안내 문구는 넘침 검사를 위해 일부러 길게 둔다(LIFE-670 r1 M1)\", truncated: true } };")
fs.writeFileSync(file, text)
' "$DIR/out/main/index.js"
grep -c 'queryPattern: "^jql:"' "$DIR/out/main/index.js" | sed 's/^/search_patched=/'
echo "copied_at_head=$(git rev-parse HEAD) out_mtime=$(stat -f %Sm -t %FT%T out/main/index.js)"
