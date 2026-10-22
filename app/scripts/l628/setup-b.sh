#!/bin/sh
# LIFE-628 최종 관문 Phase B fixture — 세션 b (격리 XDG). 앱을 띄우기 전에 만든다.
#   sh setup-b.sh <ROOT=/tmp/l6g/b> <PRE_BIN> <POST_BIN> <OUT>
# ① 패치 전 바이너리로 H(claude 세션, 지울 디렉터리) → 재기동 = HOME 재개(K1ⓓ 「재기동으로 HOME 이 된 workspace」)
# ② 패치 후 바이너리로 같은 세션: P(claude 세션)·P2(셸) 를 만들고 디렉터리를 지운 뒤 재기동 = PTY 없는 pane(K3ⓓⓔ)
# ③ 등록 레포 r1·r2 (r1 worktree 는 앱을 띄운 뒤 K1·Z3 회차가 연다), HOME 셸 workspace 5개(K2ⓒⓕ·K6 R 대상)
set -u
ROOT=$1; PRE=$2; POST=$3; OUT=$4; S=b
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
mkdir -p "$OUT" "$ROOT/fx" "$ROOT/repos" "$ROOT/gitctl" "$ROOT/gitwrap"
rpc() { "$NODE" "$HERE/rpc.mjs" "$(sh "$HERE/herdr.sh" sock "$ROOT" $S)" "$@"; }
root_pane() { "$NODE" -e "const r=JSON.parse(process.argv[1]);console.log(r.result.root_pane.pane_id)" "$1"; }
# git 래퍼 — <ROOT>/gitctl/fail-<레포 이름> 이 있으면 그 레포의 `worktree list` 를 실패, slow-<이름> 이면 그 초만큼 늦춘다(Z2·K1ⓕ②).
cat > "$ROOT/gitwrap/git" <<WRAP
#!/bin/sh
if [ "\$1" = "-C" ] && [ "\$3" = "worktree" ] && [ "\$4" = "list" ]; then
  b=\$(basename "\$2")
  [ -f "$ROOT/gitctl/slow-\$b" ] && sleep "\$(cat "$ROOT/gitctl/slow-\$b")"
  [ -f "$ROOT/gitctl/fail-\$b" ] && { echo "error: l628 simulated worktree list failure (\$b)" >&2; exit 128; }
fi
exec /usr/bin/git "\$@"
WRAP
chmod +x "$ROOT/gitwrap/git"
# ①
mkdir -p "$ROOT/fx/wt-h"
sh "$HERE/herdr.sh" start "$ROOT" "$PRE" $S
H=$(rpc workspace.create "{\"cwd\":\"$ROOT/fx/wt-h\",\"label\":\"h\"}"); echo "$H" > "$OUT/b1-create-h.json"
rpc pane.report_agent "{\"pane_id\":\"$(root_pane "$H")\",\"source\":\"herdr:claude\",\"agent\":\"claude\",\"state\":\"idle\",\"agent_session_id\":\"sess-h\"}" > /dev/null
sleep 1; sh "$HERE/herdr.sh" stop "$ROOT" "$PRE" $S; rm -rf "$ROOT/fx/wt-h"
sh "$HERE/herdr.sh" start "$ROOT" "$PRE" $S; sleep 3
rpc pane.list > "$OUT/b2-pre-restart-pane-list.json"
sh "$HERE/herdr.sh" stop "$ROOT" "$PRE" $S
# ②
mkdir -p "$ROOT/fx/wt-p" "$ROOT/fx/wt-p2"
sh "$HERE/herdr.sh" start "$ROOT" "$POST" $S; sleep 2
P=$(rpc workspace.create "{\"cwd\":\"$ROOT/fx/wt-p\",\"label\":\"p\"}"); echo "$P" > "$OUT/b3-create-p.json"
rpc pane.report_agent "{\"pane_id\":\"$(root_pane "$P")\",\"source\":\"herdr:claude\",\"agent\":\"claude\",\"state\":\"idle\",\"agent_session_id\":\"sess-p\"}" > /dev/null
rpc workspace.create "{\"cwd\":\"$ROOT/fx/wt-p2\",\"label\":\"p2\"}" > "$OUT/b3-create-p2.json"
sleep 1; sh "$HERE/herdr.sh" stop "$ROOT" "$POST" $S; rm -rf "$ROOT/fx/wt-p" "$ROOT/fx/wt-p2"
sh "$HERE/herdr.sh" start "$ROOT" "$POST" $S; sleep 3
# ③
for r in r1 r2; do
  git init -q -b main "$ROOT/repos/$r" && git -C "$ROOT/repos/$r" -c user.email=l628@x -c user.name=l628 commit -q --allow-empty -m init
done
for wt in k1 lock prune remove; do git -C "$ROOT/repos/r1" worktree add -q -b "$wt" "$ROOT/repos/r1-$wt"; done
for r in r1 r2; do rpc worktree.open "{\"cwd\":\"$ROOT/repos/$r\",\"path\":\"$ROOT/repos/$r\",\"trust_repository\":true}" > "$OUT/b4-open-$r.json"; done
for i in 1 2 3 4 5; do rpc workspace.create "{\"cwd\":\"$HOME\",\"label\":\"home$i\"}" > "$OUT/b5-create-home$i.json"; done
mkdir -p "$ROOT/ud"; printf '["%s","%s"]\n' "$ROOT/repos/r1" "$ROOT/repos/r2" > "$ROOT/ud/repos.json"
sleep 1; rpc pane.list > "$OUT/b6-ready-pane-list.json"
cat "$ROOT/logs/claude-launch.log" > "$OUT/b7-claude-launch.log"
echo "ready at=$(date -u +%FT%TZ)" > "$OUT/b-ready.txt"
