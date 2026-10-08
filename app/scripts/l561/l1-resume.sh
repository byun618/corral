#!/bin/sh
# LIFE-561 fix1 L1·L4 — 중단된 칸에서 `herdr:guard` 가 스스로 복구하는지, 칸 잠금이 동시 실행을 막는지 격리 자리에서 본다.
# 자리: /tmp/l561-l1/base (`CORRAL_DEV_GUARD_BASE`). 툴체인은 실제 자리의 toolchain/ 을 APFS 복제(cp -c)로 가져온다 — 원본은 읽기만.
# 본체 `.git/corral-herdr-dev/` 의 칸은 건드리지 않는다. 판정은 종료코드 — CHECK 하나라도 fail 이면 exit 1.
# 사용: sh scripts/l561/l1-resume.sh   (app/ 에서, node v24 가 PATH 앞에)
set -u
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
ROOT=/tmp/l561-l1; BASE=$ROOT/base
REAL=$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev
rm -rf "$ROOT"; mkdir -p "$BASE"
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
CELL=$BASE/$KEY
echo "key=$KEY"
echo "## 툴체인 복제 (원본 읽기만)"; cp -cR "$REAL/toolchain" "$BASE/toolchain"; echo "clone_exit=$?"
echo "## 중단된 칸 만들기 — archive 만 풀고 패치·표식 없음"; mkdir -p "$CELL"; tar -xzf "$BASE/toolchain/herdr.tar.gz" -C "$CELL"; ls -a "$CELL/herdr-0.9.0" | grep -c corral-patches | sed 's/^/marker_files=/'
echo "## 음성 대조: 종전 스크립트 직접 호출은 이 칸을 거절한다 (기대 exit 1, Patch set changed)"
OUT=$(CORRAL_BACKEND_BUILD_ROOT="$CELL" CORRAL_BACKEND_TOOLCHAIN_ROOT="$BASE/toolchain" sh scripts/build-terminal-backend.sh 2>&1); RC=$?
echo "$OUT" | tail -2; echo "direct_exit=$RC"
check direct_refuses "$([ $RC != 0 ] && echo "$OUT" | grep -q 'Patch set changed' && echo 1)"
echo "## L4: 살아 있는 pid 의 잠금 → 래퍼가 빌드하지 않고 멈춘다 (기대 exit 1)"
sleep 60 & HOLDER=$!; printf '%s' "$HOLDER" > "$BASE/$KEY.lock"
OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?
echo "$OUT" | tail -2; echo "locked_exit=$RC"
check lock_blocks "$([ $RC = 1 ] && echo "$OUT" | grep -q "pid $HOLDER" && [ ! -f "$CELL/herdr-0.9.0/.corral-patches" ] && echo 1)"
kill "$HOLDER"; wait "$HOLDER" 2>/dev/null
echo "## L1: 죽은 pid 의 잠금이 남은 채 래퍼 재실행 → 잠금을 걷고, 중단된 트리를 지우고 다시 빌드 (기대 exit 0)"
s=$(date +%s)
OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?
echo "$OUT" | grep -E '^herdr:guard|Finished|error' ; echo "wrapper_exit=$RC wall_seconds=$(( $(date +%s) - s ))"
check wrapper_recovers "$([ $RC = 0 ] && echo "$OUT" | grep -q '중단된 칸의 트리를 지우고' && echo "$OUT" | grep -q 'herdr:guard: built' && echo 1)"
check lock_released "$([ ! -e "$BASE/$KEY.lock" ] && echo 1)"
echo "## 재실행 → up to date (기대 exit 0)"
OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?; echo "$OUT"
check rerun_up_to_date "$([ $RC = 0 ] && echo "$OUT" | grep -q 'up to date' && echo 1)"
echo "## 본체 자리 무변경 (칸 목록·바이너리 sha256)"; ls "$REAL"; shasum -a 256 "$REAL/$KEY/herdr-0.9.0/target/debug/herdr"
echo "fails=$FAILS"
[ "$FAILS" = 0 ]
