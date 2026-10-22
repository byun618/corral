#!/bin/sh
# LIFE-690 (LIFE-571 dev-up.sh 복사) G3 — 구현 worktree 의 개발 실행(Electron)을 실제 HOME 으로 띄운다. userData 만 /tmp/l690-*.
# herdr 는 레포 guard 바이너리의 **전용 세션 l571** 에 붙는다 — herdr-dev default·다른 작업 세션은 건드리지 않는다.
# 사용자 설정(외관)은 사용자 userData 의 settings.json 을 **읽어 복사**만 한다(사용자 화면 조건 재현). 설치본 corral·그 userData·provider 설정 무접촉.
# 사용: sh scripts/l690/dev-up.sh <ROOT=/tmp/l690-*> [<빌드 out 사본 폴더>]   (app/ 에서)
#   out 사본을 주면 app/out 을 그것으로 바꿔 띄운다(기준선 빌드 — 최종 관문). Electron 기동은 app-launch.sh(빌드 전환 재기동 app-restart.sh 와 같은 경로).
set -eu
ROOT=$1; OUTSRC=${2:-}
case "$ROOT" in /tmp/l690-*) ;; *) echo "ROOT 는 /tmp/l690-*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "$ROOT 이미 있음"; exit 2; }
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
# 칸 = 지금 source.json 패치 digest 앞 16자(build-dev-guard.mjs 와 같은 규칙) — 패치 guard(LIFE-571 shift-enter 포함)를 쓴다.
KEY=${L690_GUARD_KEY:-$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')}
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SESSION=l690
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
"$GUARD" session list 2>/dev/null | awk -v s=$SESSION '$1==s' | grep -q . && { echo "herdr 세션 $SESSION 이 이미 있다 — 멈춘다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots"; chmod 700 "$ROOT"
if [ -n "$OUTSRC" ]; then rm -rf "$APP/out" && cp -R "$OUTSRC" "$APP/out" && echo "out ← $OUTSRC ($(cat "$OUTSRC/.l690-build" 2>/dev/null))"; fi
cp "$HOME/Library/Application Support/corral/settings.json" "$ROOT/ud/settings.json"
# 워커(Claude Code) 세션 env 를 물려받지 않게 뺀다 — herdr 서버·Electron 둘 다(pane 셸은 herdr 서버 env 를 물려받는다).
# 물려받으면 pane 의 Claude Code 가 transcript 를 끄고 C2ⓐ 세션 기록 칸을 볼 수 없다(LIFE-571 최종 관문 「env 정리」).
UNSETS=$(env | sed -nE 's/^(CLAUDE_CODE_[A-Za-z0-9_]*|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|ORCA_AGENT_HOOK_[A-Za-z0-9_]*)=.*/-u \1/p' | tr '\n' ' ')
# shellcheck disable=SC2086
LEFT=$(env $UNSETS env | sed -nE 's/^(CLAUDE[A-Za-z0-9_]*|ORCA_AGENT_HOOK[A-Za-z0-9_]*)=.*/\1/p')
{ echo "unset: $UNSETS"; echo "남은 이름(CLAUDE*·ORCA_AGENT_HOOK*, 값 없음):"; echo "${LEFT:-(없음)}"; } > "$ROOT/env-clean.txt"
echo "env 정리: $(echo $UNSETS | wc -w | tr -d ' ') 개 -u 인자 · 남은 이름: ${LEFT:-없음}"
echo "# herdr $SESSION 서버"
env $UNSETS nohup "$GUARD" --session $SESSION server > "$ROOT/backend.log" 2>&1 &
echo $! > "$ROOT/backend.pid"
i=0; until "$GUARD" session list 2>/dev/null | awk -v s=$SESSION '$1==s{print $2}' | grep -q running; do i=$((i+1)); [ $i -gt 150 ] && { echo "backend 안 뜸"; exit 1; }; sleep 0.2; done
SOCK=$("$GUARD" session list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const x=(j.sessions??j).find(e=>e.name==='$SESSION');console.log(x?.socket??x?.socket_path??'')}catch{console.log('')}})")
[ -n "$SOCK" ] || SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
[ -S "$SOCK" ] || { echo "소켓 없음 $SOCK"; "$GUARD" session list; exit 1; }
echo "backend pid $(cat "$ROOT/backend.pid") sock $SOCK guard $GUARD"
echo "$SOCK" > "$ROOT/backend.sock"; echo "$GUARD" > "$ROOT/guard.path"
echo "# 개발 실행"
sh "$(dirname "$0")/app-launch.sh" "$ROOT"
