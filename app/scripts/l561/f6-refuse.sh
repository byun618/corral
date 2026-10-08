#!/bin/sh
# LIFE-561 최종 관문 보강 ① — F6 거절 경로 실프로세스 양성 대조. 실제 herdr 서버는 띄우지 않는다.
# 격리 자리 /tmp/l561-f6/base 에 이 체크아웃의 칸을 만들고(실제 칸 바이너리·영수증을 APFS 복제), 영수증을 깨 재빌드가 필요하게 한 뒤,
# 그 칸 바이너리 경로로 시작하는 argv 를 단 가짜 프로세스를 `server`·`--session X server` 두 꼴로 띄워 래퍼가 거절하는지 본다.
# 가짜는 `exec -a "<bin> server" cat`(bash) — 인자 없는 cat 이라 ps args 가 정확히 그 문자열이다. stdin 은 sleep 파이프라 그동안 살아 있다.
# (run1: `exec -a <bin> sleep 60 server` 는 sleep 이 남은 인자를 거부해 즉시 죽었다 — 원자료 s1-f6-refuse-run1-fail.txt)
# 음성 대조: 가짜 프로세스가 없을 때는 거절하지 않고 빌드 단계까지 간다(가짜 shasum shim 으로 붙잡았다가 SIGTERM).
# 판정은 종료코드. 사용: sh scripts/l561/f6-refuse.sh (app/ 에서, node v24 가 PATH 앞에)
set -u
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
ROOT=/tmp/l561-f6; BASE=$ROOT/base
REAL=$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
rm -rf "$ROOT"; mkdir -p "$BASE" "$ROOT/shim"
# 칸 전체를 복제한다(트리 표식 포함 — 거절이 안 되면 래퍼가 트리를 지우지 않고 빌드 단계로 간다). 툴체인도 복제(음성 대조가 다시 받지 않게).
cp -cR "$REAL/$KEY" "$BASE/$KEY"; cp -cR "$REAL/toolchain" "$BASE/toolchain"
BIN=$BASE/$KEY/herdr-0.9.0/target/debug/herdr
break_receipt() { node -e 'const f=process.argv[1];const r=JSON.parse(require("fs").readFileSync(f));r.binarySHA256="0".repeat(64);require("fs").writeFileSync(f,JSON.stringify(r))' "$BIN.json"; }
export CORRAL_DEV_GUARD_BASE="$BASE"
run_with() { # $1 = 꼴 이름, $2.. = argv 꼬리
  label=$1; shift
  break_receipt
  /bin/sleep 60 | /bin/bash -c 'exec -a "$*" /bin/cat' "$BIN" "$BIN" "$@" & sleep 0.5
  FAKE=$(pgrep -f "^$BIN( --session [^ ]+)? server$" | head -1)
  echo "## $label — fake pid ${FAKE:-none} argv: $(ps -o args= -p ${FAKE:-0} | sed "s#$ROOT#<root>#g")"
  OUT=$(node scripts/build-dev-guard.mjs 2>&1); RC=$?; echo "$OUT" | sed "s#$ROOT#<root>#g"; echo "exit=$RC"
  check "refuse_$label" "$([ $RC = 1 ] && echo "$OUT" | grep -q "도는 herdr 서버가 있다 ($FAKE)" && echo 1)"
  check "fake_alive_$label" "$([ -n "$FAKE" ] && echo 1)"
  kill "$FAKE" 2>/dev/null; pkill -P $$ -x sleep 2>/dev/null; wait 2>/dev/null
}
run_with plain server
run_with session --session l561x server
echo "## 음성 대조 — 가짜 서버 없음: 거절하지 않고 빌드 단계로 간다 (shasum shim 으로 붙잡고 SIGTERM)"
printf '#!/bin/sh\nsleep 30\nexec /usr/bin/shasum "$@"\n' > "$ROOT/shim/shasum"; chmod +x "$ROOT/shim/shasum"
break_receipt
PATH="$ROOT/shim:$PATH" node scripts/build-dev-guard.mjs > "$ROOT/neg.log" 2>&1 & W=$!
i=0; until grep -q '"builder":[0-9]' "$BASE/build.lock" 2>/dev/null; do i=$((i+1)); [ $i -gt 600 ] && break; sleep 0.1; done
kill -TERM "$W"; wait "$W"; RC=$?; sed "s#$ROOT#<root>#g" "$ROOT/neg.log" | grep herdr:guard; echo "exit=$RC"
check negative_reaches_build "$(grep -q '빌드한다' "$ROOT/neg.log" && ! grep -q '도는 herdr 서버' "$ROOT/neg.log" && echo 1)"
sleep 0.3; LEFT=$(pgrep -fl -- "$ROOT/"); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
rm -rf "$ROOT"
echo "fails=$FAILS"; [ "$FAILS" = 0 ]
