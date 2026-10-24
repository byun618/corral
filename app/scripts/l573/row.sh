#!/bin/sh
# LIFE-573 — 화면 한 행을 제자리에서 바꾼다. 사용: sh row.sh <행 폴더> <id>
# <id>.before 를 찍고 <id>.go 가 생길 때까지 기다렸다가 커서를 한 줄 올려 그 행을 지우고 <id>.after 를 찍는다.
# 명령줄에 URL 이 안 나오게 내용은 파일로만 받는다.
D=$1; ID=$2
cat "$D/$ID.before"
while [ ! -e "$D/$ID.go" ]; do sleep 0.02; done
printf '\033[1A\r\033[2K'
cat "$D/$ID.after"
