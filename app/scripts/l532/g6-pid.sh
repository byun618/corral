#!/bin/sh
# LIFE-532 G6 — 설치본 main pid 가 전 목록에 있는가. 사용: sh g6-pid.sh <전 파일> <후 파일> [강제 pid(음성 대조용)]
# 전 파일의 pid 줄은 fg-01 때 필터가 CLI 행까지 넣은 꼴(`pid  설치본 main  50761 72109 73634`)이라 목록 안의 포함으로 본다.
BEFORE=$1; AFTER=$2
M=${3:-$(awk '/^pid /{print $4}' "$AFTER")}
case "$M" in ''|*[!0-9]*) echo "g6-pid: 후 파일에서 pid 를 못 읽었다 ($M)"; exit 3 ;; esac
LIST=$(awk '/^pid /{for (i = 4; i <= NF; i++) if ($i ~ /^[0-9]+$/) printf " %s", $i}' "$BEFORE")
echo "후 main pid $M · 전 목록:$LIST"
case "$LIST " in *" $M "*) echo "G6 설치본 main pid 전=후 같음 ($M)"; exit 0 ;; *) echo "G6 설치본 main pid $M 이 전 목록에 없다"; exit 1 ;; esac
