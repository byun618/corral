#!/bin/sh
# LIFE-477 r1 R2 자기점검 — native-up.sh(477·470 둘 다)가 서버 기동 **전에** 복구 대상 에이전트 세션을 보고 멈추는지 본다.
# 가짜 HOME(합성 session.json, .nvm 만 실제를 가리키는 링크)에서 돌린다 — 사용자 userData·herdr·provider 는 건드리지 않는다.
#   ⓐ 복구 대상 2개 → exit 7, 「복구될 에이전트 세션」 문구, 백업·herdr 기동 흔적 없음
#   ⓑ 복구 대상 0개 → 복구 검사를 지나 다음 전제(profile 원본 아님, exit 5)에서 멈춘다 = 검사가 진행을 막지 않는다
#   ⓒ 복구 대상 2개 + --allow-session-restore → 역시 다음 전제(exit 5)까지 간다
#   ⓓ (r2) 구형 형식 workspace.panes 의 복구 대상 1개 → exit 7 ⓔ (r2) 모르는 구조 → 허용 플래그를 줘도 exit 7(검사기 exit 8)
# 사용: sh native-up-check.sh — 종료코드 0 = 전부 기대대로
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OK=0
run() { # $1 스크립트 $2 꼬리표 $3 에이전트 유무(1/0) $4 추가 인자
  FH=$(mktemp -d /tmp/l477-upcheck-home-XXXXXX); mkdir -p "$FH/.config/herdr"; ln -s "$HOME/.nvm" "$FH/.nvm"
  if [ "$3" = 1 ]; then AS=',"2":{"cwd":"/synthetic","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"x"}},"3":{"cwd":"/synthetic","agent_session":{"agent":"grok","kind":"id","source":"herdr:grok","value":"y"}}'; else AS=''; fi
  case "$3" in
    legacy) printf '{"version":1,"workspaces":[{"id":"w1","layout":{"Pane":1},"zoomed":false,"panes":{"1":{"cwd":"/synthetic","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"x"}}}}]}' > "$FH/.config/herdr/session.json" ;;
    unknown) printf '{"version":1,"workspaces":[{"id":"w1","panes":{"1":{"cwd":"/synthetic"}}}]}' > "$FH/.config/herdr/session.json" ;;
    *) printf '{"version":1,"workspaces":[{"id":"w1","identity_cwd":"/synthetic","tabs":[{"panes":{"1":{"cwd":"/synthetic"}%s}}]}]}' "$AS" > "$FH/.config/herdr/session.json" ;;
  esac
  case "$1" in l477) ROOT=/tmp/l477n-upcheck-$$-$2 ;; l470) ROOT=/tmp/l470n-upcheck-$$-$2 ;; esac
  OUT=$(HOME="$FH" sh "$HERE/../$1/native-up.sh" "$ROOT" /nonexistent "$ROOT-raw" $4 2>&1); CODE=$?
  BACKUP=$(find "$ROOT/backup" -type f 2>/dev/null | wc -l | tr -d ' ')
  echo "[$1 $2] exit $CODE · 백업 파일 $BACKUP · $(echo "$OUT" | grep -E '✘|count' | tr '\n' ' ' | cut -c1-200)"
  LAST_CODE=$CODE; LAST_OUT=$OUT; LAST_BACKUP=$BACKUP
  rm -rf "$FH" "$ROOT" "$ROOT-raw"
}
for S in l477 l470; do
  run $S a 1 ""; if [ "$LAST_CODE" = 7 ] && [ "$LAST_BACKUP" = 0 ] && echo "$LAST_OUT" | grep -q '"count":2' && echo "$LAST_OUT" | grep -q '복구될 에이전트 세션'; then echo "✔ $S ⓐ 멈춤"; else echo "✘ $S ⓐ"; OK=1; fi
  run $S b 0 ""; if [ "$LAST_CODE" = 5 ] && echo "$LAST_OUT" | grep -q '"count":0'; then echo "✔ $S ⓑ 진행(다음 전제에서 멈춤)"; else echo "✘ $S ⓑ"; OK=1; fi
  run $S c 1 "--allow-session-restore"; if [ "$LAST_CODE" = 5 ] && echo "$LAST_OUT" | grep -q '"allowed":true'; then echo "✔ $S ⓒ 허용 플래그로 진행"; else echo "✘ $S ⓒ"; OK=1; fi
  run $S d legacy ""; if [ "$LAST_CODE" = 7 ] && [ "$LAST_BACKUP" = 0 ] && echo "$LAST_OUT" | grep -q '"count":1'; then echo "✔ $S ⓓ 구형 형식(workspace.panes) 복구 대상 → 멈춤"; else echo "✘ $S ⓓ"; OK=1; fi
  run $S e unknown "--allow-session-restore"; if [ "$LAST_CODE" = 7 ] && [ "$LAST_BACKUP" = 0 ] && echo "$LAST_OUT" | grep -q '구조를 모른다'; then echo "✔ $S ⓔ 모르는 구조 → 허용 플래그로도 멈춤"; else echo "✘ $S ⓔ"; OK=1; fi
done
[ "$OK" = 0 ] && { echo "자기점검 통과"; exit 0; } || { echo "자기점검 실패"; exit 1; }
