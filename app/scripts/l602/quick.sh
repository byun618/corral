#!/bin/zsh
# LIFE-602 빠른 확인 — typecheck · test · check:boundary · lint 를 돌려 원자료를 남긴다.
# 사용: quick.sh <라벨>   (원자료: specs/LIFE-602-task-detail/raw/claude/<라벨>-*.txt)
set -u
label=$1
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-602-task-detail/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l602w; mkdir -p $TMPDIR
cd $app
head=$(git rev-parse --short HEAD)
# test 는 `vitest run && nodetest` 라 vitest 가 실패하면 nodetest 가 안 돈다 — nodetest 를 따로 한 번 더 돌린다.
for step in typecheck test nodetest check:boundary lint; do
  out=$raw/$label-${step/:/-}.txt
  if [[ $step == nodetest ]]; then cmd=(node scripts/run-nodetest.mjs); else cmd=(npm run $step); fi
  { echo "# $label · ${cmd[*]} · HEAD $head · $(date -u +%FT%TZ)"; "${cmd[@]}" 2>&1; echo "# exit $?"; } > $out 2>&1
  code=$(tail -1 $out | sed 's/# exit //')
  echo "$step exit=$code -> ${out#${app:h}/}"
done
