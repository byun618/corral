#!/bin/zsh
# K7 a 묶음 재측정 — r2 의 before-a 가 sidebar-head 선택자 0개(옛 빌드엔 [data-brandbar] 뿐)로 관문 미달 → 선택자 대체를 더한 뒤 전후 둘 다 다시
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-527-titlebar-claude
R=specs/LIFE-527-titlebar/raw/claude
N=$HOME/.nvm/versions/node/v24.14.1/bin/node
M=app/scripts/gui-diff/measure.mjs
run() { label=$1; shift; $N $M --work /tmp/l527w --out $R/measure --ledger $R/measure-runs.md --label $label "$@" > $R/build/measure-$label.stdout 2>&1; echo "$label exit=$?" >> $R/build/k7-exits.txt; }
run k7-before-a-r3 --corral-app /tmp/l527-base/app --areas sidebar,tabbar,titlebar --states default
run k7-after-a-r3 --areas sidebar,tabbar,titlebar --states default
