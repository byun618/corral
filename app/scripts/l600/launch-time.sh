#!/bin/zsh
# LIFE-600 C14 — 설치본 기동 시간(3회 평균). 2단계 네이티브 관문에서 코디가 사용자와 시점을 맞춰 돌린다:
#   zsh app/scripts/l600/launch-time.sh [/Applications/corral.app] [회차=3] > <원자료 log>
# 한 회차 = `open -a` 직전 ~ 첫 창이 화면에 뜬 순간(System Events 창 수 ≥ 1, ready-to-show → show).
# 회차 사이에 앱을 정상 종료(quit)하고 프로세스가 사라질 때까지 기다린다 — 그래서 시작 전에 앱이 꺼져 있어야 한다
# (켜져 있으면 측정하지 않고 종료코드 2). 앱 기동은 userData 에 쓴다 — 읽기 전용이 아니므로 1단계 기준선에는 쓰지 않았다.
# System Events 창 조회에 손쉬운 사용 권한이 필요하다(처음이면 대화상자). 종료코드: 0 = 전 회차 측정 · 1 = 시간 초과 · 2 = 이미 실행 중.
APP=${1:-/Applications/corral.app}
RUNS=${2:-3}
NAME=corral
now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time' }
running() { pgrep -fq "^$APP/Contents/MacOS/$NAME\$" }  # CLI 도 같은 실행 파일(ELECTRON_RUN_AS_NODE)이라 인자 없는 줄만 앱으로 센다
windows() { osascript -e "tell application \"System Events\" to if exists process \"$NAME\" then count windows of process \"$NAME\"" 2>/dev/null || echo 0 }
if running; then echo "# $NAME 실행 중 — 먼저 종료하고 다시 돌린다"; exit 2; fi
echo "# app=$APP runs=$RUNS version=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)"
echo "# app.asar sha256=$(shasum -a 256 "$APP/Contents/Resources/app.asar" | cut -d' ' -f1)"
total=0
for i in $(seq 1 $RUNS); do
  t0=$(now)
  open -a "$APP"
  ok=0
  for _ in $(seq 1 600); do
    w=$(windows); if [ "${w:-0}" -ge 1 ] 2>/dev/null; then ok=1; break; fi
    sleep 0.05
  done
  t1=$(now)
  if [ $ok -ne 1 ]; then echo "run=$i timeout(>30s)"; exit 1; fi
  ms=$(perl -e "printf '%d', ($t1-$t0)*1000")
  echo "run=$i launch_to_window_ms=$ms"
  total=$((total+ms))
  sleep 3
  osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1
  for _ in $(seq 1 300); do running || break; sleep 0.1; done
  if running; then echo "run=$i quit 시간 초과"; exit 1; fi
  sleep 2
done
echo "avg_ms=$((total/RUNS))"
