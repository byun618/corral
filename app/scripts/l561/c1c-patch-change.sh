#!/bin/sh
# LIFE-561 최종 관문 C1ⓒ — 패치가 바뀐 체크아웃에서 같은 명령(`herdr:guard`)이 거절 없이 새 칸에 빌드한다 + `CORRAL_BACKEND_BUILD_ROOT` 직접 호출(debug)은 종전대로 돈다.
# ① 격리 자리 /tmp/l561-c1c/base: 실제 자리의 툴체인·이 체크아웃 칸을 APFS 복제(원본 읽기만) — 「옛 칸」.
#    패치를 바꾼 체크아웃 사본 /tmp/l561-c1c/repo2(git init): herdr-stream.patch 머리에 주석 한 줄(patch 가 무시하는 앞부분), source.json sha256 갱신.
#    사본의 herdr:guard → 새 칸 이름·built·「use a fresh CORRAL_BACKEND_BUILD_ROOT」 없음·옛 칸 바이너리 sha256 불변.
# ② 새 build root /tmp/l561-dbg 로 build-terminal-backend.sh 직접 호출(debug, CORRAL_BACKEND_TOOLCHAIN_ROOT 없음) → exit 0 · 툴체인(cargo·zig)이 build root 안 · debug 영수증.
# 판정은 종료코드. 사용: sh scripts/l561/c1c-patch-change.sh (app/ 에서, node v24 가 PATH 앞에)
set -u
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
ROOT=/tmp/l561-c1c; BASE=$ROOT/base; R2=$ROOT/repo2/app
REAL=$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
rm -rf "$ROOT" /tmp/l561-dbg; mkdir -p "$BASE" "$R2/scripts"
cp -cR "$REAL/toolchain" "$BASE/toolchain"; cp -cR "$REAL/$KEY" "$BASE/$KEY"
OLD=$(shasum -a 256 "$BASE/$KEY/herdr-0.9.0/target/debug/herdr" | cut -c1-64)
cp scripts/build-dev-guard.mjs scripts/build-terminal-backend.sh "$R2/scripts/"; cp -R backend "$R2/"
{ printf '# LIFE-561 C1c patch-change probe\n'; cat backend/herdr-stream.patch; } > "$R2/backend/herdr-stream.patch"
node -e 'const fs=require("fs"),c=require("crypto");const d=process.argv[1];const s=JSON.parse(fs.readFileSync(d+"/source.json"));s.patchSHA256["herdr-stream.patch"]=c.createHash("sha256").update(fs.readFileSync(d+"/herdr-stream.patch")).digest("hex");fs.writeFileSync(d+"/source.json",JSON.stringify(s,null,2)+"\n")' "$R2/backend"
git -C "$ROOT/repo2" init -q
NEWKEY=$(cd "$R2" && node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
echo "old_key=$KEY new_key=$NEWKEY old_sha=$OLD"
echo "## ① 패치 바뀐 체크아웃에서 herdr:guard"
s=$(date +%s); OUT=$(CORRAL_DEV_GUARD_BASE="$BASE" node "$R2/scripts/build-dev-guard.mjs" 2>&1); RC=$?
echo "$OUT" | grep -E '^herdr:guard|Finished|Patch set|FAILED|patching file .src/pane/terminal' | sed "s#$ROOT#<root>#g"; echo "exit=$RC wall=$(( $(date +%s)-s ))"
check c1c_new_cell "$([ "$NEWKEY" != "$KEY" ] && [ -x "$BASE/$NEWKEY/herdr-0.9.0/target/debug/herdr" ] && echo 1)"
check c1c_built_no_refusal "$([ $RC = 0 ] && echo "$OUT" | grep -q 'herdr:guard: built' && ! echo "$OUT" | grep -q 'fresh CORRAL_BACKEND_BUILD_ROOT' && echo 1)"
check c1c_old_cell_untouched "$([ "$(shasum -a 256 "$BASE/$KEY/herdr-0.9.0/target/debug/herdr" | cut -c1-64)" = "$OLD" ] && echo 1)"
echo "cells: $(ls "$BASE" | tr '\n' ' ')"
echo "## ② CORRAL_BACKEND_BUILD_ROOT 직접 호출(debug, 새 build root, 툴체인 지정 없음)"
s=$(date +%s); CORRAL_BACKEND_BUILD_ROOT=/tmp/l561-dbg sh scripts/build-terminal-backend.sh > "$ROOT/dbg.log" 2>&1; RC=$?
grep -E 'Finished|Managed proof|FAILED|error' "$ROOT/dbg.log" | sed 's#/private/tmp/l561-dbg#<dbg>#g; s#/tmp/l561-dbg#<dbg>#g'; echo "exit=$RC wall=$(( $(date +%s)-s ))"
echo "layout: $(ls /tmp/l561-dbg | tr '\n' ' ')"
check direct_debug_exit0 "$([ $RC = 0 ] && echo 1)"
check direct_debug_toolchain_inside "$([ -x /tmp/l561-dbg/cargo/bin/cargo ] && [ -d /tmp/l561-dbg/zig-aarch64-macos-0.15.2 ] && [ -f /tmp/l561-dbg/herdr.tar.gz ] && echo 1)"
check direct_debug_receipt "$(node -e 'const r=require("/tmp/l561-dbg/herdr-0.9.0/target/debug/herdr.json");process.exit(r.profile==="debug"&&r.binarySHA256?0:1)' && echo 1)"
LEFT=$(pgrep -fl -- "$ROOT/"; pgrep -fl -- "/tmp/l561-dbg/"); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
rm -rf "$ROOT" /tmp/l561-dbg
echo "fails=$FAILS"; [ "$FAILS" = 0 ]
