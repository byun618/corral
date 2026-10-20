#!/bin/sh
# LIFE-637 R2 준비 — up.sh 가 끝난 뒤 r2.mjs 가 바로 돌 수 있는 상태를 만든다. app/ 에서: sh scripts/l637/r2-setup.sh <ROOT=/tmp/l637f-*>
# 최종 관문(라운드 6) 창 회차에서 손으로 한 준비 단계를 그대로 옮겼다:
#   ① <ROOT>/herdr.bin — up.sh 와 같은 guard herdr 경로(오라클이 `pane process-info` 에 쓴다)
#   ② throwaway repo <ROOT>/repo (git init + 커밋 1개)를 **격리 런타임**에 등록(`repo add`)
#   ③ 그 worktree 에 터미널 3개(A-shell·B-sleep·C-yes) → pane w1:p1·w1:p2·w1:p3 이어야 한다(r2.mjs 가 이 id 를 쓴다)
#   ④ <ROOT>/final/handles.json = { A, B, C } 터미널 handle
# 쓰는 것: 격리 런타임 소켓 <ROOT>/ud/runtime/rpc.sock, 격리 herdr 세션 l637f-<꼬리>(up.sh 가 띄운 것). 사용자 소켓·userData 무접촉.
# 순서(app/ 에서): sh scripts/l637/up.sh <ROOT> → sh scripts/l637/r2-setup.sh <ROOT> → node scripts/l637/r2.mjs <ROOT> <n> <out.json> ×3 → sh scripts/l637/down.sh <ROOT>
# 사용량 외부 요청을 끄려면 up.sh 전에 <ROOT>/ud/settings.json 에 statusBarUsage{Claude,Codex,Grok}:false 를 넣는다 — up.sh 는 그 파일을 쓰지 않고(mkdir·chmod 만), 제품은 readSettings 로 기본값 위에 합친다.
# 실패 전파: 가드 2 · 런타임 없음 1 · 생성 실패 3 · pane id 어긋남 4. 성공만 마지막 줄 「setup ok」.
set -u
ROOT=${1:-}
case "$ROOT" in /tmp/l637f-*) ;; *) echo "ROOT 는 /tmp/l637f-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
APP=$(pwd -P)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
SOCK="$ROOT/ud/runtime/rpc.sock"
[ -S "$SOCK" ] || { echo "격리 런타임 소켓 없음: $SOCK — up.sh 먼저"; exit 1; }
[ -f "$APP/out/runtime/cli.mjs" ] || { echo "app/out 없음 — 빌드 먼저"; exit 2; }
[ -e "$ROOT/final/handles.json" ] && { echo "이미 준비됨: $ROOT/final/handles.json — 새 ROOT 를 쓴다"; exit 2; }
cli() { CORRAL_RUNTIME_SOCKET="$SOCK" "$NODE" "$APP/cli/corral.mjs" "$@"; }

# ① herdr.bin
KEY=$("$NODE" -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
echo "$GUARD" > "$ROOT/herdr.bin"

# ② throwaway repo + 등록
mkdir -p "$ROOT/repo" "$ROOT/final"
( cd "$ROOT/repo" && git init -q -b main && echo l637 > a.txt && git add a.txt && git -c user.email=l637@example.com -c user.name=l637 commit -qm init ) || { echo "repo 만들기 실패"; exit 3; }
echo "path $ROOT/repo" >> "$ROOT/made.txt"
REPO=$(cd "$ROOT/repo" && pwd -P)
cli repo add --path "$REPO" --json > "$ROOT/final/repo-add.json" 2>&1 || { echo "repo add 실패"; cat "$ROOT/final/repo-add.json"; exit 3; }

# ③ 터미널 3개 — 순서가 곧 pane id(w1:p1·p2·p3). omz 첫 화면이 느려 120초를 준다.
for t in A-shell B-sleep C-yes; do
  cli terminal create --worktree "$REPO" --title "$t" --timeout-ms 120000 --json > "$ROOT/final/create-$t.json" 2>&1 \
    || { echo "terminal create 실패 ($t) — 'terminal list' 로 늦게 생긴 pane 을 확인하고 새 ROOT 로 다시"; cat "$ROOT/final/create-$t.json"; exit 3; }
done

# ④ handles.json + pane id 대조
"$NODE" -e '
const fs = require("fs"); const dir = process.argv[1]; const want = { A: "w1:p1", B: "w1:p2", C: "w1:p3" }; const out = {}; let bad = 0
for (const [k, f] of [["A", "A-shell"], ["B", "B-sleep"], ["C", "C-yes"]]) {
  const t = JSON.parse(fs.readFileSync(`${dir}/create-${f}.json`, "utf8")).result.terminal
  out[k] = t.handle
  console.log(`${k} ${t.paneId}`)
  if (t.paneId !== want[k]) { console.log(`✘ ${k} 는 ${want[k]} 이어야 한다 — r2.mjs 가 이 id 를 쓴다`); bad = 1 }
}
fs.writeFileSync(`${dir}/handles.json`, JSON.stringify(out))
process.exit(bad ? 4 : 0)
' "$ROOT/final" || exit 4
for k in A B C; do
  H=$("$NODE" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]])' "$ROOT/final/handles.json" $k)
  cli terminal wait --terminal "$H" --for ready --timeout-ms 60000 --json > "$ROOT/final/ready-$k.json" 2>&1 || echo "⚠ $k ready 대기 실패(r2.mjs 의 첫 send 가 늦을 수 있다)"
done
echo "herdr_bin=$GUARD"
echo "setup ok"
