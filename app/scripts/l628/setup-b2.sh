#!/bin/sh
# LIFE-628 최종 관문 Phase B 2단 — 앱 기동 직전. setup-b.sh 뒤.
#   sh setup-b2.sh <ROOT=/tmp/l6g/b> <OUT>
# r3(Z1 — 등록 루트를 잠시 치울 레포) 등록·열기, r1 worktree k1·lock·prune·remove 를 herdr 에 연다.
# k1 은 셸 pane + 가짜 claude 가 도는 pane(report_agent) — K1ⓐ~ⓒ·K2ⓑ(실행 중 확인) 재료.
set -u
ROOT=$1; OUT=$2; S=b
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
mkdir -p "$OUT"
rpc() { "$NODE" "$HERE/rpc.mjs" "$(sh "$HERE/herdr.sh" sock "$ROOT" $S)" "$@"; }
git init -q -b main "$ROOT/repos/r3" && git -C "$ROOT/repos/r3" -c user.email=l628@x -c user.name=l628 commit -q --allow-empty -m init
rpc worktree.open "{\"cwd\":\"$ROOT/repos/r3\",\"path\":\"$ROOT/repos/r3\",\"trust_repository\":true}" > "$OUT/c1-open-r3.json"
printf '["%s","%s","%s"]\n' "$ROOT/repos/r1" "$ROOT/repos/r2" "$ROOT/repos/r3" > "$ROOT/ud/repos.json"
for wt in k1 lock prune remove; do rpc worktree.open "{\"cwd\":\"$ROOT/repos/r1\",\"path\":\"$ROOT/repos/r1-$wt\",\"trust_repository\":true}" > "$OUT/c2-open-r1-$wt.json"; done
WS=$("$NODE" -e "const r=JSON.parse(require('fs').readFileSync('$OUT/c2-open-r1-k1.json','utf8'));const w=r.result.workspace??r.result;console.log(w.workspace_id??w.id)")
rpc pane.split "{\"workspace_id\":\"$WS\",\"direction\":\"right\",\"cwd\":\"$ROOT/repos/r1-k1\"}" > "$OUT/c3-split-k1.json"
AP=$("$NODE" -e "const r=JSON.parse(require('fs').readFileSync('$OUT/c3-split-k1.json','utf8'));const p=r.result.pane??r.result;console.log(p.pane_id)")
sleep 2
rpc pane.send_text "{\"pane_id\":\"$AP\",\"text\":\"claude --session-id sess-k1\\r\"}" > "$OUT/c4-run-claude-k1.json"
sleep 2
rpc pane.report_agent "{\"pane_id\":\"$AP\",\"source\":\"herdr:claude\",\"agent\":\"claude\",\"state\":\"working\",\"agent_session_id\":\"sess-k1\"}" > "$OUT/c5-report-k1.json"
sleep 1
rpc workspace.list > "$OUT/c6-workspace-list.json"
rpc pane.list > "$OUT/c6-pane-list.json"
rpc worktree.list "{\"cwd\":\"$ROOT/repos/r1\"}" > "$OUT/c6-worktree-list-r1.json" 2>&1
echo "k1 workspace=$WS agent_pane=$AP ready at=$(date -u +%FT%TZ)" | tee "$OUT/c-ready.txt"
