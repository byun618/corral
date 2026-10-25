#!/bin/sh
# LIFE-694 최종 관문 — 격리 herdr(레포 guard 바이너리 이름 세션 `l694g-<ROOT 꼬리>`) + 격리 개발 Electron. app/ 에서:
#   sh scripts/l694/up.sh <ROOT=/tmp/l694g-*> <FAKE=/tmp/l694g-f*> [APP 디렉터리(out/ 빌드됨, 기본 app/)]
# l577/g-up.sh(제어 소켓·가짜 tailscale)와 l628/up.sh(창 비활성 래퍼 — show·focus 를 showInactive 로, 활성화 정책 accessory)를 합쳤다.
# - userData·설정·로그·레지스트리·ui-prefs = <ROOT>/ud · 제어 소켓 <ROOT>/ctl/ctl.sock · 샷 <ROOT>/shots · LA 주소는 닿지 않는 로컬.
# - PATH 앞에 <ROOT>/gitwrap(`git -C <레포> worktree list --porcelain` 만 실패·지연 주입 — `-z` 를 쓰는 레지스트리 동기 호출은 건드리지 않는다).
# - 설치본 corral·그 userData·사용자 herdr 세션 무접촉. 워커 env(CLAUDE_CODE_*)는 넘기지 않는다(l470/clean.sh).
set -u
ROOT=$1; FAKE=$2; APP=${3:-$(pwd -P)}
case "$ROOT" in /tmp/l694g-*) ;; *) echo "ROOT 는 /tmp/l694g-*"; exit 2 ;; esac
case "$FAKE" in /tmp/l694g-f*) ;; *) echo "FAKE 는 /tmp/l694g-f*"; exit 2 ;; esac
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
TOOLS=$(CDPATH= cd -- "$HERE/../.." && pwd -P)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$(cd "$TOOLS" && "$NODE" -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(cd "$TOOLS" && git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SESSION="l694g-$(basename "$ROOT" | sed 's/^l694g-//')"
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
INSTALLED_UD="$HOME/Library/Application Support/corral"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
[ -f "$APP/out/main/index.js" ] || { echo "$APP/out 없음"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl" "$ROOT/wrap" "$ROOT/gitwrap" "$ROOT/gitctl" "$FAKE"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래"; exit 5;; esac
cat > "$ROOT/gitwrap/git" <<WRAP
#!/bin/sh
if [ "\$1" = "-C" ] && [ "\$3" = "worktree" ] && [ "\$4" = "list" ] && [ "\$5" = "--porcelain" ] && [ "\$#" = "5" ]; then
  b=\$(basename "\$2")
  [ -f "$ROOT/gitctl/slow-\$b" ] && sleep "\$(cat "$ROOT/gitctl/slow-\$b")"
  [ -f "$ROOT/gitctl/fail-\$b" ] && { echo "error: l694 simulated worktree list failure (\$b)" >&2; exit 128; }
fi
exec /usr/bin/git "\$@"
WRAP
chmod +x "$ROOT/gitwrap/git"
echo "# 충돌 없음 확인 $(date '+%F %T') installed_rpc_sock_exists=$([ -S "$INSTALLED_UD/runtime/rpc.sock" ] && echo yes || echo no) isolated_ud=$ROOT/ud session=$SESSION app=$APP"
if [ ! -S "$SOCK" ]; then
  sh "$TOOLS/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION guard=$GUARD"
echo "$GUARD" > "$ROOT/herdr.bin"; echo "$SESSION" > "$ROOT/herdr.session"
cp "$TOOLS/scripts/l676/visible-inactive.cjs" "$ROOT/wrap/main.cjs"
"$NODE" -e "const p=require('$APP/package.json');require('fs').writeFileSync('$ROOT/wrap/package.json',JSON.stringify({name:p.name,productName:p.productName,version:p.version,main:'main.cjs'}))"
rm -f "$ROOT/ctl/ctl.sock"
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
# CDP 포트 — 창 비활성 래퍼 아래에선 페이지가 시스템 포커스를 못 가져 `:focus`·`:focus-visible` 이 안 맞는다(g22). F6 회차는 CDP
# `Emulation.setFocusEmulationEnabled` 로 포커스를 흉내 낸다(OS 포커스는 가져가지 않는다).
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"); echo "$CDP" > "$ROOT/cdp.port"
LAUNCH='exec env PATH="$L694_ROOT/gitwrap:$PATH" "$L694_EL" "$L694_WRAP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L694_CDP"'
sh "$TOOLS/scripts/l470/clean.sh" L694_ROOT="$ROOT" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$GUARD" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" CORRAL_LA_MCP_URL=http://127.0.0.1:9/mcp \
  CORRAL_SETTINGS="$ROOT/ud/settings.json" CORRAL_LOG="$ROOT/ud/corral.ndjson" CORRAL_UI_PREFS="$ROOT/ud/ui-prefs.json" CORRAL_REGISTRY="$ROOT/ud/repos.json" \
  CORRAL_TAILSCALE_BIN="$TOOLS/scripts/l577/fake-tailscale.mjs" FAKE_TAILSCALE_DIR="$FAKE" \
  L676_MAIN="$APP/out/main/index.js" L694_WRAP="$ROOT/wrap" L694_EL="$EL" L694_CDP="$CDP" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; tail -5 "$ROOT/electron-$N.log"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID launch=$N at=$(date '+%T')" | tee -a "$ROOT/made.txt"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
echo "up ok"
