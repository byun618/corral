#!/bin/sh
# LIFE-490 K8 — l485/native-down.sh 복사(코드 줄의 l485→l490·L485→L490·ROOT 꼴 /tmp/l490n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 K8ⓒ — l527/native-down.sh 복사·수정(02-kickoff 격리 6): corral 이 띄운 default 서버를 찾아(<ROOT>/server.pid — native-n2 가 프로세스 표에서 적는다,
# backend.pid 는 없다) 멈추고 running:false 확인 뒤 session.json 바이트·userData·herdr 최상위 복원 → 전 = 후. 재개된 provider 프로세스 잔존도 본다.
# 원복·해시 실패는 그 자리에서 exit 1(백업·원자료를 남긴다). 아래는 l527 원 주석.
# LIFE-527 K9 — l526 복사(코드 줄의 잔존 검색어 l526→l527·ROOT 꼴 /tmp/l527n*·이 빌드 경로·L526_ 환경변수 이름만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-526 K4ⓐ — l516 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l526·이 빌드 경로만 sed 로 바꿈). 아래는 원 주석.
# LIFE-515 K8 — l513 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l515 만 바꿈). G6 = l515/g6-hash.sh(q1 범위, 전=후 대조·되쓰지 않음) · ⑥-c grok 런타임 목록(대조 아님).
# LIFE-513 K9 — l512 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l513 만 바꿈). 추가: ⑥ 뒤 G6 Ghostty 파일·keybindings 해시 전=후 대조(되쓰지 않는다).
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
# LIFE-516 fix1 R1-05 — 원복·해시 실패(복원 명령 실패·manifest 불일치·읽기 오류·대조 실패)는 **그 자리에서 exit 1 로 멈춘다**(q1 조건 2
# 「하나라도 어긋나면 즉시 멈춘다」). 이후 복원·삭제·자르기 단계를 진행하지 않고, 백업($ROOT/backup)·원자료를 그대로 남긴다.
# l515 원본(fail 이 FAILED=1 만 세우고 계속)은 다른 작업 산출물이라 고치지 않았다.
# 자체 검사용: L526_DOWN_UD·L526_DOWN_HCFG 로 userData·herdr 경로를 바꿀 수 있다 — /tmp/l526 아래만 받는다(native-down-selftest.sh).
set -u
ROOT=$1; RAWD=$2
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD=${L490_DOWN_UD:-"$HOME/Library/Application Support/corral"}
HCFG=${L490_DOWN_HCFG:-"$HOME/.config/herdr"}
# fix5 — 삭제·복원 대상(L526_DOWN_UD·L526_DOWN_HCFG — rsync --delete·새 파일 rmSync)과 원본 ROOT 를 접두 문자열만으로 받지 않는다(R5-01 같은 꼴).
# 정규형이고 실제 폴더이며 심링크를 푼 실경로도 허용 범위 안이어야 한다. 아니면 아무것도 죽이거나 복원하기 전에 exit 2.
. "$(dirname "$0")/path-check.sh"
for P in "${L490_DOWN_UD:-}" "${L490_DOWN_HCFG:-}"; do
  [ -z "$P" ] && continue
  l490_real_dir "$P" /tmp/l490 || { echo "✘ 자체 검사 경로는 /tmp/l490 아래 정규형 실제 폴더만: $P"; exit 2; }
done
l490_real_dir "$ROOT" /tmp/l490n || { echo "✘ ROOT 는 /tmp/l490n 아래 정규형 실제 폴더만: $ROOT"; exit 2; }
fail() { echo "✘ $1"; echo "판정: 원복 중단 — 그 자리에서 멈췄다(이후 단계 미실행). 백업 $ROOT/backup·원자료 $RAWD 그대로"; exit 1; }
pass() { echo "✔ $1"; }
abort() { echo "✘ $1"; echo "판정: 원복 중단 — 복원 전에 멈췄다"; exit 3; }
alive() { kill -0 "$1" 2>/dev/null; }
stop() { kill "$1" 2>/dev/null; i=0; while alive "$1"; do i=$((i+1)); [ $i -gt 150 ] && return 1; sleep 0.2; done; return 0; }

echo "# ② 소유 확인 → 종료"
A=$(cat "$ROOT/app.pid" 2>/dev/null) || abort "app.pid 없음"
APPDIR=$(cat "$ROOT/app.dir")
B=$(cat "$ROOT/server.pid" 2>/dev/null)
if alive "$A"; then ps -o command= -p "$A" | grep -qF -- "$APPDIR" || abort "app pid $A 가 $APPDIR 의 프로세스가 아니다 — 죽이지 않는다"; stop "$A" && pass "app $A 종료" || abort "app $A 가 30초 안에 끝나지 않았다"; else pass "app $A 이미 종료"; fi
if [ -n "$B" ] && alive "$B"; then
  ps -o command= -p "$B" | grep -qxF -- "/opt/homebrew/bin/herdr server" || abort "server pid $B 가 corral 이 띄운 설치 herdr default 서버가 아니다 — 죽이지 않는다"
  /opt/homebrew/bin/herdr server stop; i=0; while alive "$B"; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
  alive "$B" && { stop "$B" && pass "server $B kill 로 종료" || abort "server $B 가 끝나지 않았다"; } || pass "server $B 종료(herdr server stop)"
else pass "server pid 없음·이미 종료(${B:-없음})"; fi
HSTAT=$(/opt/homebrew/bin/herdr session list 2>&1 | awk '$1=="default"{print $2}')
[ "$HSTAT" = stopped ] && pass "herdr default stopped (원복 전)" || abort "herdr default $HSTAT — 복원하지 않고 멈춘다"
if [ -s "$RAWD/restored-agents.txt" ]; then while read -r pid ppid cmd; do [ -n "$pid" ] || continue; alive "$pid" && echo "재개 provider $pid 잔존($(echo "$cmd" | cut -c1-60))" || echo "재개 provider $pid 종료"; done < "$RAWD/restored-agents.txt"; fi
for D in "$APPDIR"; do
  LEFT=$(ps -Ao pid=,command= | grep -F -- "$D/node_modules/electron" | grep -v -e grep || true)
  [ -n "$LEFT" ] && abort "Electron 잔존($D): $LEFT"
done
pass "Electron 잔존 없음"

echo "# ③ 회차가 바꾼 파일"
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$RAWD/ud-manifest-after-run.json" || fail "userData manifest 읽기 실패(회차 뒤)"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$RAWD/herdr-manifest-after-run.json" || fail "herdr manifest 읽기 실패(회차 뒤)"
"$NODE" -e "
const fs=require('fs'); const diff=({before,after})=>{const x=JSON.parse(fs.readFileSync(before)).files,y=JSON.parse(fs.readFileSync(after)).files;const keys=[...new Set([...Object.keys(x),...Object.keys(y)])].sort();return keys.filter(k=>JSON.stringify(x[k])!==JSON.stringify(y[k])).map(k=>({file:k,before:x[k]?.size??null,after:y[k]?.size??null}))}
console.log(JSON.stringify({userData:diff({before:process.argv[1],after:process.argv[2]}),herdr:diff({before:process.argv[3],after:process.argv[4]})},null,1))
" "$ROOT/backup/ud-manifest.json" "$RAWD/ud-manifest-after-run.json" "$ROOT/backup/herdr-manifest.json" "$RAWD/herdr-manifest-after-run.json" > "$RAWD/changed-by-run.json" || fail "변경 목록 만들기 실패"
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
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$RAWD/ud-manifest-after-restore.json" || fail "userData manifest 읽기 실패(원복 뒤)"
"$NODE" -e "
const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1])).files, b=JSON.parse(fs.readFileSync(process.argv[2])).files
const keys=[...new Set([...Object.keys(a),...Object.keys(b)])]; const bad=keys.filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]))
console.log(JSON.stringify({files:keys.length,mismatch:bad})); process.exit(bad.length?1:0)" "$ROOT/backup/ud-manifest.json" "$RAWD/ud-manifest-after-restore.json" && pass "userData 전 파일 해시 전=후" || fail "userData 복원 후 불일치"

echo "# ⑤ ~/.config/herdr 최상위"
cp -p "$ROOT/backup/herdr/session.json" "$HCFG/session.json" || fail "herdr session.json 복원 실패"
"$NODE" -e "
const fs=require('fs'),path=require('path'); const m=JSON.parse(fs.readFileSync(process.argv[1])).files; const dir=process.argv[2]
for (const name of fs.readdirSync(dir)) { const full=path.join(dir,name); const st=fs.lstatSync(full); if(!st.isFile()) continue
  if(!m[name]){ fs.rmSync(full); console.log('새 파일 제거',name); continue }
  if(st.size>m[name].size && name.endsWith('.log')){ fs.truncateSync(full,m[name].size); console.log('로그 자름',name,st.size,'→',m[name].size) } }
" "$ROOT/backup/herdr-manifest.json" "$HCFG" || fail "herdr 최상위 정리 실패"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$RAWD/herdr-manifest-after-restore.json" || fail "herdr manifest 읽기 실패(원복 뒤)"
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
sh "$HERE/provider-hash.sh" > "$RAWD/provider-post.txt" || fail "provider 해시 읽기 실패"
cmp -s "$RAWD/provider-pre.txt" "$RAWD/provider-post.txt" && pass "provider $(wc -l < "$RAWD/provider-post.txt" | tr -d ' ')파일 해시 전=후" || { diff "$RAWD/provider-pre.txt" "$RAWD/provider-post.txt"; fail "provider 해시가 바뀌었다 — 되쓰지 않는다, 보고"; }

echo "# ⑥-b G6(q1 범위) — 읽기만이었다(corral settings.json 은 ④ 바이트 복원), 해시 전=후"
# fix1 R1-01 — 경로 합집합 대조·수집기 실패·빈/손상 snapshot 실패(g6-compare.mjs)
"$NODE" "$(dirname "$0")/g6-compare.mjs" "$RAWD/g6-pre.txt" "$RAWD/g6-post.txt" > "$RAWD/g6-compare.txt"; G6RC=$?
cat "$RAWD/g6-compare.txt"
[ "$G6RC" -eq 0 ] && pass "G6 엄격 범위 전=후(g6-compare.mjs)" || fail "G6 대조 실패(exit $G6RC) — 되쓰지 않는다, 보고"

echo "# ⑥-c grok 런타임 목록 — 대조 아님(q1). 바뀐 줄은 K8ⓑ grok 기동의 자체 기록으로 RESULT 에"
sh "$(dirname "$0")/grok-runtime.sh" > "$RAWD/grok-runtime-post.txt"
diff "$RAWD/grok-runtime-pre.txt" "$RAWD/grok-runtime-post.txt" > "$RAWD/grok-runtime-diff.txt" && echo "grok 런타임 변화 없음" || echo "grok 런타임 변화 $(grep -c '^[<>]' "$RAWD/grok-runtime-diff.txt")줄 → grok-runtime-diff.txt (되쓰지 않는다)"

echo "# ⑦ herdr default · 잔존"
HSTAT=$(/opt/homebrew/bin/herdr session list 2>&1 | awk '$1=="default"{print $2}')
[ "$HSTAT" = stopped ] && pass "herdr default stopped" || fail "herdr default $HSTAT"
ps -Ao pid=,ppid=,etime=,command= | grep -E 'l490|Electron.app/Contents/MacOS/Electron|/opt/homebrew/bin/herdr( --session default)? server$' | grep -v grep | cut -c1-200
echo "판정: 원복 통과"; exit 0
