#!/bin/zsh
# LIFE-689 빠른 확인 (app/scripts/l691/quick.sh 에서 옮김) — typecheck · test · check:boundary · lint 를 돌려 원자료를 남긴다.
# 사용: quick.sh <라벨>   (원자료: specs/LIFE-689-file-tab-label/raw/claude/<라벨>-*.txt)
# 종료코드(f1 F): 실패한 단계가 하나라도 있으면 1. lint 는 기준(18b98be69)부터 553건으로 exit 1 이라 원 exit 는 기록만 하고,
# 판정은 기준 원자료 r1-lint-base.txt 와의 diff(<라벨>-lint-diff.txt, 새 문제 0 = exit 0)로 센다.
set -u
label=$1
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-689-file-tab-label/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l689w; mkdir -p $TMPDIR
cd $app
head=$(git rev-parse --short HEAD)
# 작업 트리 상태 — 커밋 전 트리를 돌렸는지 원자료만으로 알 수 있게 머리줄에 줄 수를 남긴다(f1 F2)
dirty=$(git status --porcelain | wc -l | tr -d ' ')
failed=()
# test 는 `vitest run && nodetest` 라 vitest 가 실패하면 nodetest 가 안 돈다 — nodetest 를 따로 한 번 더 돌린다.
for step in typecheck test nodetest check:boundary lint; do
  out=$raw/$label-${step/:/-}.txt
  if [[ $step == nodetest ]]; then cmd=(node scripts/run-nodetest.mjs); else cmd=(npm run $step); fi
  { echo "# $label · ${cmd[*]} · HEAD $head · porcelain ${dirty}줄 · $(date -u +%FT%TZ)"; "${cmd[@]}" 2>&1; echo "# exit $?"; } > $out 2>&1
  code=$(tail -1 $out | sed 's/# exit //')
  echo "$step exit=$code -> ${out#${app:h}/}"
  [[ $step != lint && $code != 0 ]] && failed+=($step)
done
out=$raw/$label-lint-diff.txt
# lint 줄 정규화 — 기준·현재 **같은 규칙**(f1 F2): 머리줄·빈 줄·npm 머리 제외, 절대경로는 첫 `/app/` 까지(`/private` 포함) 지워 app 기준 상대경로로.
# 기준 파일을 만든 worktree 와 지금 돌리는 checkout 이 달라도 문제 목록이 같으면 diff 0 이다.
norm() { grep -v '^#' "$1" | perl -pe 's{^(/private)?/.*?/app/}{}' | grep -v '^$' | grep -v '^> '; }
{ echo "# 입력: r1-lint-base.txt (기준 18b98be69 무수정 트리) · $label-lint.txt — 양쪽 norm() 같은 규칙 · HEAD $head · porcelain ${dirty}줄"
  diff <(norm $raw/r1-lint-base.txt) <(norm $raw/$label-lint.txt)
  echo "# diff exit $?"; } > $out 2>&1
code=$(tail -1 $out | sed 's/# diff exit //')
echo "lint-diff exit=$code -> ${out#${app:h}/}"
[[ $code != 0 ]] && failed+=(lint-diff)
if (( ${#failed} > 0 )); then echo "실패 단계: ${failed[*]}"; exit 1; fi
exit 0
