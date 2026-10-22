#!/bin/zsh
# LIFE-628 최종 관문 에이전트 대역 — 띄워진 argv·cwd·pid 를 남기고 살아 있는다(ps 에 이 경로와 argv 가 보인다).
print -r -- "$(date -u +%FT%TZ) pid=$$ cwd=$PWD argv=$*" >> "${L628_ROOT:-/tmp/l6g}/logs/claude-launch.log"
while :; do sleep 3600; done
