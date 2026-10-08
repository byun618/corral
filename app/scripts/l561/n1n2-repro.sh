#!/bin/sh
# LIFE-561 fix2 N1·N2 — 공유 툴체인 손상 복구와 빌더를 아는 칸 잠금을 격리 자리에서 본다. 판정은 종료코드(CHECK 하나라도 fail 이면 exit 1).
# 자리: /tmp/l561-n12/base (`CORRAL_DEV_GUARD_BASE`). 툴체인은 실제 자리의 toolchain/ 을 APFS 복제(cp -c)로 가져와 망가뜨린다 — 원본은 읽기만.
#   N1: herdr.tar.gz 를 1바이트로 · zig 폴더에서 파일 하나 지움 · cargo/bin/rustc shim 을 지움(덜 끝난 rustup 설치) → 음성 대조(직접 호출은 sha 실패) → 래퍼가 셋 다 복구하고 빌드
#   N2: 영수증만 지워 재빌드를 부르고, 가짜 shasum(20초 sleep 뒤 진짜 shasum) PATH shim 으로 빌더를 붙잡아 둔다
#       B) 래퍼 kill -9 → 빌더 그룹 생존 → 두 번째 래퍼는 칸을 건드리지 않고 거절 → 그룹 정리
#       C) 래퍼에 SIGTERM → 빌더 그룹에 전달돼 몇 초 안에 끝남 · 잠금 해제
#   끝: shim 없이 래퍼 → built · 다시 → up to date. 본체 칸 sha256 불변.
# 사용: sh scripts/l561/n1n2-repro.sh   (app/ 에서, node v24 가 PATH 앞에)
set -u
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
ROOT=/tmp/l561-n12; BASE=$ROOT/base; TOOLS=$BASE/toolchain
REAL=$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
CELL=$BASE/$KEY; BIN=$CELL/herdr-0.9.0/target/debug/herdr
rm -rf "$ROOT"; mkdir -p "$BASE" "$ROOT/shim"
echo "key=$KEY"; echo "real_cell_sha_before=$(shasum -a 256 "$REAL/$KEY/herdr-0.9.0/target/debug/herdr" | cut -c1-64)"
cp -cR "$REAL/toolchain" "$TOOLS"; echo "clone_exit=$?"
echo "## N1 손상"; printf 'x' > "$TOOLS/herdr.tar.gz"
ZIGVICTIM=zig-aarch64-macos-0.15.2/lib/std/std.zig; rm -f "$TOOLS/$ZIGVICTIM" "$TOOLS/zig-aarch64-macos-0.15.2/.corral-complete"
# run1: rustup/toolchains 를 치우면 rustup 프록시가 스스로 다시 깐다(사전 프로브가 불렀다) — 그 모양은 자가 복구라 대신 shim 하나를 지운다.
rm -f "$TOOLS/cargo/bin/rustc"
ls -l "$TOOLS/herdr.tar.gz" | awk '{print "herdr.tar.gz bytes="$5}'; [ -e "$TOOLS/$ZIGVICTIM" ] && echo zig_victim=present || echo zig_victim=missing
[ -e "$TOOLS/cargo/bin/rustc" ] && echo rustc_shim=present || echo rustc_shim=missing
echo "## N1 음성 대조: 직접 호출은 손상 archive 에서 실패 (기대 exit≠0, FAILED)"
OUT=$(CORRAL_BACKEND_BUILD_ROOT="$CELL" CORRAL_BACKEND_TOOLCHAIN_ROOT="$TOOLS" sh scripts/build-terminal-backend.sh 2>&1); RC=$?
echo "$OUT" | tail -3; echo "direct_exit=$RC"
check direct_fails_on_corrupt "$([ $RC != 0 ] && echo "$OUT" | grep -q 'herdr.tar.gz: FAILED' && echo 1)"
rm -rf "$CELL"
echo "## N1 래퍼 → 복구·빌드 (기대 exit 0)"
s=$(date +%s); OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?
echo "$OUT" | grep -E '^herdr:guard|Finished|FAILED|error\[' ; echo "wrapper_exit=$RC wall_seconds=$(( $(date +%s) - s ))"
check archive_redownloaded "$(echo "$OUT" | grep -q 'herdr.tar.gz 의 sha256 이 맞지 않는다' && echo 1)"
check zig_reextracted "$(echo "$OUT" | grep -q 'zig 폴더가 덜 풀려' && [ -e "$TOOLS/$ZIGVICTIM" ] && echo 1)"
check rustup_reinstalled "$(echo "$OUT" | grep -q 'rustup 설치가 깨져' && [ -x "$TOOLS/cargo/bin/rustc" ] && echo 1)"
check n1_built "$([ $RC = 0 ] && echo "$OUT" | grep -q 'herdr:guard: built' && echo 1)"
check no_part_left "$([ ! -e "$TOOLS/herdr.tar.gz.part" ] && echo 1)"
echo "## N2 준비: 영수증만 지워 재빌드를 부른다 + 느린 shasum shim"
rm -f "$BIN.json"
printf '#!/bin/sh\nsleep 20\nexec /usr/bin/shasum "$@"\n' > "$ROOT/shim/shasum"; chmod +x "$ROOT/shim/shasum"
echo "## N2-B: 래퍼 kill -9 → 고아 빌더 → 두 번째 래퍼 거절"
CORRAL_DEV_GUARD_BASE="$BASE" PATH="$ROOT/shim:$PATH" node scripts/build-dev-guard.mjs > "$ROOT/b1.log" 2>&1 & W1=$!
i=0; until grep -q '"builder":[0-9]' "$BASE/$KEY.lock" 2>/dev/null; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.1; done
echo "lock=$(cat "$BASE/$KEY.lock")"; PG=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).builder)' "$BASE/$KEY.lock")
echo "wrapper_pid=$W1 builder_pgid=$PG"
kill -9 "$W1"; wait "$W1" 2>/dev/null; sleep 0.5
ALIVE=$(pgrep -l -g "$PG" 2>/dev/null); echo "builder_group_after_kill9:"; echo "$ALIVE" | sed "s#$ROOT#<root>#g"
check orphan_builder_alive "$([ -n "$ALIVE" ] && echo 1)"
MARK_BEFORE=$(cat "$CELL/herdr-0.9.0/.corral-patches")
OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?; echo "$OUT" | sed "s#$ROOT#<root>#g"; echo "second_exit=$RC"
check second_refuses "$([ $RC = 1 ] && echo "$OUT" | grep -q "빌더(프로세스 그룹 $PG)" && echo 1)"
check tree_untouched "$([ "$(cat "$CELL/herdr-0.9.0/.corral-patches" 2>/dev/null)" = "$MARK_BEFORE" ] && echo 1)"
kill -TERM -"$PG" 2>/dev/null; i=0; while pgrep -g "$PG" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL -"$PG"; break; }; sleep 0.1; done
echo "## N2-C: 래퍼 SIGTERM → 빌더 그룹으로 전달"
CORRAL_DEV_GUARD_BASE="$BASE" PATH="$ROOT/shim:$PATH" node scripts/build-dev-guard.mjs > "$ROOT/c1.log" 2>&1 & W2=$!
i=0; until grep -q "\"wrapper\":$W2,\"builder\":[0-9]" "$BASE/$KEY.lock" 2>/dev/null; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.1; done
PG2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).builder)' "$BASE/$KEY.lock"); echo "wrapper_pid=$W2 builder_pgid=$PG2"
s=$(python3 -c 'import time;print(time.time())'); kill -TERM "$W2"; wait "$W2"; RC=$?
echo "sigterm_exit=$RC seconds=$(python3 -c "import time;print(round(time.time()-$s,2))")"; sed "s#$ROOT#<root>#g" "$ROOT/c1.log" | grep herdr:guard
sleep 0.3; LEFT=$(pgrep -g "$PG2" 2>/dev/null)
check sigterm_forwarded "$([ $RC != 0 ] && grep -q 'SIGTERM 를 받아' "$ROOT/c1.log" && [ -z "$LEFT" ] && echo 1)"
check lock_released "$([ ! -e "$BASE/$KEY.lock" ] && echo 1)"
echo "## 끝: shim 없이 → built, 다시 → up to date"
OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?; echo "$OUT" | grep '^herdr:guard' | sed "s#$ROOT#<root>#g"
check final_built "$([ $RC = 0 ] && echo "$OUT" | grep -q 'herdr:guard: built' && echo 1)"
OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node scripts/build-dev-guard.mjs 2>&1); RC=$?
check final_up_to_date "$([ $RC = 0 ] && echo "$OUT" | grep -q 'up to date' && echo 1)"
echo "real_cell_sha_after=$(shasum -a 256 "$REAL/$KEY/herdr-0.9.0/target/debug/herdr" | cut -c1-64)"; ls "$REAL"
# run1: 패턴이 `$ROOT` 였을 때 이 스크립트를 기다리던 셸(`/tmp/l561-n12.out` 을 읽음)이 걸렸다 — 루트 아래 경로만 본다.
LEFT=$(pgrep -fl -- "$ROOT/"); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
echo "fails=$FAILS"
[ "$FAILS" = 0 ]
