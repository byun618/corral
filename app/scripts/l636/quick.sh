#!/bin/sh
# LIFE-636 빠른 확인 러너 — 회차 하나 = 명령 하나. 출력 전문을 <out>/<id>.txt 에, 종료코드를 마지막 줄 `exit=<n>` 으로 남긴다.
# 판정 합계는 runs.md 의 칸 값으로만 센다(이 러너는 집계하지 않는다).
# 사용: sh app/scripts/l636/quick.sh <out 디렉터리> <id> <작업 디렉터리> <명령…>
set -u
OUT=$1; ID=$2; DIR=$3; shift 3
mkdir -p "$OUT"
FILE="$OUT/$ID.txt"
{
  echo "# id=$ID"
  echo "# dir=$DIR"
  echo "# cmd=$*"
  echo "# start=$(date -u +%Y-%m-%dT%H:%M:%SZ) head=$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo '(archive)')"
} > "$FILE"
( cd "$DIR" && export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l636t && mkdir -p "$TMPDIR" && "$@" ) >> "$FILE" 2>&1
CODE=$?
echo "# end=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$FILE"
echo "exit=$CODE" >> "$FILE"
echo "$ID exit=$CODE"
