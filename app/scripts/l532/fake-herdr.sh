#!/bin/bash
# LIFE-532 최종 관문 — 진짜 herdr(brew 0.9.0)를 감싼 가짜. 이 파일 옆(ROOT) 의 손잡이 파일로 회차 중에 거동을 바꾼다.
#   fake-list    = fail 이면 `session list` 가 exit 1 (조회 오류)
#   fake-xdg     = 있으면 진짜 herdr 에 그 XDG_CONFIG_HOME 을 준다 (앱 XDG 가 긴 심링크 경로일 때 서버·CLI 는 짧은 실제 경로를 본다)
#   fake-rewrite = "<from>|<to>" 이면 `session list` 출력의 경로 문자열을 바꾼다 (소켓 경로를 길게 보여 링크 failed 를 만든다)
D=$(cd "$(dirname "$0")" && pwd); REAL=/opt/homebrew/bin/herdr
[ -f "$D/fake-xdg" ] && export XDG_CONFIG_HOME="$(cat "$D/fake-xdg")"
if [ "${1:-}" = session ] && [ "${2:-}" = list ]; then
  [ "$(cat "$D/fake-list" 2>/dev/null)" = fail ] && { echo "fake herdr: session list 일부러 실패 (l532)" >&2; exit 1; }
  if [ -s "$D/fake-rewrite" ]; then
    R=$(cat "$D/fake-rewrite"); FROM=${R%%|*}; TO=${R#*|}
    OUT=$("$REAL" "$@") || exit $?
    printf '%s\n' "${OUT//$FROM/$TO}"; exit 0
  fi
fi
exec "$REAL" "$@"
