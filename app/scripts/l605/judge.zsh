# LIFE-605 R2-A — 관문 스크립트(final.sh·selfcheck.sh)가 quick.sh 의 판정 함수(record·run·run_grep)를 끌어오고, 끝에서 VERDICT 행 수를 대조한다.
#   source scripts/l605/judge.zsh   (함수 원본 = scripts/l605/quick.sh)   → 함수 셋 중 하나라도 정의되지 않으면 **exit 2**(아무것도 안 돌고 통과하는 길을 막는다)
#   judge_close <기대 행 수>   → VERDICT 행 수가 기대와 다르면 failed 를 올리고 ALL 에 「rows n/m」 을 적는다
# 원본은 L605_JUDGE_SRC 로 바꿀 수 있다 — 양성 대조(함수 없는 사본)만 쓴다.
judge_src=${L605_JUDGE_SRC:-scripts/l605/quick.sh}
eval "$(awk '/^record\(\) \{/,/^\}/' $judge_src)"
eval "$(awk '/^run\(\) \{/,/^\}/' $judge_src)"
eval "$(awk '/^run_grep\(\) \{/,/^\}/' $judge_src)"
if ! typeset -f record run run_grep > /dev/null; then
  print -r -- "판정 함수(record·run·run_grep)가 $judge_src 에 없다 — 멈춘다(exit 2)"
  [[ -n ${OUT:-} ]] && print -r -- "fail judge-missing" > $OUT/ALL
  exit 2
fi
judge_close() {
  local want=$1
  local got=$(grep -c '' $OUT/VERDICT)
  if [[ $got != $want ]]; then
    failed=$((failed + 1))
    print -r -- "rows	기대 $want	실제 $got	목록 -	fail" >> $OUT/VERDICT
    print -r -- "VERDICT 행 수 $got/$want → fail"
  fi
  print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
  cat $OUT/ALL
}
