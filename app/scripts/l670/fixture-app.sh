#!/bin/sh
# LIFE-670 — 격리 회차용 앱 사본. 모의 씨앗(CORE: 칸 4 + 칸 없는 상태 1 = 5칸)에 진행 중 상태 2개(QA · Staging)를 덧대 보드 칸 7개로 만든다.
# 제품 소스(src/main/work/mock-source.ts)는 고치지 않는다 — 빌드 산출물 사본(out/main/index.js)의 씨앗 줄만 바꾼다. app/ 에서(먼저 `npm run build`):
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
