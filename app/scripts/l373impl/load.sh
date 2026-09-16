#!/bin/bash
# 계측용 합성 부하 — 에이전트 TUI 모양(고정 박스 + 스피너 + 진행 줄)을 초당 N회 다시 그린다.
# 인자: <hz> <seconds> [tag]
hz=${1:-10}
secs=${2:-30}
tag=${3:-load}
frames=$(( hz * secs ))
sp='|/-\'
i=0
while [ $i -lt $frames ]; do
  s=${sp:$(( i % 4 )):1}
  printf '\033[H\033[2J'
  printf '┌──────────────────────────────────────┐\n'
  printf '│ %s %-8s frame %-6d %-8s │\n' "$s" "$tag" "$i" "$(date +%H:%M:%S)"
  printf '├──────────────────────────────────────┤\n'
  n=0
  while [ $n -lt 16 ]; do
    printf '│ \033[3%dm%-36s\033[0m │\n' $(( (i + n) % 8 )) "row $n  $(printf '%0.s=' $(seq 1 $(( (i + n) % 28 + 1 ))))"
    n=$(( n + 1 ))
  done
  printf '└──────────────────────────────────────┘\n'
  i=$(( i + 1 ))
  perl -e "select(undef,undef,undef,1/$hz)"
done
