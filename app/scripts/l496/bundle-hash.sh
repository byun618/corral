#!/bin/sh
# LIFE-496 fix1 C2 — 네이티브가 읽는 빌드 산출물(app/out) 의 파일별 sha256 과 합계 해시를 남긴다.
# 빌드 직후 · native-up 직전 · native-down 직후에 같은 값이면, 네이티브가 읽은 bundle 이 그 빌드(= 그 소스) 것이다.
# 사용: sh bundle-hash.sh <app 폴더> <출력 파일>
APP=$1; OUT=$2
[ -d "$APP/out" ] || { echo "out 없음: $APP/out" >&2; exit 2; }
( cd "$APP" && find out -type f | LC_ALL=C sort | xargs shasum -a 256 ) > "$OUT"
printf 'total %s\n' "$(shasum -a 256 < "$OUT" | cut -d' ' -f1)" >> "$OUT"
tail -1 "$OUT"
