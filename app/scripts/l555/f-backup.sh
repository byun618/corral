#!/bin/sh
# LIFE-555 A7 — 사용자 userData 바이트 백업 + 파일별 sha256 목록. 사용: sh f-backup.sh <백업 루트 /tmp/life555-userdata-*> <원자료 폴더>
# 백업 본체는 /tmp 에만 둔다(커밋 금지) — 원자료에는 목록·경로·합계 해시만.
. "$(dirname "$0")/f-lib.sh"
BK=$1; OUT=$2
case "$BK" in /tmp/life555-userdata-*) ;; *) echo "백업 경로는 /tmp/life555-userdata-* 만"; exit 2 ;; esac
[ -e "$BK" ] && { echo "$BK 가 이미 있다"; exit 2; }
check corral_not_running "$(inst_mains | grep -c .)" 0
mkdir -p "$BK"; chmod 700 "$BK"
# rsync -a: 권한·시각·심링크·특수파일(소켓) 보존. 끝 슬래시 — 내용물을 data/ 로
rsync -a "$UD/" "$BK/data/"; RC=$?; check rsync_exit0 "$RC" 0
hashlist() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256); }
hashlist "$UD" > "$OUT/a7-pre-sha256.txt"; hashlist "$BK/data" > "$BK/backup-sha256.txt"
cp "$OUT/a7-pre-sha256.txt" "$BK/pre-sha256.txt"
echo "files=$(grep -c . "$OUT/a7-pre-sha256.txt") list_sha256=$(shasum -a 256 < "$OUT/a7-pre-sha256.txt" | cut -d' ' -f1)"
check backup_equals_source "$(shasum -a 256 < "$BK/backup-sha256.txt" | cut -d' ' -f1)" "$(shasum -a 256 < "$OUT/a7-pre-sha256.txt" | cut -d' ' -f1)"
control backup_equals_source "$(shasum -a 256 < "$BK/backup-sha256.txt" | cut -d' ' -f1)" "$(printf 'x' | shasum -a 256 | cut -d' ' -f1)"
echo "backup=$BK"; du -sh "$BK/data"
echo "## 비정규 파일(소켓·링크) — 목록 대조 밖"; find "$UD" ! -type f ! -type d | sed "s#$HOME#~#"
echo "fails=$FAILS"; exit $FAILS
