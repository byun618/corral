#!/bin/sh
# LIFE-555 A7 재복원(코디 지시 f11 뒤) — 앱 0 확인 → rsync -a --delete --checksum → 관문 전 sha256 목록과 전량 대조.
# --checksum 이유: Chromium GPU 캐시 index 는 크기·mtime 을 그대로 둔 채 내용만 덮어쓴다(f11). 사용: sh f-restore.sh <백업 루트> <원자료 폴더>
. "$(dirname "$0")/f-lib.sh"
BK=$1; OUT=$2
ALL=$(ps -Ao pid=,command= | grep -F "$INST/Contents/" | grep -v grep | grep -c .); check corral_procs_zero "$ALL" 0
[ "$ALL" = 0 ] || { echo "corral 프로세스가 있다 — 복원하지 않는다"; exit 3; }
rsync -a --delete --checksum "$BK/data/" "$UD/"; RC=$?; check restore_exit0 "$RC" 0
(cd "$UD" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256) > "$OUT/a7-restored2-sha256.txt"
PRE=$(shasum -a 256 < "$BK/pre-sha256.txt" | cut -d' ' -f1); POST=$(shasum -a 256 < "$OUT/a7-restored2-sha256.txt" | cut -d' ' -f1)
echo "pre_list=$PRE restored_list=$POST files=$(grep -c . "$OUT/a7-restored2-sha256.txt")"
check restored_equals_pre "$POST" "$PRE"
control restored_equals_pre "$POST" "$(shasum -a 256 < "$OUT/a7-restored-sha256.txt" | cut -d' ' -f1)"
[ "$POST" = "$PRE" ] || diff "$BK/pre-sha256.txt" "$OUT/a7-restored2-sha256.txt" | head -20
echo "fails=$FAILS"; exit $FAILS
