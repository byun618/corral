#!/bin/sh
# LIFE-519 K6 — l527 복사(코드 줄의 잔존 검색어 l527→l519·ROOT 꼴 /tmp/l519n*·L527_ 환경변수 이름만 바꿈, 주석 줄은 원문). 그 밖에 바꾼 줄은 이 줄 아래 「LIFE-519 변경」 주석으로 표시.
# LIFE-527 K9 — l526 복사(코드 줄의 잔존 검색어 l526→l527·ROOT 꼴 /tmp/l519n*·이 빌드 경로·L526_ 환경변수 이름만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-526 K4ⓐ — l516 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l526·이 빌드 경로만 sed 로 바꿈). 아래는 원 주석.
# LIFE-515 K8 — l513 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l515 만 바꿈). G6 = l515/g6-hash.sh(q1 범위) · grok 런타임 목록 grok-runtime.sh(대조 아님) 추가.
# LIFE-513 K9 — l512 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l513 만 바꿈). 추가: G6 사용자 Ghostty 파일·~/.orca/keybindings.json 해시(읽기만, 백업 없음 — 쓰지 않으니 되돌릴 것도 없다). 도우미는 ../l470 · ../l477 그대로.
# 네이티브에는 XDG_CONFIG_HOME·GHOSTTY_RESOURCES_DIR 를 설정하지 않는다(clean.sh 가 env -i — 사용자 실제 경로를 읽는 것이 관문의 뜻). 그 값을 env-native.txt 로 남긴다.
# LIFE-512 K9 — l511 복사(ROOT 꼴 /tmp/l512n*·잔존 검색어 l512 만 바꿈). 도우미는 ../l470 · ../l477 그대로.
# LIFE-511 K9 — l497 복사(ROOT 꼴 /tmp/l511n*·잔존 검색어 l511 만 바꿈). 도우미는 ../l470 · ../l477 그대로.
# LIFE-497 K6 — l496 복사(ROOT 꼴 /tmp/l497n*·잔존 검색어 l497). 추가: ~/.codex/config.toml 바이트 백업(up)·복원(down, provider 대조 전) — codex 는 자기 config 를 고친다(킥오프 격리 2).
# LIFE-496 K4 — l494 복사(ROOT 꼴 /tmp/l496n*·잔존 검색어 l496 만 바꿈).
# LIFE-494 K4 — LIFE-493 l493/native-up.sh 복사(ROOT 꼴만 /tmp/l496n* 로). 그 위 원 주석: LIFE-477 native-up.sh 를 그대로 옮겼다(도우미 ../l470 · 복구 검사 ../l477).
# 사용자 userData(기본 경로) + 지정 빌드 Electron + 설치 herdr 0.9.0 `default` 세션.
# 468 에서 바꾼 것:
#   · 백업 범위 = **userData 전체**(corral.ndjson 제외 — 205MB 추가 기록 로그라 크기·해시만 적고 원복 때 원래 길이로 자른다)
#     + ~/.config/herdr 의 최상위 파일(session.json 바이트 · 로그는 길이·해시). 코디네이터 q1 답 「그 회차가 쓰는 다른 userData 파일」.
#   · fixture 는 여기서 등록하지 않는다 — K8ⓒ 첫 기동 캡처를 원래 상태(레포 1개)로 먼저 찍는다(q1).
#   · provider 설정은 해시만 적는다(대조만, 되쓰기 금지 — 킥오프 격리 2).
# 하나라도 어긋나면 아무것도 바꾸기 전에 멈춘다(exit 3 = corral 가동 중, 5 = profile 원본 아님, 6 = herdr default 가동 중, 7 = 복구될 에이전트 세션 있음·session.json 구조 모름).
# 사용: sh native-up.sh <ROOT=/tmp/l511n*> <app 디렉터리> <raw 폴더> [--allow-session-restore]
set -eu
ROOT=$1; APP=$2; RAWD=$3
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD="$HOME/Library/Application Support/corral"
HERDR=/opt/homebrew/bin/herdr
HCFG="$HOME/.config/herdr"
SOCK="$HCFG/herdr.sock"
# fix5 — ROOT 는 /tmp/l526n* 이고 정규형(`..`·`.`·`//` 없음)이어야 한다(R5-01 같은 꼴 — 접두만 보면 `/tmp/l526n/../x` 가 통과해
# 바깥에 쓰고 native-app.sh 가 그 아래 ctl.sock 을 지울 수 있다). 이미 있거나 심링크(끊긴 것 포함)면 멈춘다.
. "$(dirname "$0")/path-check.sh"
l519_plain_path "$ROOT" /tmp/l519n || { echo "ROOT 는 정규형 /tmp/l519n*: $ROOT"; exit 2; }
{ [ -e "$ROOT" ] || [ -L "$ROOT" ]; } && { echo "$ROOT 이미 있음(또는 심링크)"; exit 2; }
mkdir -p "$ROOT/backup" "$RAWD"
echo "# ⓪ 전제"
# LIFE-477 r1 R2 — 서버를 띄우면 session.json 의 에이전트 세션이 다시 붙는다(477 K10: claude 1·grok 2). 띄우기 **전에** 세고 1개 이상이면 멈춘다(exit 7).
# 개수·종류만 찍는다. 승인된 경우에만 4번째 인자 --allow-session-restore.
# 파이프(| tee)는 쓰지 않는다 — sh 에서 파이프 종료코드는 tee 의 것이라 실패가 가려진다(470 R2-03 과 같은 함정).
if ! "$NODE" "$(dirname "$0")/../l477/session-restore-check.mjs" "$HCFG/session.json" ${4:-} > "$RAWD/session-restore-check.txt"; then
  cat "$RAWD/session-restore-check.txt"; echo "✘ 복구될 에이전트 세션이 있거나(7) session.json 구조를 모른다(8) — 서버를 띄우지 않고 멈춘다"; exit 7
fi
cat "$RAWD/session-restore-check.txt"
OWNER=$("$NODE" -e "try{const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));try{process.kill(o.pid,0);console.log(o.pid)}catch{console.log('dead:'+o.pid)}}catch{console.log('none')}" "$UD/runtime/owner.json")
echo "owner: $OWNER" | tee "$RAWD/precheck.txt"
case "$OWNER" in none|dead:*) ;; *) echo "✘ 살아 있는 소유자 $OWNER — 멈춘다"; exit 3 ;; esac
ELEC=$(ps -Ao pid=,command= | grep -E 'corral.*(Electron|electron)' | grep -v grep || true)
[ -n "$ELEC" ] && { echo "✘ corral Electron 이 떠 있다 — 끄지 않고 멈춘다:"; echo "$ELEC" | cut -c1-200; exit 3; }
echo "corral Electron: 0개" | tee -a "$RAWD/precheck.txt"
# LIFE-519 변경 — 사용자 원본 profile.json 이 backend 없는 꼴(runtimeId 만)로 바뀌어 있다. LIFE-507 l507/native-up.sh(main) 가 같은 값으로 갱신한 선례를 따른다.
WANT_PROFILE=cbdd8889499885d045e77f33a709f7ee6bdf9fbf1587f2fe921aedb199be07c1
HAVE_PROFILE=$(shasum -a 256 "$UD/runtime/profile.json" | cut -d' ' -f1)
echo "profile.json 기대 $WANT_PROFILE / 현재 $HAVE_PROFILE" | tee -a "$RAWD/precheck.txt"
[ "$HAVE_PROFILE" = "$WANT_PROFILE" ] || { echo "✘ 원본과 다르다 — 멈춘다"; exit 5; }
HSTAT=$("$HERDR" session list 2>&1 | awk '$1=="default"{print $2}')
echo "herdr default: $HSTAT · $($HERDR --version 2>&1 | head -1)" | tee -a "$RAWD/precheck.txt"
[ "$HSTAT" = stopped ] || { echo "✘ herdr default 가 멈춰 있지 않다($HSTAT) — 남의 것이라 건드리지 않는다"; exit 6; }

echo "# ① 백업 — userData 전체(ndjson 제외) · herdr 최상위 · provider 해시"
rsync -a --exclude corral.ndjson "$UD/" "$ROOT/backup/ud/"
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$ROOT/backup/ud-manifest.json"
cp "$ROOT/backup/ud-manifest.json" "$RAWD/ud-manifest-before.json"
mkdir -p "$ROOT/backup/herdr"
cp -p "$HCFG/session.json" "$ROOT/backup/herdr/session.json"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$ROOT/backup/herdr-manifest.json"
cp "$ROOT/backup/herdr-manifest.json" "$RAWD/herdr-manifest-before.json"
sh "$HERE/provider-hash.sh" > "$RAWD/provider-pre.txt"
sh "$(dirname "$0")/g6-hash.sh" > "$RAWD/g6-pre.txt" || { echo "✘ G6 수집기 실패 — 멈춘다"; exit 1; }
[ -s "$RAWD/g6-pre.txt" ] || { echo "✘ G6 시작 snapshot 이 비었다 — 멈춘다"; exit 1; }
echo "G6 $(wc -l < "$RAWD/g6-pre.txt" | tr -d ' ')줄 해시"
sh "$(dirname "$0")/grok-runtime.sh" > "$RAWD/grok-runtime-pre.txt" && echo "grok 런타임 $(wc -l < "$RAWD/grok-runtime-pre.txt" | tr -d ' ')줄(목록)"
sh "$HERE/clean.sh" -- 'echo "XDG_CONFIG_HOME=[$XDG_CONFIG_HOME] GHOSTTY_RESOURCES_DIR=[$GHOSTTY_RESOURCES_DIR]"' > "$RAWD/env-native.txt"; cat "$RAWD/env-native.txt"
cp -p "$HOME/.codex/config.toml" "$ROOT/backup/codex-config.toml" && shasum -a 256 "$HOME/.codex/config.toml" | cut -d' ' -f1 > "$RAWD/codex-config-pre.sha256"
echo "codex config 바이트 백업 $(cat "$RAWD/codex-config-pre.sha256")"
echo "백업 파일 $(find "$ROOT/backup/ud" -type f | wc -l | tr -d ' ')개 · ndjson $(stat -f %z "$UD/corral.ndjson") 바이트"

echo "# ② herdr default 서버 (설치 0.9.0, 사용자 기본 설정)"
sh "$HERE/clean.sh" -- "nohup $HERDR --session default server > $ROOT/backend.log 2>&1 & echo \$! > $ROOT/backend.pid"
i=0; until [ -S "$SOCK" ] && "$HERDR" session list 2>/dev/null | awk '$1=="default"{print $2}' | grep -q running; do i=$((i+1)); [ $i -gt 150 ] && { echo "backend 안 뜸"; exit 1; }; sleep 0.2; done
ps -o pid=,ppid=,lstart=,command= -p "$(cat "$ROOT/backend.pid")" | tee "$RAWD/herdr-default.txt"

echo "# ③ profile.json backend 임시 재작성 → default (runtimeId 유지) — 원복은 userData 전체 복원이 한다"
"$NODE" -e "const f=process.argv[1];const p=JSON.parse(require('fs').readFileSync(f,'utf8'));p.backend={socket:process.argv[2],session:'default'};require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$UD/runtime/profile.json" "$SOCK"
echo "교체 후 profile.json $(shasum -a 256 "$UD/runtime/profile.json" | cut -d' ' -f1)" | tee -a "$RAWD/precheck.txt"
mkdir -p "$ROOT/shots"
# LIFE-519 변경 — K6ⓑ: native-app.sh(사용자 checkout 의 `node <app>/cli/corral.mjs open` 콜드 기동) 동안 실제 endpoint 를 관측기로 촘촘히 lstat 한다.
# 관측기는 이 스크립트가 띄우고 pid 를 남기며, open 이 끝나면(성공·실패 모두) 멈춰 결과를 $RAWD/k6-observe.json 에 쓴다.
"$NODE" "$(dirname "$0")/observe.mjs" "$UD/runtime/rpc.sock" "$RAWD/k6-observe.json" "$ROOT/observe.stop" & echo $! > "$ROOT/observer.pid"
i=0; until [ -f "$RAWD/k6-observe.json.ready" ]; do i=$((i+1)); [ $i -gt 100 ] && { echo "관측기 안 뜸"; exit 1; }; sleep 0.05; done
APPRC=0; sh "$HERE/native-app.sh" "$ROOT" "$APP" "$RAWD" first || APPRC=$?
touch "$ROOT/observe.stop"; wait "$(cat "$ROOT/observer.pid")" || true
"$NODE" -e "const o=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('관측기 samples',o.samples,'intervalUs',o.intervalUs,'loose',o.loose,'firstSeen',o.firstSeen,'modes',JSON.stringify(o.modes))" "$RAWD/k6-observe.json"
exit $APPRC
