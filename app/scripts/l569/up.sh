#!/bin/sh
# LIFE-569 네이티브 개발 실행 기동 (G3). app/ 에서: sh scripts/l569/up.sh <원자료 폴더>
# 선례 l565/c6-up.sh bound 모드: 격리 XDG(/tmp/l569n/xdg) 아래 이름 세션 l569 herdr 서버(레포 guard)를 먼저 띄우고 앱을 거기 바인딩한다 —
# 바인딩이 없으면 런타임이 「Profile has no configured terminal backend」 로 worker-start 를 거절한다(attempt1-unbound).
# 설치본 corral·corral-herdr 서버·사용자 userData 와 소켓·세션 폴더가 갈린다. 실제 HOME·로그인 셸·실제 claude.
# 워커 프리앰블의 corral 은 CORRAL_CLI 로 이 worktree 의 CLI(node v24 + cli/corral.mjs)를 가리킨다 — 설치본 shim 을 쓰지 않는다.
set -u
OUT=$1; ROOT=/tmp/l569n; XDG=$ROOT/xdg; SESSION=l569
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
SOCK="$XDG/herdr-dev/sessions/$SESSION/herdr.sock"
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
mkdir -p "$OUT"
echo "# ⓪ 전제 $(date '+%F %T')"
DEV=$(ps -axo pid=,command= | grep -E 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep)
echo "dev_gui_before=${DEV:-none}" | sed "s#$HOME#~#g"
echo "$DEV" | grep -qF "$APP/node_modules/electron" && { echo "이 worktree 의 개발 GUI 가 이미 떠 있다 — 멈춘다"; exit 3; }
[ -e "$ROOT/ud" ] && { echo "$ROOT/ud 이미 있음 — 멈춘다"; exit 2; }
echo "무접촉 서버(읽기만):"; ps -axo pid=,ppid=,etime=,command= | grep -E 'herdr( --session [^ ]+)? server' | grep -v grep | sed "s#$HOME#~#g"
mkdir -p "$ROOT/ud" "$ROOT/shots" "$XDG"; chmod 700 "$ROOT" "$ROOT/ud"
# XDG 격리는 zsh rc 를 끊는다(~/.zshenv 가 ZDOTDIR=$XDG_CONFIG_HOME/zsh) — 심링크로 사용자 rc 를 잇는다. 정리 때 링크만 지운다.
[ -e "$XDG/zsh" ] || ln -s "$HOME/.config/zsh" "$XDG/zsh"
echo "zsh_rc_link=$(readlink "$XDG/zsh" | sed "s#$HOME#~#g")"
# 워커 cwd — 무해한 git 저장소 하나(워커에게 저장소 변경을 시키지 않는다)
if [ ! -d "$ROOT/repo/.git" ]; then
  mkdir -p "$ROOT/repo" && git -C "$ROOT/repo" init -q && echo "LIFE-569 native fixture" > "$ROOT/repo/README.md" && \
  git -C "$ROOT/repo" add README.md && git -C "$ROOT/repo" -c user.name=l569 -c user.email=l569@example.invalid commit -qm init
fi
# clean.sh 는 KEY=VALUE 를 단어 분리한다 — 공백 없는 손잡이 경로로 넘긴다. 워커 pane 안에서 불리므로 env 를 지우지 않는다(caller 신원).
mkdir -p "$ROOT/bin"; printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$APP/cli/corral.mjs" > "$ROOT/bin/corral"; chmod 755 "$ROOT/bin/corral"
echo "# ① 이름 세션 서버 $SESSION (깨끗한 로그인 셸에서 guard 직접, 격리 XDG)"
echo "guard=$GUARD sha=$(shasum -a 256 "$GUARD" | cut -c1-64)" | sed "s#$HOME#~#g"
[ -S "$SOCK" ] && { echo "$SOCK 이미 있음 — 멈춘다"; exit 2; }
sh "$APP/scripts/l470/clean.sh" XDG_CONFIG_HOME="$XDG" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-$SESSION.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
ps -o pid=,ppid=,command= -p "$(cat "$ROOT/herdr.pid")" | sed "s#$HOME#~#g"
echo "# ② 개발 실행 (로그인 셸·실제 HOME, XDG_CONFIG_HOME=$XDG)"
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
rm -f "$ROOT/ctl.sock"
LAUNCH='exec "$L569_EL" "$L569_APP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L569_CDP"'
sh "$APP/scripts/l470/clean.sh" XDG_CONFIG_HOME="$XDG" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  CORRAL_CLI="$ROOT/bin/corral" \
  L569_EL="$EL" L569_APP="$APP" L569_CDP="$CDP" -- "$LAUNCH" >> "$ROOT/electron.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl.sock" ] && [ -S "$ROOT/ud/runtime/rpc.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어/런타임 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID cdp_port=$CDP"
ENVLINE=$(ps eww -o command= -p "$APID")
echo "앱 env 키 전체(값 없이):"; printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -E '^[A-Z_][A-Z0-9_]*=' | cut -d= -f1 | sort | tr '\n' ' '; echo
printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ CLAUDE_CODE_*/HERDR_* 가 앱 env 에 있다 — 멈춘다"; exit 4; }
echo "앱 env 오염 검사 통과(CLAUDE_CODE_*·CLAUDECODE·HERDR_* 없음)"
echo "claude=$(/bin/zsh -lc 'command -v claude; claude --version' 2>&1 | tr '\n' ' ')" | sed "s#$HOME#~#g"
echo "app_head=$(git -C "$APP" rev-parse HEAD) dirty_product=$(git -C "$APP" status --porcelain -- src | wc -l | tr -d ' ')"
echo "up ok"
