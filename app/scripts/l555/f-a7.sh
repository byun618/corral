#!/bin/sh
# LIFE-555 A7 — 설치본이 사용자 userData 를 썼다는 원자료 + 저장소 목록·설정이 관문 전과 같음 → 앱을 끄고 백업 복원 → 복원본 sha256 목록 = 관문 전 목록.
# 사용: sh f-a7.sh <백업 루트> <원자료 폴더>   (설치본이 사용자 userData 로 떠 있는 상태에서)
. "$(dirname "$0")/f-lib.sh"
BK=$1; OUT=$2
PID=$(inst_mains | head -1); echo "app pid=$PID"; check app_running "$([ -n "$PID" ] && echo yes)" yes
corral status --json > /tmp/l555f-a7.status; RC=$?; check status_exit0 "$RC" 0
SOCK=$(json_get 'r.result.target.socket' < /tmp/l555f-a7.status); echo "status socket=$SOCK"
check socket_in_user_userdata "$SOCK" "$UD/runtime/rpc.sock"
control socket_in_user_userdata "$SOCK" "$UD/runtime/RPC.sock"
echo "## 앱이 연 userData 파일(lsof 발췌)"; lsof -p "$PID" 2>/dev/null | grep -F "$UD" | awk '{print $NF}' | sed "s#$HOME#~#" | sort -u | head -15
check log_open_by_app "$(lsof -p "$PID" 2>/dev/null | grep -cF "$UD/corral.ndjson")" 1
echo "app user-data-dir: $(ps -o command= -p "$PID")  (인자 없음 = Electron 기본 appData/corral)"
echo "## 저장소 목록·설정 — 관문 전 백업과 비교"
for f in repos.json settings.json ui-prefs.json; do
  if cmp -s "$UD/$f" "$BK/data/$f"; then echo "$f: 바이트 같음"; R=same; else
    R=$("$N" -e 'const fs=require("fs");const a=JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1])));const b=JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2])));console.log(a===b?"same-json":"differs")' "$UD/$f" "$BK/data/$f"); echo "$f: 바이트 다름 → JSON 비교 $R"; fi
  [ "$f" = ui-prefs.json ] || check "unchanged.$f" "$(echo "$R" | sed 's/same-json/same/')" same
done
echo "(ui-prefs.json 은 화면 선택 상태라 A6 조작으로 바뀔 수 있다 — 판정 밖, 복원으로 되돌린다)"
echo "## 앱 끄기"; stop_pid "$PID"; sleep 1; check app_off "$(inst_mains | grep -c .)" 0
echo "## 복원 (rsync -a --delete 백업 → userData)"
# --checksum: Chromium GPU 캐시 index 는 크기·mtime 을 그대로 둔 채 내용만 덮어쓴다 — rsync 기본 비교(크기+mtime)는 그 파일을 건너뛴다(f11 실측)
rsync -a --delete --checksum "$BK/data/" "$UD/"; RC=$?; check restore_exit0 "$RC" 0
(cd "$UD" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256) > "$OUT/a7-restored-sha256.txt"
PRE=$(shasum -a 256 < "$BK/pre-sha256.txt" | cut -d' ' -f1); POST=$(shasum -a 256 < "$OUT/a7-restored-sha256.txt" | cut -d' ' -f1)
echo "pre_list=$PRE restored_list=$POST files=$(grep -c . "$OUT/a7-restored-sha256.txt")"
check restored_equals_pre "$POST" "$PRE"
control restored_equals_pre "$POST" "$(shasum -a 256 < "$OUT/a7-pre-sha256.txt" | cut -d' ' -f1 | tr '0-9a-f' 'f0-9a-e')"
[ "$POST" = "$PRE" ] || diff "$BK/pre-sha256.txt" "$OUT/a7-restored-sha256.txt" | head -20
rm -f /tmp/l555f-a7.*
echo "fails=$FAILS"; exit $FAILS
