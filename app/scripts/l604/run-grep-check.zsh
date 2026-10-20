#!/bin/zsh
# LIFE-604 R4-H — quick.sh 의 run_grep 판별력 점검. quick.sh 에서 record·run_grep 을 그대로 떼어 와(같은 코드) 세 경우를 돌린다:
# ① 기대 종료코드 + 기대 문구 → pass ② 기대 종료코드지만 문구 없음(다른 이유의 실패) → fail ③ 문구는 있으나 종료코드 다름 → fail. 셋이 기대대로면 exit 0.
set -u
OUT=${1:A}; mkdir -p $OUT; : > $OUT/VERDICT; failed=0
eval "$(awk '/^record\(\) \{/,/^\}/' ${0:A:h}/quick.sh)"
eval "$(awk '/^run_grep\(\) \{/,/^\}/' ${0:A:h}/quick.sh)"
run_grep g-right 1 '기대한 실패 문구' zsh -c 'print 기대한 실패 문구; exit 1'
run_grep g-wrong-text 1 '기대한 실패 문구' zsh -c 'print 인자 오류; exit 1'
run_grep g-wrong-code 1 '기대한 실패 문구' zsh -c 'print 기대한 실패 문구; exit 2'
want=$'g-right\tpass\ng-wrong-text\tfail\ng-wrong-code\tfail'
got=$(awk -F'\t' '{print $1 "\t" $5}' $OUT/VERDICT)
print -r -- "$got"
[[ $got == $want ]] && { print -r -- 'run_grep 판별: 기대대로'; exit 0; } || { print -r -- 'run_grep 판별: 어긋남'; exit 1; }
