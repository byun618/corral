#!/bin/sh
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
# 사용: sh native-up.sh <ROOT=/tmp/l497n*> <app 디렉터리> <raw 폴더> [--allow-session-restore]
set -eu
ROOT=$1; APP=$2; RAWD=$3
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD="$HOME/Library/Application Support/corral"
HERDR=/opt/homebrew/bin/herdr
HCFG="$HOME/.config/herdr"
SOCK="$HCFG/herdr.sock"
case "$ROOT" in /tmp/l497n*) ;; *) echo "ROOT 는 /tmp/l497n*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "$ROOT 이미 있음"; exit 2; }
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
WANT_PROFILE=2f4c55d683275347f2df19dd01152db750db25c980917c9b936f87d74fe3ffa4
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
sh "$HERE/native-app.sh" "$ROOT" "$APP" "$RAWD" first
