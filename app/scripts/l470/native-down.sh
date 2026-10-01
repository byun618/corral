#!/bin/sh
# LIFE-470 K11 (LIFE-469 K8 스크립트를 옮겼다) — 원복 (LIFE-468 native-down.sh 의 결을 따르되 범위를 넓혔다). 순서:
#   ② 소유 확인 → Electron·backend 종료 (남의 프로세스면 어떤 복원도 하기 전에 멈춘다, exit 3)
#   ③ 회차가 바꾼 파일 목록(전·후 manifest 차이)을 원자료로
#   ④ userData 전체 바이트 복원(ndjson 은 원래 길이로 잘라 해시 대조) → manifest 전=후 전량 대조
#   ⑤ ~/.config/herdr 최상위: session.json 바이트 복원 · 로그는 원래 길이로 자름 · 새로 생긴 최상위 파일 제거 → 전=후 대조
#   ⑥ provider 설정 대조(복원하지 않는다) ⑦ herdr default stopped · 잔존 프로세스 ⑧ 원자료 익명화·판정(native-down-tail.sh)
# 사용: sh native-down.sh <ROOT> <raw 폴더>
set -u
ROOT=$1; RAWD=$2
HERE=$(cd "$(dirname "$0")" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD="$HOME/Library/Application Support/corral"
HCFG="$HOME/.config/herdr"
FAILED=0; fail() { echo "✘ $1"; FAILED=1; }; pass() { echo "✔ $1"; }
abort() { echo "✘ $1"; echo "판정: 원복 중단 — 복원 전에 멈췄다"; exit 3; }
alive() { kill -0 "$1" 2>/dev/null; }
stop() { kill "$1" 2>/dev/null; i=0; while alive "$1"; do i=$((i+1)); [ $i -gt 150 ] && return 1; sleep 0.2; done; return 0; }

echo "# ② 소유 확인 → 종료"
A=$(cat "$ROOT/app.pid" 2>/dev/null) || abort "app.pid 없음"
APPDIR=$(cat "$ROOT/app.dir")
B=$(cat "$ROOT/backend.pid" 2>/dev/null) || abort "backend.pid 없음"
if alive "$A"; then ps -o command= -p "$A" | grep -qF -- "$APPDIR" || abort "app pid $A 가 $APPDIR 의 프로세스가 아니다 — 죽이지 않는다"; fi
if alive "$B"; then ps -o command= -p "$B" | grep -qF -- "/opt/homebrew/bin/herdr --session default server" || abort "backend pid $B 가 우리 herdr 가 아니다 — 죽이지 않는다"; fi
stop "$A" && pass "app $A 종료" || abort "app $A 가 30초 안에 끝나지 않았다"
stop "$B" && pass "backend $B 종료" || abort "backend $B 가 30초 안에 끝나지 않았다"
for D in "$APPDIR" /tmp/l470base/app; do
  LEFT=$(ps -Ao pid=,command= | grep -F -- "$D/node_modules/electron" | grep -v -e grep || true)
  [ -n "$LEFT" ] && abort "Electron 잔존($D): $LEFT"
done
pass "Electron 잔존 없음"

echo "# ③ 회차가 바꾼 파일"
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$RAWD/ud-manifest-after-run.json"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$RAWD/herdr-manifest-after-run.json"
"$NODE" -e "
const fs=require('fs'); const diff=(a,b)=>{const x=JSON.parse(fs.readFileSync(a)).files,y=JSON.parse(fs.readFileSync(b)).files;const keys=[...new Set([...Object.keys(x),...Object.keys(y)])].sort();return keys.filter(k=>JSON.stringify(x[k])!==JSON.stringify(y[k])).map(k=>({file:k,before:x[k]?.size??null,after:y[k]?.size??null}))}
console.log(JSON.stringify({userData:diff(process.argv[1],process.argv[2]),herdr:diff(process.argv[3],process.argv[4])},null,1))
" "$ROOT/backup/ud-manifest.json" "$RAWD/ud-manifest-after-run.json" "$ROOT/backup/herdr-manifest.json" "$RAWD/herdr-manifest-after-run.json" > "$RAWD/changed-by-run.json"
pass "변경 목록 → changed-by-run.json"

echo "# ④ userData 전체 복원 (-c 체크섬 비교 — 1차 원복에서 크기·mtime 이 같은 GPU 캐시 index 3개를 rsync 가 건너뛰었다)"
rsync -a -c --delete --exclude corral.ndjson "$ROOT/backup/ud/" "$UD/" && pass "rsync 복원" || fail "rsync 복원 실패"
"$NODE" -e "
const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1])); const f=process.argv[2]; const want=m.files['corral.ndjson'].size
const have=fs.statSync(f).size; if(have<want){console.log('ndjson 이 원래보다 짧다',have,want);process.exit(1)}
fs.truncateSync(f,want); console.log('ndjson',have,'→',want)" "$ROOT/backup/ud-manifest.json" "$UD/corral.ndjson" || fail "ndjson 자르기 실패"
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$RAWD/ud-manifest-after-restore.json"
"$NODE" -e "
const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1])).files, b=JSON.parse(fs.readFileSync(process.argv[2])).files
const keys=[...new Set([...Object.keys(a),...Object.keys(b)])]; const bad=keys.filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]))
console.log(JSON.stringify({files:keys.length,mismatch:bad})); process.exit(bad.length?1:0)" "$ROOT/backup/ud-manifest.json" "$RAWD/ud-manifest-after-restore.json" && pass "userData 전 파일 해시 전=후" || fail "userData 복원 후 불일치"

echo "# ⑤ ~/.config/herdr 최상위"
cp -p "$ROOT/backup/herdr/session.json" "$HCFG/session.json"
"$NODE" -e "
const fs=require('fs'),path=require('path'); const m=JSON.parse(fs.readFileSync(process.argv[1])).files; const dir=process.argv[2]
for (const name of fs.readdirSync(dir)) { const full=path.join(dir,name); const st=fs.lstatSync(full); if(!st.isFile()) continue
  if(!m[name]){ fs.rmSync(full); console.log('새 파일 제거',name); continue }
  if(st.size>m[name].size && name.endsWith('.log')){ fs.truncateSync(full,m[name].size); console.log('로그 자름',name,st.size,'→',m[name].size) } }
" "$ROOT/backup/herdr-manifest.json" "$HCFG"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$RAWD/herdr-manifest-after-restore.json"
"$NODE" -e "
const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1])).files, b=JSON.parse(fs.readFileSync(process.argv[2])).files
const keys=[...new Set([...Object.keys(a),...Object.keys(b)])]; const bad=keys.filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]))
console.log(JSON.stringify({files:keys.length,mismatch:bad})); process.exit(bad.length?1:0)" "$ROOT/backup/herdr-manifest.json" "$RAWD/herdr-manifest-after-restore.json" && pass "herdr 최상위 해시 전=후" || fail "herdr 최상위 불일치"

echo "# ⑥ provider 설정 대조 (복원하지 않는다)"
sh "$HERE/provider-hash.sh" > "$RAWD/provider-post.txt"
cmp -s "$RAWD/provider-pre.txt" "$RAWD/provider-post.txt" && pass "provider $(wc -l < "$RAWD/provider-post.txt" | tr -d ' ')파일 해시 전=후" || { fail "provider 해시가 바뀌었다 — 되쓰지 않는다, 보고"; diff "$RAWD/provider-pre.txt" "$RAWD/provider-post.txt"; }

echo "# ⑦ herdr default · 잔존"
HSTAT=$(/opt/homebrew/bin/herdr session list 2>&1 | awk '$1=="default"{print $2}')
[ "$HSTAT" = stopped ] && pass "herdr default stopped" || fail "herdr default $HSTAT"
ps -Ao pid=,ppid=,etime=,command= | grep -E 'l470|Electron.app/Contents/MacOS/Electron|herdr --session default' | grep -v grep | cut -c1-200
# ⑧ 원자료 익명화 + 판정 — 익명화기 종료코드를 먼저 잡는다(R2-03, 자기점검 native-down-check.sh)
exec sh "$HERE/native-down-tail.sh" "$(dirname "$RAWD")" "$ROOT/backup/ud/ui-prefs.json" "$ROOT/sanitize.log" "$FAILED"
