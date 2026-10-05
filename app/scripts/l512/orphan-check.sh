#!/bin/sh
# LIFE-512 K9 — l511 복사(ROOT 꼴 /tmp/l512n*·잔존 검색어 l512 만 바꿈). 도우미는 ../l470 · ../l477 그대로.
# LIFE-511 K9 — l497 복사(ROOT 꼴 /tmp/l511n*·잔존 검색어 l511 만 바꿈). 도우미는 ../l470 · ../l477 그대로.
# LIFE-497 K6 — l496 복사(ROOT 꼴 /tmp/l497n*·잔존 검색어 l497). 추가: ~/.codex/config.toml 바이트 백업(up)·복원(down, provider 대조 전) — codex 는 자기 config 를 고친다(킥오프 격리 2).
# LIFE-496 K4 — l494 복사(ROOT 꼴 /tmp/l496n*·잔존 검색어 l496 만 바꿈).
# LIFE-493 수정 r3 H2 — 네이티브 회차 뒤 고아 점검 (native-ab-cycle.sh · native-ab-built.sh 공용).
# LIFE-494 r1 R1-04 (= 493 R4-01·02): fixture 인자가 비면 멈춘다(빈 패턴은 모든 줄에 일치해 거짓 양성) ·
# 이 빌드의 Electron 본체·헬퍼 고아도 잡는다(명령줄에 l494 가 없어도 `<app>/node_modules/electron/` 경로로).
# ① 부모가 죽어 PPID 1 이 된 이 일감 프로세스(명령줄에 l494 · fixture 경로 · herdr default 서버 · 이 빌드의 Electron)
# ② fixture 경로를 cwd 로 둔 provider 프로세스(claude·grok·codex)
# 찾은 것마다 `ORPHAN <pid> <설명>` 한 줄. 아무것도 끄지 않는다(보고만).
# 사용: sh orphan-check.sh <fixture 경로> [app 폴더 — 기본 이 스크립트의 app/]
FX=$1
[ -n "$FX" ] || { echo "사용: sh orphan-check.sh <fixture 경로> [app 폴더] — fixture 가 비면 모든 프로세스가 일치해 멈춘다" >&2; exit 2; }
APP=${2:-$(cd "$(dirname "$0")/../.." && pwd)}
[ -n "$APP" ] || { echo "app 폴더를 못 정했다" >&2; exit 2; }
ps -Ao pid=,ppid=,command= | awk '$2==1' | grep -v -e grep -e orphan-check.sh | while read -r pid ppid cmd; do
  case "$cmd" in
    "$APP"/node_modules/electron/*) why="ppid1 electron" ;;
    *l512*|*"$FX"*|*"herdr --session default server"*) why=ppid1 ;;
    *) continue ;;
  esac
  echo "ORPHAN $pid $why $(echo "$cmd" | cut -c1-120)"
done
for p in $(pgrep -x claude) $(pgrep -f "grok|codex"); do
  c=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-)
  case "$c" in "$FX"*) echo "ORPHAN $p cwd $c";; esac
done
