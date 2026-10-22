#!/bin/zsh
# LIFE-691 빠른 확인 — typecheck · test · check:boundary · lint 를 돌려 원자료를 남긴다.
# 사용: quick.sh <라벨>   (원자료: specs/LIFE-691-tab-close-focus/raw/claude/<라벨>-*.txt)
# 종료코드(f1 F): 실패한 단계가 하나라도 있으면 1. lint 는 기준(c0f204ae9)부터 553건으로 exit 1 이라 원 exit 는 기록만 하고,
# 판정은 기준 원자료 r1-lint-base.txt 와의 diff(<라벨>-lint-diff.txt, 새 문제 0 = exit 0)로 센다.
set -u
label=$1
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-691-tab-close-focus/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l691w; mkdir -p $TMPDIR
cd $app
head=$(git rev-parse --short HEAD)
failed=()
# test 는 `vitest run && nodetest` 라 vitest 가 실패하면 nodetest 가 안 돈다 — nodetest 를 따로 한 번 더 돌린다.
for step in typecheck test nodetest check:boundary lint; do
  out=$raw/$label-${step/:/-}.txt
  if [[ $step == nodetest ]]; then cmd=(node scripts/run-nodetest.mjs); else cmd=(npm run $step); fi
  { echo "# $label · ${cmd[*]} · HEAD $head · $(date -u +%FT%TZ)"; "${cmd[@]}" 2>&1; echo "# exit $?"; } > $out 2>&1
  code=$(tail -1 $out | sed 's/# exit //')
  echo "$step exit=$code -> ${out#${app:h}/}"
  [[ $step != lint && $code != 0 ]] && failed+=($step)
done
out=$raw/$label-lint-diff.txt
{ echo "# 입력: r1-lint-base.txt (기준 c0f204ae9 사본; '/private' 접두사 제거) · $label-lint.txt. 머리줄·exit 줄·빈 줄·npm 머리 제외"
  diff <(grep -v '^#' $raw/r1-lint-base.txt | sed 's|^/private||' | grep -v '^$') <(grep -v '^#' $raw/$label-lint.txt | sed "s|$app/||" | grep -v '^$' | grep -v '^> ')
  echo "# diff exit $?"; } > $out 2>&1
code=$(tail -1 $out | sed 's/# diff exit //')
echo "lint-diff exit=$code -> ${out#${app:h}/}"
[[ $code != 0 ]] && failed+=(lint-diff)
if (( ${#failed} > 0 )); then echo "실패 단계: ${failed[*]}"; exit 1; fi
exit 0
