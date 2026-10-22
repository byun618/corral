#!/bin/sh
# LIFE-690 최종 관문 한 명령 — prep(빌드 사본) → dev-up(기준선 out) → gate.mjs(기준선 회차 → Electron 재기동으로 수정본 → 수정본 회차 → 혼입 대조) → dev-down.
# 종료코드 = gate.mjs 의 것: 0 통과 · 1 기대 어긋남 · 2 무효/중단(번들 정체 불일치·재기동 실패·rpc 실패 등 — 판정 칸에 넣지 않는다).
# 사용: sh scripts/l690/gate.sh <ROOT=/tmp/l690-*>   (app/ 에서, node v24 PATH). 원자료는 <ROOT>/gate/ · <ROOT>/corral.{base.,}ndjson · <ROOT>/*.log.
# GUI 창이 뜬다(키보드 포커스를 가져간다) — 사용자 손 넘김 뒤에만.
set -u
ROOT=$1
case "$ROOT" in /tmp/l690-*) ;; *) echo "ROOT 는 /tmp/l690-*"; exit 2 ;; esac
APP=$(pwd -P); WT=$(cd "$APP/.." && pwd -P)
sh scripts/l690/prep.sh || exit 2
sh scripts/l690/dev-up.sh "$ROOT" /tmp/l690-out-base || { sh scripts/l690/dev-down.sh "$ROOT"; exit 2; }
node scripts/l690/gate.mjs "$ROOT" "$WT"
CODE=$?
echo "gate exit=$CODE"
sh scripts/l690/dev-down.sh "$ROOT"
# 앱 out 을 수정본으로 되돌린다(dev-up 이 기준선으로 바꿨다 — 중간에 멈췄으면 그대로 기준선일 수 있다)
rm -rf "$APP/out" && cp -R /tmp/l690-out-fix "$APP/out"
exit $CODE
