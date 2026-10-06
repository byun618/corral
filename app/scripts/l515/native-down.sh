#!/bin/sh
# LIFE-515 K8 — l513 복사(ROOT 꼴 /tmp/l515n*·잔존 검색어 l515 만 바꿈). G6 = l515/g6-hash.sh(q1 범위, 전=후 대조·되쓰지 않음) · ⑥-c grok 런타임 목록(대조 아님).
# LIFE-513 K9 — l512 복사(ROOT 꼴 /tmp/l515n*·잔존 검색어 l513 만 바꿈). 추가: ⑥ 뒤 G6 Ghostty 파일·keybindings 해시 전=후 대조(되쓰지 않는다).
# LIFE-512 K9 — l511 복사(ROOT 꼴 /tmp/l512n*·잔존 검색어 l512 만 바꿈). 도우미는 ../l470 · ../l477 그대로.
# LIFE-511 K9 — l497 복사 · r1 R1-06: ⑥ codex config 를 되쓰지 않고 변경 감지 시 실패
# (원 주석) LIFE-511 K9 — l497 복사(ROOT 꼴 /tmp/l511n*·잔존 검색어 l511 만 바꿈). 도우미는 ../l470 · ../l477 그대로.
# LIFE-497 K6 — l496 복사(ROOT 꼴 /tmp/l497n*·잔존 검색어 l497). 추가: ~/.codex/config.toml 바이트 백업(up)·복원(down, provider 대조 전) — codex 는 자기 config 를 고친다(킥오프 격리 2).
# LIFE-496 K4 — l494 복사(ROOT 꼴 /tmp/l496n*·잔존 검색어 l496 만 바꿈).
# LIFE-494 K4 — LIFE-493 l493/native-down.sh 복사(잔존 검색어 l493→l494 만 바꿈). 그 위 원 주석: LIFE-471 native-down.sh 를 옮겼다(도우미 ../l470). ⑧ 익명화는 뺐다 — 이 회차 raw 는 fixture 탭바 영역만 담는다(선택자 캡처·fixture 탭만 덤프, native-k5.mjs). 원 주석:
# LIFE-470 K11 (LIFE-469 K8 스크립트를 옮겼다) — 원복 (LIFE-468 native-down.sh 의 결을 따르되 범위를 넓혔다). 순서:
#   ② 소유 확인 → Electron·backend 종료 (남의 프로세스면 어떤 복원도 하기 전에 멈춘다, exit 3)
#   ③ 회차가 바꾼 파일 목록(전·후 manifest 차이)을 원자료로
#   ④ userData 전체 바이트 복원(ndjson 은 원래 길이로 잘라 해시 대조) → manifest 전=후 전량 대조
#   ⑤ ~/.config/herdr 최상위: session.json 바이트 복원 · 로그는 원래 길이로 자름 · 새로 생긴 최상위 파일 제거 → 전=후 대조
#   ⑥ provider 설정 대조(복원하지 않는다) ⑦ herdr default stopped · 잔존 프로세스 ⑧ 원자료 익명화·판정(native-down-tail.sh)
# 사용: sh native-down.sh <ROOT> <raw 폴더>
set -u
ROOT=$1; RAWD=$2
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
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
for D in "$APPDIR"; do
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
# LIFE-493 수정 r1 F4 (R1-07) — 덮어쓰기 직전에 사용자 userData 로 떠 있는 corral 을 다시 본다. 실행 중 사용자가 따로 띄웠으면
# 백업 시점으로 덮어써 그 변경을 지우게 된다 → 덮어쓰지 않고 exit 4 로 멈춘다. 백업은 $ROOT/backup 에 그대로 남는다(원복 대기).
OTHER=$(ps -Ao pid=,command= | grep -E 'corral.*(Electron|electron)' | grep -v grep | awk -v a="$A" '$1!=a' || true)
OWNER=$("$NODE" -e "try{const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));try{process.kill(o.pid,0);console.log(o.pid)}catch{console.log('dead')}}catch{console.log('none')}" "$UD/runtime/owner.json")
case "$OWNER" in none|dead|"$A") ;; *) OTHER="$OTHER owner.json pid $OWNER 살아 있음" ;; esac
if [ -n "$(echo "$OTHER" | tr -d ' ')" ]; then
  echo "✘ 사용자 userData 로 corral 이 떠 있다 — 덮어쓰지 않고 멈춘다:"; echo "$OTHER" | cut -c1-200
  echo "원복 대기: 백업 $ROOT/backup/ud (manifest $ROOT/backup/ud-manifest.json) · herdr $ROOT/backup/herdr — 그 corral 을 사용자가 닫은 뒤 이 스크립트를 다시 돌린다"
  echo "판정: 원복 대기 — ④ 전에 멈췄다"; exit 4
fi
pass "사용자 corral 0개 (app $A 제외) · owner $OWNER"
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

echo "# ⑥ codex config·provider 설정 대조 — **쓰지 않는다**(LIFE-511 r1 R1-06: 이 작업은 codex 를 띄우지 않는다, 킥오프 격리 3 읽기 전용)"
# l497 은 codex 를 시험 대상으로 띄워서 그 회차가 고친 config 를 되돌렸다. 여기서는 바뀌었으면 원인이 이 회차 밖(사용자·다른 세션)이라
# 되쓰면 남의 변경을 지운다 — 차이만 원자료로 남기고 실패로 보고한다. 백업은 비교용 사본일 뿐이다.
if [ -f "$ROOT/backup/codex-config.toml" ]; then
  if cmp -s "$ROOT/backup/codex-config.toml" "$HOME/.codex/config.toml"; then pass "codex config 그대로(쓰지 않음)"
  else diff "$ROOT/backup/codex-config.toml" "$HOME/.codex/config.toml" > "$RAWD/codex-config-diff.txt"; fail "codex config 가 회차 중 바뀌었다 — 되쓰지 않는다, 보고(차이 → codex-config-diff.txt)"; fi
fi
sh "$HERE/provider-hash.sh" > "$RAWD/provider-post.txt"
cmp -s "$RAWD/provider-pre.txt" "$RAWD/provider-post.txt" && pass "provider $(wc -l < "$RAWD/provider-post.txt" | tr -d ' ')파일 해시 전=후" || { fail "provider 해시가 바뀌었다 — 되쓰지 않는다, 보고"; diff "$RAWD/provider-pre.txt" "$RAWD/provider-post.txt"; }

echo "# ⑥-b G6(q1 범위) — 읽기만이었다(corral settings.json 은 ④ 바이트 복원), 해시 전=후"
sh "$(dirname "$0")/g6-hash.sh" > "$RAWD/g6-post.txt"
cmp -s "$RAWD/g6-pre.txt" "$RAWD/g6-post.txt" && pass "G6 $(wc -l < "$RAWD/g6-post.txt" | tr -d ' ')파일 해시 전=후" || { fail "G6 해시가 바뀌었다 — 되쓰지 않는다, 보고"; diff "$RAWD/g6-pre.txt" "$RAWD/g6-post.txt"; }

echo "# ⑥-c grok 런타임 목록 — 대조 아님(q1). 바뀐 줄은 K8ⓑ grok 기동의 자체 기록으로 RESULT 에"
sh "$(dirname "$0")/grok-runtime.sh" > "$RAWD/grok-runtime-post.txt"
diff "$RAWD/grok-runtime-pre.txt" "$RAWD/grok-runtime-post.txt" > "$RAWD/grok-runtime-diff.txt" && echo "grok 런타임 변화 없음" || echo "grok 런타임 변화 $(grep -c '^[<>]' "$RAWD/grok-runtime-diff.txt")줄 → grok-runtime-diff.txt (되쓰지 않는다)"

echo "# ⑦ herdr default · 잔존"
HSTAT=$(/opt/homebrew/bin/herdr session list 2>&1 | awk '$1=="default"{print $2}')
[ "$HSTAT" = stopped ] && pass "herdr default stopped" || fail "herdr default $HSTAT"
ps -Ao pid=,ppid=,etime=,command= | grep -E 'l515|Electron.app/Contents/MacOS/Electron|herdr --session default' | grep -v grep | cut -c1-200
[ "$FAILED" = 0 ] && { echo "판정: 원복 통과"; exit 0; } || { echo "판정: 원복 미달"; exit 1; }
