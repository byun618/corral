#!/bin/sh
# LIFE-470 K11 원복의 마지막 — ⑧ 원자료 익명화 + 판정 (R2-03 에서 native-down.sh 에서 떼어 냈다 — 자기점검이 이 부분만 돌린다).
# 익명화기의 종료코드를 **먼저** 잡고, 요약은 로그에서 따로 찍는다. 예전에는 `sanitize | tail -1 && pass` 라 파이프 종료코드가
# tail 의 것이어서 익명화가 실패해도 「✔ raw 익명화」·「판정: 원복 통과」·exit 0 이 나왔다.
# 사용: sh native-down-tail.sh <raw 상위 폴더> <회차 전 백업 ui-prefs.json> <로그 파일> <앞 단계 FAILED(0|1)> [익명화기 .mjs]
set -u
RAWP=$1; BASE=$2; LOG=$3; FAILED=$4
HERE=$(cd "$(dirname "$0")" && pwd)
SANITIZER=${5:-"$HERE/sanitize-raw.mjs"}
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
fail() { echo "✘ $1"; FAILED=1; }; pass() { echo "✔ $1"; }

echo "# ⑧ 원자료 익명화 (LIFE-470 R1-01 — 사용자 경로·ui-prefs 값·캡처를 raw 에 남기지 않는다, 대응표·원본은 /tmp/l470-private)"
"$NODE" "$SANITIZER" "$RAWP" --base-prefs "$BASE" > "$LOG" 2>&1
STATUS=$?
echo "  익명화기 종료코드 $STATUS · 요약: $(tail -1 "$LOG")"
[ "$STATUS" = 0 ] && pass "raw 익명화" || fail "raw 익명화 실패(종료코드 $STATUS, 로그 $LOG)"
[ "$FAILED" = 0 ] && { echo "판정: 원복 통과"; exit 0; } || { echo "판정: 원복 미달"; exit 1; }
