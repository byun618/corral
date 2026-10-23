#!/bin/zsh
# LIFE-693 빠른 확인 — typecheck · test · nodetest · check:boundary · lint 를 돌려 원자료를 남긴다 (l691/quick.sh 를 옮김).
# 사용: quick.sh <라벨>   (원자료: specs/LIFE-693-confirm-scroll/raw/claude/<라벨>-*.txt)
#       quick.sh base     — lint 기준값만 r1-lint-base.txt 로 남긴다 (고치기 전, 기준 commit 상태에서)
# 종료코드: 실패한 단계가 하나라도 있으면 1. lint 는 원 exit 를 기록만 하고, 판정은 r1-lint-base.txt 와의 diff
# (<라벨>-lint-diff.txt, 새 문제 0 = exit 0)로 센다. 두 원자료 모두 이 worktree 경로를 지운 뒤 대조한다.
set -u
label=$1
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-693-confirm-scroll/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l693w; mkdir -p $TMPDIR
cd $app
head=$(git rev-parse --short HEAD)
lint_body() { grep -v '^#' $1 | sed "s|$app/||" | grep -v '^$' | grep -v '^> '; }
if [[ $label == base ]]; then
  out=$raw/r1-lint-base.txt
  { echo "# base · npm run lint · HEAD $head · $(date -u +%FT%TZ)"; npm run lint 2>&1; echo "# exit $?"; } > $out 2>&1
  echo "lint(base) $(tail -1 $out) · $(grep -E '^✖' $out) -> ${out#${app:h}/}"
  exit 0
fi
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
{ echo "# 입력: r1-lint-base.txt · $label-lint.txt. 머리줄·exit 줄·빈 줄·npm 머리 제외, worktree 경로 제거"
  echo "# 기준 $(tail -1 $raw/r1-lint-base.txt) · $(grep -E '^✖' $raw/r1-lint-base.txt)"
  echo "# 이번 $(tail -1 $raw/$label-lint.txt) · $(grep -E '^✖' $raw/$label-lint.txt)"
  diff <(lint_body $raw/r1-lint-base.txt) <(lint_body $raw/$label-lint.txt)
  echo "# diff exit $?"; } > $out 2>&1
code=$(tail -1 $out | sed 's/# diff exit //')
echo "lint-diff exit=$code -> ${out#${app:h}/}"
[[ $code != 0 ]] && failed+=(lint-diff)
if (( ${#failed} > 0 )); then echo "실패 단계: ${failed[*]}"; exit 1; fi
exit 0
