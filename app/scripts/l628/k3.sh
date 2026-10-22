#!/bin/sh
# LIFE-628 K3 — 같은 fixture 를 한 바이너리로: 만들기 → 에이전트 세션 보고 → 서버 stop → cwd 지움 → 재기동 → 관측.
#   sh k3.sh <ROOT=/tmp/l6g/k3-*> <BIN> <OUT 원자료 폴더>
# fixture: gone(claude 세션 + 지울 디렉터리) · keep(claude 세션 + 남는 디렉터리) · gone2(셸만 + 지울 디렉터리)
set -u
ROOT=$1; BIN=$2; OUT=$3; S=k3
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
mkdir -p "$OUT" "$ROOT/fx"
rpc() { "$NODE" "$HERE/rpc.mjs" "$(sh "$HERE/herdr.sh" sock "$ROOT" $S)" "$@"; }
echo "binary $BIN sha256 $(shasum -a 256 "$BIN" | cut -d' ' -f1)" > "$OUT/binary.txt"
for d in gone keep gone2; do mkdir -p "$ROOT/fx/wt-$d"; done
sh "$HERE/herdr.sh" start "$ROOT" "$BIN" $S
for d in gone keep gone2; do rpc workspace.create "{\"cwd\":\"$ROOT/fx/wt-$d\",\"label\":\"$d\"}" > "$OUT/create-$d.json"; done
sleep 1
rpc pane.list > "$OUT/1-before-pane-list.json"
# 에이전트 세션 보고(herdr 훅이 하는 것과 같은 API) — gone·keep 만.
pane_of() { "$NODE" -e "const r=JSON.parse(require('fs').readFileSync('$OUT/create-$1.json','utf8'));console.log(r.result.root_pane.pane_id)"; }
for d in gone keep; do rpc pane.report_agent "{\"pane_id\":\"$(pane_of $d)\",\"source\":\"herdr:claude\",\"agent\":\"claude\",\"state\":\"idle\",\"agent_session_id\":\"sess-$d\"}" > "$OUT/report-$d.json"; done
sleep 1
rpc pane.list > "$OUT/2-reported-pane-list.json"
sh "$HERE/herdr.sh" stop "$ROOT" "$BIN" $S
cp "$ROOT/x/corral-herdr/sessions/$S/session.json" "$OUT/3-saved-session.json"
rm -rf "$ROOT/fx/wt-gone" "$ROOT/fx/wt-gone2"
ls -d "$ROOT"/fx/wt-* > "$OUT/4-dirs-after-rm.txt" 2>&1
: > "$ROOT/logs/claude-launch.log"
sh "$HERE/herdr.sh" start "$ROOT" "$BIN" $S
sleep 4
rpc pane.list > "$OUT/5-after-restart-pane-list.json"
for d in gone keep gone2; do rpc pane.process_info "{\"pane_id\":\"$(pane_of $d)\"}" > "$OUT/6-process-info-$d.json"; done
cp "$ROOT/logs/claude-launch.log" "$OUT/7-claude-launch.log"
HP=$(cat "$ROOT/herdr-$S.pid")
ps -axo pid=,ppid=,command= | awk -v r="$HP" '{p[$1]=$2; c[$1]=$0} END {for (x in p) {y=x; while (y in p && y!=1 && y!=0) {if (p[y]==r) {print c[x]; break}; y=p[y]}}}' > "$OUT/8-herdr-descendants.txt"
for pid in $(grep "fake\|bin/claude" "$OUT/8-herdr-descendants.txt" | awk '{print $1}'); do echo "$pid $(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)"; done > "$OUT/9-claude-cwd.txt"
echo "done at=$(date -u +%FT%TZ)" > "$OUT/done.txt"
