#!/bin/zsh
# LIFE-605 R2-A 양성 대조 — judge.zsh 가 ① 함수 없는 원본이면 exit 2 ② 행이 모자라면 ALL=fail ③ 맞으면 pass 를 내는가. app/ 에서: zsh scripts/l605/judge-selftest.zsh <OUT>
set -u
BASE=${1:A}; mkdir -p $BASE
cd "$(dirname $0)/../.."
APPDIR=$PWD
print -r -- 'echo 함수 없음' > $BASE/no-fn-quick.sh
# ① 함수 결손
( OUT=$BASE/missing; mkdir -p $OUT; failed=0; L605_JUDGE_SRC=$BASE/no-fn-quick.sh; source $APPDIR/scripts/l605/judge.zsh; run never 0 true; judge_close 1 ) > $BASE/missing.txt 2>&1
c1=$?
# ② 행 모자람(기대 3, 2행만)
( OUT=$BASE/short; mkdir -p $OUT; : > $OUT/VERDICT; failed=0; source $APPDIR/scripts/l605/judge.zsh; run a 0 true; run b 0 true; judge_close 3 ) > $BASE/short.txt 2>&1
c2=$(cat $BASE/short/ALL)
# ③ 맞음
( OUT=$BASE/full; mkdir -p $OUT; : > $OUT/VERDICT; failed=0; source $APPDIR/scripts/l605/judge.zsh; run a 0 true; run b 0 true; run c 0 true; judge_close 3 ) > $BASE/full.txt 2>&1
c3=$(cat $BASE/full/ALL)
print -r -- "missing exit=$c1 ALL=$(cat $BASE/missing/ALL 2>/dev/null) · short ALL=$c2 · full ALL=$c3"
[[ $c1 == 2 && $c2 == 'fail 1' && $c3 == pass ]] && { echo selftest-pass; exit 0 }
echo selftest-fail; exit 1
