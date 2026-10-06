#!/bin/sh
# LIFE-516 fix1 R1-05 — native-down.sh 자체 검사. 사용자 userData·herdr 대신 /tmp/l516dt 아래 가짜 폴더로 돌린다
# (L516_DOWN_UD·L516_DOWN_HCFG). 프로세스는 이미 끝난 pid 라 아무것도 죽이지 않는다. provider·G6·grok 해시는 읽기만 한다.
#   case-mismatch : 백업 manifest 의 한 파일 해시를 바꿔 ④ 대조를 실패시킨다 → exit 1 · ⑤ 이후 미실행
#                   (herdr session.json 은 복원되지 않은 채, 새 파일은 지워지지 않은 채 남아야 한다)
#   case-clean    : 무변경 → exit 0 「판정: 원복 통과」
#   case-guard    : 자체 검사 경로가 /tmp/l516 밖이면 exit 2 — 아무 단계도 돌지 않는다
# 사용: sh native-down-selftest.sh <raw 폴더>
set -u
OUT=$1
HERE=$(cd "$(dirname "$0")" && pwd)
L470="$HERE/../l470"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
T=/tmp/l516dt
case "$T" in /tmp/l516*) ;; *) echo "경로 가드"; exit 9 ;; esac
FAILS=0
ok() { echo "✔ $1"; }
bad() { echo "✘ $1"; FAILS=$((FAILS+1)); }

prepare() {
  rm -rf "$T"; mkdir -p "$T/root/backup/ud/sub" "$T/root/backup/herdr" "$T/ud" "$T/herdr" "$T/app"
  printf 'a\n' > "$T/root/backup/ud/settings.json"; printf 'b\n' > "$T/root/backup/ud/sub/x.bin"; printf 'log1\n' > "$T/root/backup/ud/corral.ndjson"
  printf '{"s":1}\n' > "$T/root/backup/herdr/session.json"; printf 'h\n' > "$T/root/backup/herdr/herdr.log"
  cp -Rp "$T/root/backup/ud/." "$T/ud/"; cp -p "$T/root/backup/herdr/herdr.log" "$T/herdr/herdr.log"
  # 회차가 바꾼 것처럼: userData 값 바꿈 · ndjson 늘어남 · herdr session.json 바뀜 · herdr 새 파일 · 로그 늘어남
  printf 'changed\n' > "$T/ud/settings.json"; printf 'log1\nlog2\n' > "$T/ud/corral.ndjson"
  printf '{"s":2}\n' > "$T/herdr/session.json"; printf 'new\n' > "$T/herdr/new-file.txt"; printf 'h\nmore\n' > "$T/herdr/herdr.log"
  "$NODE" "$L470/native-manifest.mjs" "$T/root/backup/ud" > "$T/root/backup/ud-manifest.json"
  "$NODE" "$L470/native-manifest.mjs" "$T/root/backup/herdr" --top > "$T/root/backup/herdr-manifest.json"
  sh -c 'exit 0' & P=$!; wait $P
  echo "$P" > "$T/root/app.pid"; echo "$P" > "$T/root/backend.pid"; echo "$T/app" > "$T/root/app.dir"
}
raw() {
  mkdir -p "$1"
  sh "$L470/provider-hash.sh" > "$1/provider-pre.txt"
  sh "$HERE/g6-hash.sh" > "$1/g6-pre.txt"; cp "$1/g6-pre.txt" "$1/g6-post.txt"
  sh "$HERE/grok-runtime.sh" > "$1/grok-runtime-pre.txt"
}

echo "# case-mismatch"
prepare; R="$OUT/case-mismatch"; raw "$R"
"$NODE" -e "const fs=require('fs');const p=process.argv[1];const m=JSON.parse(fs.readFileSync(p));m.files['sub/x.bin'].sha256='0'.repeat(64);fs.writeFileSync(p,JSON.stringify(m))" "$T/root/backup/ud-manifest.json"
L516_DOWN_UD="$T/ud" L516_DOWN_HCFG="$T/herdr" sh "$HERE/native-down.sh" "$T/root" "$R" > "$R/native-down.txt" 2>&1; RC=$?
cat "$R/native-down.txt"
[ "$RC" -eq 1 ] && ok "exit 1" || bad "exit $RC (기대 1)"
grep -q '✘ userData 복원 후 불일치' "$R/native-down.txt" && ok "④ 불일치에서 실패" || bad "④ 불일치 문구 없음"
grep -q '# ⑤' "$R/native-down.txt" && bad "⑤ 가 실행됐다" || ok "⑤ 이후 미실행"
[ "$(cat "$T/herdr/session.json")" = '{"s":2}' ] && ok "herdr session.json 복원 안 됨(그대로)" || bad "herdr session.json 이 바뀌었다"
[ -f "$T/herdr/new-file.txt" ] && ok "herdr 새 파일 지워지지 않음" || bad "herdr 새 파일이 지워졌다"
[ "$(wc -c < "$T/herdr/herdr.log" | tr -d ' ')" -gt 2 ] && ok "herdr 로그 잘리지 않음" || bad "herdr 로그가 잘렸다"
[ -d "$T/root/backup/ud" ] && ok "백업 남음" || bad "백업 사라짐"

echo "# case-clean"
prepare; R="$OUT/case-clean"; raw "$R"
L516_DOWN_UD="$T/ud" L516_DOWN_HCFG="$T/herdr" sh "$HERE/native-down.sh" "$T/root" "$R" > "$R/native-down.txt" 2>&1; RC=$?
cat "$R/native-down.txt"
[ "$RC" -eq 0 ] && ok "exit 0" || bad "exit $RC (기대 0)"
grep -q '판정: 원복 통과' "$R/native-down.txt" && ok "원복 통과" || bad "통과 판정 없음"
[ ! -f "$T/herdr/new-file.txt" ] && [ "$(cat "$T/herdr/session.json")" = '{"s":1}' ] && ok "herdr 원복됨" || bad "herdr 원복 안 됨"

echo "# case-guard"
R="$OUT/case-guard"; mkdir -p "$R"
L516_DOWN_UD="$HOME/not-tmp" sh "$HERE/native-down.sh" "$T/root" "$R" > "$R/native-down.txt" 2>&1; RC=$?
cat "$R/native-down.txt"
[ "$RC" -eq 2 ] && ok "exit 2" || bad "exit $RC (기대 2)"
grep -q '# ②' "$R/native-down.txt" && bad "단계가 돌았다" || ok "아무 단계도 안 돔"

case "$T" in /tmp/l516*) rm -rf "$T" ;; esac
[ "$FAILS" -eq 0 ] && { echo "판정: 자체 검사 통과"; exit 0; } || { echo "판정: 자체 검사 실패 $FAILS"; exit 1; }
