#!/bin/sh
# 장면 한 회차 = 원자료 폴더 하나. sh scripts/l694/run.sh <실행 id> <ROOT> <FAKE> <장면> <원자료 상위 폴더>
#   → <상위>/<id>-<장면>/{run.txt(uptime·명령·출력·exit), <장면>.json, 캡처}. c2a 의 pane 기록은 상위 폴더 c2a-panes.json 로도 둔다(c3·c5 가 읽는다).
set -u
ID=$1; ROOT=$2; FAKE=$3; SCENE=$4; BASE=$5
OUT="$BASE/$ID-$SCENE"; mkdir -p "$OUT"
[ -f "$BASE/c2a-panes.json" ] && cp "$BASE/c2a-panes.json" "$OUT/c2a-panes.json"
{ echo "uptime: $(uptime)"; echo "cmd: node scripts/l694/gate.mjs $ROOT $FAKE $SCENE $OUT"; } > "$OUT/run.txt"
"$HOME/.nvm/versions/node/v24.14.1/bin/node" "$(dirname "$0")/gate.mjs" "$ROOT" "$FAKE" "$SCENE" "$OUT" >> "$OUT/run.txt" 2>&1
code=$?
echo "exit=$code" >> "$OUT/run.txt"
[ "$SCENE" = c2a ] && [ -f "$OUT/c2a-panes.json" ] && cp "$OUT/c2a-panes.json" "$BASE/c2a-panes.json"
tail -2 "$OUT/run.txt"
exit $code
