#!/usr/bin/env bash
# LIFE-672 native-r8.sh·lockprobe.py·explorer-ms.sh 를 임시 레포·가짜 로그로만 확인한다(본체 checkout·설치본 무접촉).
# app/scripts/l672/verify-native.sh <원자료 폴더>
# r8-a: 1커밋 뒤 clone 에 N=3 → 1회차 ff·2~3회차 「이미 최신」, 전 회차 lock 없음
# r8-b: 시작 전 lock 이 있는 clone(이 시험이 O_EXCL 로 만든 lock) → 종료 3·release-ff 안 부름·lock inode/mtime 그대로
# r8-c: status 루프 경합 중 N=5 (대기 경로 칸이 채워지는지)
# probe: 임시 레포에 status 루프(가짜 부모 명령 이름) 10초 → lock 나타남 ≥1·쥔 프로세스 기록·git status 자식 ≥10
# ms: 가짜 ndjson(교체 전 40·후 40, 다른 root·ok:false·깨진 줄 섞음) → 중앙값·기준 판정, 표본 부족 → 종료 3
set -uo pipefail
OUT="${1:?원자료 폴더}"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$(mktemp -d /tmp/l672nat.XXXXXX)" || exit 1
LOOP=""
cleanup() { [ -n "$LOOP" ] && kill "$LOOP" 2>/dev/null && wait "$LOOP" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
FAILS=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; FAILS=$((FAILS + 1)); fi; }
mk() {  # mk <이름> [파일 수] → $W/<이름>/b 가 origin 보다 1커밋 뒤
  local r="$W/$1" nf="${2:-300}"; mkdir -p "$r"
  g init -q --bare -b main "$r/origin.git"; g clone -q "$r/origin.git" "$r/seed" 2>/dev/null
  for i in $(seq 1 "$nf"); do echo "$i" > "$r/seed/f$i.txt"; done
  g -C "$r/seed" add -A; g -C "$r/seed" commit -qm base; g -C "$r/seed" push -q origin main
  g clone -q "$r/origin.git" "$r/b"
  g -C "$r/seed" commit -q --allow-empty -m next; g -C "$r/seed" push -q origin main
}
echo "# verify-native $(date '+%F %T') · work $W · native-r8.sh sha1 $(shasum "$D/native-r8.sh" | cut -c1-12) · lockprobe.py sha1 $(shasum "$D/lockprobe.py" | cut -c1-12) · explorer-ms.sh sha1 $(shasum "$D/explorer-ms.sh" | cut -c1-12)"

echo "## r8-a"
mk a; "$D/native-r8.sh" --repo "$W/a/b" --out "$OUT/r8-a" --n 3 --gap 0; rc=$?
cat "$OUT/r8-a/runs.tsv"
check "종료 0" '[ $rc = 0 ]'
check "1회차 ff 문구" 'grep -q "fast-forward → origin/main" "$OUT/r8-a/run-1.txt"'
check "2·3회차 이미 최신" 'grep -q "이미 최신" "$OUT/r8-a/run-2.txt" && grep -q "이미 최신" "$OUT/r8-a/run-3.txt"'
check "HEAD = origin" '[ "$(git -C "$W/a/b" rev-parse HEAD)" = "$(git -C "$W/a/b" rev-parse origin/main)" ]'
check "lock 전/후 전부 없음" '[ "$(awk -F"\t" "NR>1 && (\$3!=\"없음\" || \$4!=\"없음\")" "$OUT/r8-a/runs.tsv" | wc -l | tr -d " ")" = 0 ]'

echo "## r8-b (시작 전 lock)"
mk b; L="$W/b/b/.git/index.lock"
python3 -c 'import os,sys; os.close(os.open(sys.argv[1], os.O_CREAT|os.O_EXCL|os.O_WRONLY))' "$L"
before="$(stat -f '%i %m' "$L")"; hb="$(git -C "$W/b/b" rev-parse HEAD)"
"$D/native-r8.sh" --repo "$W/b/b" --out "$OUT/r8-b" --n 3 --gap 0; rc=$?
cat "$OUT/r8-b/runs.tsv"
check "종료 3" '[ $rc = 3 ]'
check "release-ff 안 부름(run-1.txt 없음)" '[ ! -e "$OUT/r8-b/run-1.txt" ]'
check "lock inode·mtime 그대로 ($before)" '[ "$(stat -f "%i %m" "$L")" = "$before" ]'
check "HEAD 불변" '[ "$(git -C "$W/b/b" rev-parse HEAD)" = "$hb" ]'

echo "## r8-c (status 루프 경합)"
mk c; B="$W/c/b"
( unset GIT_OPTIONAL_LOCKS; i=0; while :; do i=$(( i % 300 + 1 )); touch "$B/f$i.txt"; git -C "$B" status --porcelain=v2 --branch >/dev/null 2>&1; done ) &
LOOP=$!; echo "status 루프 pid $LOOP" | tee "$OUT/helper-pids.txt"
# 회차마다 1커밋 뒤로 — native-r8 은 HEAD 를 옮기지 않으니 회차 사이 준비를 이 시험이 따로 못 한다. N=5 중 1회차만 뒤짐
"$D/native-r8.sh" --repo "$B" --out "$OUT/r8-c" --n 5 --gap 0; rc=$?
cat "$OUT/r8-c/runs.tsv"
check "종료 0(시작 전 lock 으로 멈추면 3 — 경합 중이라 그럴 수 있다)" '[ $rc = 0 ] || [ $rc = 3 ]'
check "회차 표에 대기 경로 칸(예/아니오)" 'awk -F"\t" "NR>1 && (\$9==\"예\"||\$9==\"아니오\")" "$OUT/r8-c/runs.tsv" | grep -q .'
kill "$LOOP"; wait "$LOOP" 2>/dev/null; LOOP=""

echo "## probe"
mk p 5000; B="$W/p/b"  # status 가 수십 ms 걸리게(짧으면 ps 표본·lsof 가 못 본다)
# 가짜 부모: 명령 이름이 l672-fake-corral 인 bash 가 git status 를 돈다(설치본 corral 대신 --parent-match 로 맞춘다)
cat > "$W/l672-fake-corral" <<EOF
#!/bin/bash
unset GIT_OPTIONAL_LOCKS
i=0; while :; do i=\$(( i % 5000 + 1 )); touch "$B/f\$i.txt"; git -C "$B" status --porcelain=v2 --branch >/dev/null 2>&1; sleep 0.05; done
EOF
chmod +x "$W/l672-fake-corral"; "$W/l672-fake-corral" & LOOP=$!; echo "가짜 부모 pid $LOOP" | tee -a "$OUT/helper-pids.txt"
python3 "$D/lockprobe.py" --lock "$B/.git/index.lock" --out "$OUT/probe" --seconds 10 --parent-match 'l672-fake-corral'; rc=$?
kill "$LOOP"; wait "$LOOP" 2>/dev/null; LOOP=""
head -3 "$OUT/probe/appearances.ndjson" | cut -c1-400
n="$(wc -l < "$OUT/probe/appearances.ndjson" | tr -d ' ')"; kids="$(awk -F'\t' '$2=="status" || $2=="인자 못 읽음"' "$OUT/probe/status-children.txt" | wc -l | tr -d ' ')"
check "종료 0" '[ $rc = 0 ]'
check "lock 나타남 ≥1 ($n)" '[ "$n" -ge 1 ]'
check "나타남 기록에 크기·inode·lsof 결과" 'grep -q "\"lsof_rc\"" "$OUT/probe/appearances.ndjson" && grep -q "\"inode\"" "$OUT/probe/appearances.ndjson"'
check "쥔 프로세스 또는 그 순간 git 기록이 있는 나타남 ≥1" 'grep -qE "\"lsof_pids\": \[\"[0-9]|\"git_now\": \[\{" "$OUT/probe/appearances.ndjson"'
check "git 자식(status + 인자 못 읽음) ≥10 ($kids)" '[ "$kids" -ge 10 ]'
check "lockprobe 가 lock 을 남기지 않음" '[ ! -e "$B/.git/index.lock" ] || sleep 0.2; [ ! -e "$B/.git/index.lock" ]'

echo "## ms (가짜 ndjson)"
F="$W/fake.ndjson"; SWAP=1792650000000
python3 - "$F" "$SWAP" <<'PY'
import json, sys
f, swap = open(sys.argv[1], "w"), int(sys.argv[2])
for i in range(40):
    f.write(json.dumps({"ts": "x", "at": swap - 100000 + i * 1000, "tag": "explorer.git", "root": "/r", "ms": 20 + i % 5, "ok": True}) + "\n")
    f.write(json.dumps({"ts": "x", "at": swap - 100000 + i * 1000 + 1, "tag": "explorer.git", "root": "/other", "ms": 999, "ok": True}) + "\n")
    f.write(json.dumps({"ts": "x", "at": swap - 100000 + i * 1000 + 2, "tag": "explorer.git", "root": "/r", "ms": 999, "ok": False}) + "\n")
for i in range(40):
    f.write(json.dumps({"ts": "x", "at": swap + 1000 + i * 1000, "tag": "explorer.git", "root": "/r", "ms": 25 + i % 5, "ok": True}) + "\n")
f.write('{"tag":"explorer.git", broken\n')
PY
"$D/explorer-ms.sh" --log "$F" --root /r --swap "$SWAP" | tee "$OUT/ms-ok.txt"; rc=$?
check "종료 0 · 전 중앙값 22 · 후 중앙값 27" '[ $rc = 0 ] && grep -q "중앙값 22" "$OUT/ms-ok.txt" && grep -q "중앙값 27" "$OUT/ms-ok.txt" && grep -q "깨진 줄 1" "$OUT/ms-ok.txt"'
"$D/explorer-ms.sh" --log "$F" --root /r --swap "$SWAP" --n 50 | tee "$OUT/ms-short.txt"; rc=$?
check "표본 부족 → 종료 3" '[ $rc = 3 ]'
python3 -c "
import json
f=open('$W/slow.ndjson','w')
for i in range(30): f.write(json.dumps({'at':1000+i,'tag':'explorer.git','root':'/r','ms':10,'ok':True})+'\n')
for i in range(30): f.write(json.dumps({'at':5000+i,'tag':'explorer.git','root':'/r','ms':16,'ok':True})+'\n')"
"$D/explorer-ms.sh" --log "$W/slow.ndjson" --root /r --swap 4000 | tee "$OUT/ms-slow.txt"; rc=$?
check "후 16 > 10×1.5 → 종료 1" '[ $rc = 1 ]'
"$D/explorer-ms.sh" --log "$W/slow.ndjson" --root /r --swap 1970-01-01T00:00:04Z > "$OUT/ms-iso.txt"; rc=$?
check "ISO 교체 시각도 같은 판정(종료 1)" '[ $rc = 1 ]'
echo "총 실패 검사 $FAILS"
[ "$FAILS" = 0 ]
