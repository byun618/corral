#!/bin/sh
# LIFE-485 K4ⓖⓗ·K5 「시작 중」 — 설치 herdr 를 감싼 가짜. `server` 만 모드대로 바꾸고 나머지는 진짜 herdr 로 넘긴다.
# 모드는 이 파일 옆 fake-mode 파일(slow|exit|hang)로 정한다 — 앱 env 가 아니라 파일이라 회차 중에 바꿀 수 있다.
REAL=/opt/homebrew/bin/herdr
MODE=$(cat "$(dirname "$0")/fake-mode" 2>/dev/null || echo pass)
if [ "${1:-}" = server ] && [ "$#" -eq 1 ]; then
  case "$MODE" in
    slow) sleep 4; exec "$REAL" server ;;
    exit) echo "fake herdr: 일부러 바로 종료한다 (exit 1)" >&2; exit 1 ;;
    hang) echo "fake herdr: 소켓을 열지 않고 멈춰 있다" >&2; exec sleep 40 ;;
  esac
fi
exec "$REAL" "$@"
