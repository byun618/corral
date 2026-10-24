#!/bin/zsh
# LIFE-675 빠른 확인 — typecheck · test · nodetest · check:boundary · lint 를 돌려 원자료를 남긴다 (l693/quick.sh 를 옮김, 회차마다 uptime 한 줄).
# 사용: quick.sh <라벨>   (원자료: specs/LIFE-675-resource-move-hidden/raw/claude/<라벨>-*.txt)
#       quick.sh base     — lint 기준값만 r1-lint-base.txt 로 남긴다 (고치기 전, 기준 commit 상태에서)
# 종료코드: 실패한 단계가 하나라도 있으면 1. lint 는 원 exit 를 기록만 하고, 판정은 r1-lint-base.txt 와의 diff
# (<라벨>-lint-diff.txt, 새 문제 0 = exit 0)로 센다. 두 원자료는 같은 규칙으로 정규화한다 — 절대경로의 첫 `…/app/` 접두
# (앞의 `/private` 포함)를 지워 checkout 경로에 묶이지 않게 한다 (f1 E). 머리줄에 HEAD·`git status --porcelain` 줄 수.
set -u
label=$1
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-675-resource-move-hidden/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l675w; mkdir -p $TMPDIR
cd $app
head="$(git rev-parse --short HEAD) · porcelain $(git status --porcelain | wc -l | tr -d ' ')줄"
load() { echo "# uptime $(uptime)"; }
lint_body() { grep -v '^#' $1 | perl -pe 's#^(/private)?/\S*?/app/##' | grep -v '^$' | grep -v '^> '; }
if [[ $label == base ]]; then
  out=$raw/r1-lint-base.txt
  { echo "# base · npm run lint · HEAD $head · $(date -u +%FT%TZ)"; load; npm run lint 2>&1; echo "# exit $?"; } > $out 2>&1
  echo "lint(base) $(tail -1 $out) · $(grep -E '^✖' $out) -> ${out#${app:h}/}"
  exit 0
fi
failed=()
# test 는 `vitest run && nodetest` 라 vitest 가 실패하면 nodetest 가 안 돈다 — nodetest 를 따로 한 번 더 돌린다.
for step in typecheck test nodetest check:boundary lint; do
  out=$raw/$label-${step/:/-}.txt
  if [[ $step == nodetest ]]; then cmd=(node scripts/run-nodetest.mjs); else cmd=(npm run $step); fi
  { echo "# $label · ${cmd[*]} · HEAD $head · $(date -u +%FT%TZ)"; load; "${cmd[@]}" 2>&1; echo "# exit $?"; } > $out 2>&1
  code=$(tail -1 $out | sed 's/# exit //')
  echo "$step exit=$code -> ${out#${app:h}/}"
  [[ $step != lint && $code != 0 ]] && failed+=($step)
done
out=$raw/$label-lint-diff.txt
{ echo "# 입력: r1-lint-base.txt · $label-lint.txt. 머리줄·exit 줄·빈 줄·npm 머리 제외, 첫 …/app/ 접두(/private 포함) 제거"
  echo "# 기준 $(tail -1 $raw/r1-lint-base.txt) · $(grep -E '^✖' $raw/r1-lint-base.txt)"
  echo "# 이번 $(tail -1 $raw/$label-lint.txt) · $(grep -E '^✖' $raw/$label-lint.txt)"
  diff <(lint_body $raw/r1-lint-base.txt) <(lint_body $raw/$label-lint.txt)
  echo "# diff exit $?"; } > $out 2>&1
code=$(tail -1 $out | sed 's/# diff exit //')
echo "lint-diff exit=$code -> ${out#${app:h}/}"
[[ $code != 0 ]] && failed+=(lint-diff)
if (( ${#failed} > 0 )); then echo "실패 단계: ${failed[*]}"; exit 1; fi
exit 0
