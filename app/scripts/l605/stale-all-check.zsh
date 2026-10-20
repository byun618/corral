#!/bin/zsh
# LIFE-605 R3-F — 관문 스크립트가 첫머리에서 이전 ALL 을 「미완」 으로 덮는지 본다.
#   zsh scripts/l605/stale-all-check.zsh <관문 스크립트> <빈 OUT>   → 옛 ALL=pass 를 심고 L605_STOP_AFTER_MARK=1 로 돌려(표지만 쓰고 exit 3) ALL 이 「fail incomplete」 면 exit 0, 아니면 exit 1.
set -u
script=$1 dir=${2:A}
mkdir -p $dir
print -r -- pass > $dir/ALL
L605_STOP_AFTER_MARK=1 zsh $script $dir > $dir/run.txt 2>&1
code=$?
got=$(cat $dir/ALL)
print -r -- "exit $code · ALL $got"
[[ $code == 3 && $got == 'fail incomplete' ]] && { print -r -- stale-all-ok; exit 0 }
print -r -- stale-all-left
exit 1
