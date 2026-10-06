#!/bin/bash
# LIFE-485 K4ⓖⓗ·K5 「시작 중」 — 설치 herdr 를 감싼 가짜. `server` 만 모드대로 바꾸고 나머지는 진짜 herdr 로 넘긴다.
# 모드는 이 파일 옆 fake-mode 파일(slow|exit|hang|slowversion)로 정한다 — 앱 env 가 아니라 파일이라 회차 중에 바꿀 수 있다.
REAL=/opt/homebrew/bin/herdr
MODE=$(cat "$(dirname "$0")/fake-mode" 2>/dev/null || echo pass)
# fix3 F8 (r3 R3-01, grok M1 재현) — slowversion: `--version` 이 6초 걸린다(해소가 늦어 첫 조회가 늦는 창)
[ "$MODE" = slowversion ] && [ "${1:-}" = --version ] && sleep 6
# fix3 F9 (r3 R3-02) — 옆 파일 fake-list 가 fail 이면 `session list` 가 실패한다(조회 오류 = 모름). 모드와 따로 켠다
[ "$(cat "$(dirname "$0")/fake-list" 2>/dev/null)" = fail ] && [ "${1:-}" = session ] && [ "${2:-}" = list ] && { echo "fake herdr: session list 일부러 실패" >&2; exit 1; }
if [ "${1:-}" = server ] && [ "$#" -eq 1 ]; then
  case "$MODE" in
    slow) sleep 4; exec "$REAL" server ;;
    exit) echo "fake herdr: 일부러 바로 종료한다 (exit 1)" >&2; exit 1 ;;
    # fix5 (r5 R5-01) — 명령이 진짜 서버처럼 `<이 경로> server` 로 보이게(신원 확인 대상). 짝 없는 FIFO 를 여는 cat 이 막혀 기다린다
    hang) echo "fake herdr: 소켓을 열지 않고 멈춰 있다" >&2; cd "$(dirname "$0")" && { [ -p server ] || mkfifo server; } && exec -a "$0" cat server ;;
  esac
fi
exec "$REAL" "$@"
