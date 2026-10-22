#!/bin/zsh
# LIFE-691 K1 표 시험 — group-tree.leave.test.ts 만 돌려 원자료를 남긴다.
# 사용: k1.sh <라벨>   (원자료: specs/LIFE-691-tab-close-focus/raw/claude/<라벨>-k1.txt)
set -u
label=$1
app=${0:A:h:h:h}
raw=${app:h}/specs/LIFE-691-tab-close-focus/raw/claude
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l691w; mkdir -p $TMPDIR
cd $app
out=$raw/$label-k1.txt
{ echo "# $label · vitest run src/renderer/src/group-tree.leave.test.ts · HEAD $(git rev-parse --short HEAD) · $(date -u +%FT%TZ)"; npx vitest run src/renderer/src/group-tree.leave.test.ts 2>&1; echo "# exit $?"; } > $out 2>&1
echo "k1 $(tail -1 $out) -> ${out#${app:h}/}"
