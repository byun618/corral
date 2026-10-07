#!/bin/sh
# LIFE-502 K4 — l490/native-up.sh 복사(l490→l502·L490→L502·worktree 이름만 sed 로 바꿈, 그 밖 변경은 아래 「L502 변경」 줄). 아래는 원 주석.
# LIFE-490 K8 — l485/native-up.sh 복사(코드 줄의 l485→l502·L485→L502·ROOT 꼴 /tmp/l502n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 K8 — l527/native-up.sh 복사·수정(02-kickoff 격리 6). 사용자 userData + 구현 브랜치 빌드 + 설치 herdr 0.9.0 `default`.
# l527 에서 바꾼 것: ② 서버를 직접 띄우지 않는다(띄우는 것이 시험 대상) · ③ profile 은 `backend` 키를 **제거**(재작성 아님 — 바인딩이면 D1 지정 세션 규칙을 탄다)
#   · 복구 검사는 exit 7(재개 대상 있음)을 **기대값**으로 기록하고 진행 · 앱 기동은 native-app.sh(최소 PATH·바인딩 env 없음)
# 하나라도 어긋나면 아무것도 바꾸기 전에 멈춘다(exit 3 = corral 가동 중, 5 = profile 원본 아님, 6 = herdr default 가동 중, 7 = 복구 검사가 기대(7)와 다름).
# 사용: sh native-up.sh <ROOT=/tmp/l485n*> <raw 폴더>
set -eu
ROOT=$1; RAWD=$2
HERE=$(cd "$(dirname "$0")/../l470" && pwd); L502=$(cd "$(dirname "$0")" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD="$HOME/Library/Application Support/corral"
HERDR=/opt/homebrew/bin/herdr
HCFG="$HOME/.config/herdr"
. "$L502/path-check.sh"
l502_plain_path "$ROOT" /tmp/l502n || { echo "ROOT 는 정규형 /tmp/l502n*: $ROOT"; exit 2; }
{ [ -e "$ROOT" ] || [ -L "$ROOT" ]; } && { echo "$ROOT 이미 있음(또는 심링크)"; exit 2; }
mkdir -p "$ROOT/backup" "$RAWD"; chmod 700 "$ROOT"
echo "# ⓪ 전제"
set +e
"$NODE" "$(dirname "$0")/../l477/session-restore-check.mjs" "$HCFG/session.json" > "$RAWD/session-restore-check.txt"; RC=$?
set -e
# L502 변경: 재개 대상 유무는 502 의 전제가 아니다 — 0(없음)·7(있음) 둘 다 받고 기록한다. 그 밖(검사 실패)은 멈춘다.
cat "$RAWD/session-restore-check.txt"; echo "복구 검사 exit $RC (0 = 재개 대상 없음 · 7 = 있음 — 둘 다 진행)"
[ "$RC" = 7 ] || [ "$RC" = 0 ] || { echo "✘ 복구 검사가 0·7 이 아니다 — 멈춘다"; exit 7; }
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
echo "설치 herdr server 프로세스(양성 대조 life417-native 행 포함):" | tee -a "$RAWD/precheck.txt"
ps -Ao pid,ppid,command | grep -E '/[h]erdr( --session [^ ]+)? server$' | tee -a "$RAWD/precheck.txt"

echo "# ① 백업 — userData 전체(ndjson 제외) · herdr 최상위 · provider 해시"
rsync -a --exclude corral.ndjson "$UD/" "$ROOT/backup/ud/"
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$ROOT/backup/ud-manifest.json"
cp "$ROOT/backup/ud-manifest.json" "$RAWD/ud-manifest-before.json"
mkdir -p "$ROOT/backup/herdr"
cp -p "$HCFG/session.json" "$ROOT/backup/herdr/session.json"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$ROOT/backup/herdr-manifest.json"
cp "$ROOT/backup/herdr-manifest.json" "$RAWD/herdr-manifest-before.json"
sh "$HERE/provider-hash.sh" > "$RAWD/provider-pre.txt"
sh "$L502/g6-hash.sh" > "$RAWD/g6-pre.txt" || { echo "✘ G6 수집기 실패 — 멈춘다"; exit 1; }
[ -s "$RAWD/g6-pre.txt" ] || { echo "✘ G6 시작 snapshot 이 비었다 — 멈춘다"; exit 1; }
sh "$L502/grok-runtime.sh" > "$RAWD/grok-runtime-pre.txt"
cp -p "$HOME/.codex/config.toml" "$ROOT/backup/codex-config.toml"
touch "$ROOT/marker"
stat -f %z "$UD/corral.ndjson" > "$ROOT/ndjson.offset"
echo "백업 파일 $(find "$ROOT/backup/ud" -type f | wc -l | tr -d ' ')개 · ndjson $(cat "$ROOT/ndjson.offset") 바이트 · session.json $(shasum -a 256 "$HCFG/session.json" | cut -d' ' -f1)"

echo "# ③ profile.json backend 키 임시 제거 (runtimeId 유지) — 원복은 userData 전체 복원이 한다"
"$NODE" -e "const f=process.argv[1];const p=JSON.parse(require('fs').readFileSync(f,'utf8'));delete p.backend;require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n')" "$UD/runtime/profile.json"
echo "교체 후 profile.json $(shasum -a 256 "$UD/runtime/profile.json" | cut -d' ' -f1) · $(cat "$UD/runtime/profile.json" | tr -d '\n ')" | tee -a "$RAWD/precheck.txt"
mkdir -p "$ROOT/shots"
echo "up 완료"
