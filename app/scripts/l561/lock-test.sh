#!/bin/sh
# LIFE-561 fix3 — 자리 잠금 시험 ⓐ~ⓓ (격리 자리 `CORRAL_DEV_GUARD_BASE=/tmp/l561-lk/base`). 판정은 종료코드(CHECK 하나라도 fail 이면 exit 1).
# 툴체인은 실제 자리의 toolchain/ 을 APFS 복제(cp -c) — 원본은 읽기만. 빌드는 가짜 shasum(30초 sleep) PATH shim 으로 build-terminal-backend.sh 의
# 첫 shasum 에서 붙잡아 둔다(cargo 까지 가지 않는다). 다른 칸은 패치 1바이트를 바꾼 체크아웃 사본(/tmp/l561-lk/repo2, git init)으로 만든다.
#   ⓐ 같은 칸 동시 6개 × 5회 → 매 회 진행 1 · 거절 5    ⓑ 다른 칸 둘 동시 × 5회 → 매 회 진행 1 · 거절 1
#   ⓒ 래퍼 kill -9 × 3회 → 재실행 거절(+안내 문구) → 안내대로 빌더 그룹 확인·정리 뒤 rm → 진행    ⓓ 빈 잠금 × 3회 → 거절
# 매 회 진행한 래퍼는 SIGTERM 으로 끝내고(빌더 그룹 전달) 잠금이 걷혔는지 본다. 사용: sh scripts/l561/lock-test.sh (app/ 에서, node v24 가 PATH 앞에)
set -u
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
APP=$(pwd -P); ROOT=/tmp/l561-lk; BASE=$ROOT/base; LOCK=$BASE/build.lock
REAL=$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev
rm -rf "$ROOT"; mkdir -p "$BASE" "$ROOT/shim" "$ROOT/logs" "$ROOT/repo2/app/scripts"
cp -cR "$REAL/toolchain" "$BASE/toolchain"; echo "clone_exit=$?"
printf '#!/bin/sh\nsleep 30\nexec /usr/bin/shasum "$@"\n' > "$ROOT/shim/shasum"; chmod +x "$ROOT/shim/shasum"
cp scripts/build-dev-guard.mjs scripts/build-terminal-backend.sh "$ROOT/repo2/app/scripts/"; cp -R backend "$ROOT/repo2/app/"
printf '\n' >> "$ROOT/repo2/app/backend/herdr-bundle.patch"; git -C "$ROOT/repo2" init -q
export CORRAL_DEV_GUARD_BASE="$BASE" PATH="$ROOT/shim:$PATH"
# 한 래퍼를 띄운다: $1 = 체크아웃 app 디렉터리, $2 = 로그 이름. pid 를 출력.
start() { node "$1/scripts/build-dev-guard.mjs" > "$ROOT/logs/$2.log" 2>&1 & echo $!; }
# 진행 중인 래퍼 = 잠금에 기록된 wrapper 가 살아 있고 그 로그에 「빌드한다」 가 있다
holder() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).wrapper)}catch{console.log("")}' "$LOCK"; }
builder() { node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).builder??"")}catch{console.log("")}' "$LOCK"; }
wait_builder() { i=0; until [ -n "$(builder)" ]; do i=$((i+1)); [ $i -gt 300 ] && break; sleep 0.1; done; }
stop_winner() { W=$(holder); [ -n "$W" ] && kill -TERM "$W" 2>/dev/null; i=0; while [ -e "$LOCK" ]; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.1; done; }
# 첫 실행은 zig 폴더 점검(archive 목록 대조)이 몇 초 걸린다 — 시험 전에 한 번 진행시켜 표식을 단 뒤 멈춘다(준비 단계, 판정 아님).
P=$(start "$APP" warm); wait_builder; echo "warm wrapper=$P builder=$(builder)"; stop_winner; wait "$P" 2>/dev/null; echo "warm lock_after=$([ -e "$LOCK" ] && echo present || echo gone)"

echo "## ⓐ 같은 칸 동시 6개 × 5회"
r=1; while [ $r -le 5 ]; do
  PIDS=""; n=1; while [ $n -le 6 ]; do PIDS="$PIDS $(start "$APP" a$r-$n)"; n=$((n+1)); done
  wait_builder; sleep 1
  # 끝난 백그라운드 작업은 wait 전까지 좀비라 kill -0 이 참이다 — 진행 여부는 로그의 「빌드한다」 로 센다.
  RUN=$(grep -l '빌드한다' "$ROOT"/logs/a$r-*.log 2>/dev/null | wc -l | tr -d ' ')
  REF=$(grep -l '잠금이 남았다' "$ROOT"/logs/a$r-*.log 2>/dev/null | wc -l | tr -d ' ')
  echo "round $r: running=$RUN refused=$REF holder=$(holder) builder=$(builder)"
  check "a_round${r}_one_winner" "$([ "$RUN" = 1 ] && [ "$REF" = 5 ] && echo 1)"
  stop_winner; for p in $PIDS; do wait "$p" 2>/dev/null; done
  check "a_round${r}_lock_released" "$([ ! -e "$LOCK" ] && echo 1)"
  r=$((r+1)); done

echo "## ⓑ 다른 칸 둘 동시 × 5회 (이 체크아웃 + 패치 1바이트 바꾼 사본)"
r=1; while [ $r -le 5 ]; do
  P1=$(start "$APP" b$r-this); P2=$(start "$ROOT/repo2/app" b$r-other)
  wait_builder; sleep 1
  RUN=$(grep -l '빌드한다' "$ROOT"/logs/b$r-*.log 2>/dev/null | wc -l | tr -d ' ')
  REF=$(grep -l '잠금이 남았다' "$ROOT"/logs/b$r-*.log 2>/dev/null | wc -l | tr -d ' ')
  CELL=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cell)}catch{}' "$LOCK")
  echo "round $r: running=$RUN refused=$REF winner_cell=$CELL"
  check "b_round${r}_one_winner" "$([ "$RUN" = 1 ] && [ "$REF" = 1 ] && echo 1)"
  stop_winner; wait "$P1" 2>/dev/null; wait "$P2" 2>/dev/null
  check "b_round${r}_lock_released" "$([ ! -e "$LOCK" ] && echo 1)"
  r=$((r+1)); done
echo "cells_in_base: $(ls "$BASE" | tr '\n' ' ')"

echo "## ⓒ 래퍼 kill -9 × 3회"
r=1; while [ $r -le 3 ]; do
  P=$(start "$APP" c$r-first); wait_builder; G=$(builder)
  kill -9 "$P"; wait "$P" 2>/dev/null; sleep 0.3
  echo "round $r: killed wrapper=$P builder_group=$G group_alive=$(pgrep -g "$G" >/dev/null && echo yes || echo no) lock=$([ -e "$LOCK" ] && echo present || echo gone)"
  node "$APP/scripts/build-dev-guard.mjs" > "$ROOT/logs/c$r-second.log" 2>&1; RC=$?
  sed "s#$ROOT#<root>#g" "$ROOT/logs/c$r-second.log"
  check "c_round${r}_refused_with_guidance" "$([ $RC = 1 ] && grep -q "rm '" "$ROOT/logs/c$r-second.log" && grep -q "\"builder\":$G" "$ROOT/logs/c$r-second.log" && echo 1)"
  # 안내대로: 빌더 그룹이 돌고 있음을 확인 → 멈춤 → 아무것도 없음을 확인 → rm
  kill -TERM -"$G" 2>/dev/null; i=0; while pgrep -g "$G" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && kill -KILL -"$G"; [ $i -gt 60 ] && break; sleep 0.1; done
  rm "$LOCK"
  P3=$(start "$APP" c$r-third); wait_builder
  check "c_round${r}_proceeds_after_rm" "$([ "$(holder)" = "$P3" ] && [ -n "$(builder)" ] && echo 1)"
  stop_winner; wait "$P3" 2>/dev/null
  r=$((r+1)); done

echo "## ⓓ 빈 잠금 × 3회"
r=1; while [ $r -le 3 ]; do
  : > "$LOCK"
  node "$APP/scripts/build-dev-guard.mjs" > "$ROOT/logs/d$r.log" 2>&1; RC=$?
  sed "s#$ROOT#<root>#g" "$ROOT/logs/d$r.log"
  check "d_round${r}_empty_refused" "$([ $RC = 1 ] && grep -q '(비어 있다)' "$ROOT/logs/d$r.log" && [ -e "$LOCK" ] && [ ! -s "$LOCK" ] && echo 1)"
  rm "$LOCK"; r=$((r+1)); done

echo "## 잔존"
sleep 0.5; LEFT=$(pgrep -fl -- "$ROOT/"; pgrep -fl -- "$APP/scripts/build-terminal-backend.sh"); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
echo "real_cell_list: $(ls "$REAL" | tr '\n' ' ')"
echo "fails=$FAILS"
[ "$FAILS" = 0 ]
