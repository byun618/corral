#!/bin/zsh
# LIFE-527 fix1 F8 — 탭바 root 원점 분리(areas/tabbar.json origin)·분할 방향 검사 뒤 K7 a·b 묶음 전후 재측정.
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"  # worktree 루트 — 스크립트 위치 기준(fix2 H5)
R=specs/LIFE-527-titlebar/raw/claude
N=$HOME/.nvm/versions/node/v24.14.1/bin/node
M=app/scripts/gui-diff/measure.mjs
run() { label=$1; shift; $N $M --work /tmp/l527w --out $R/measure --ledger $R/measure-runs.md --label $label "$@" > $R/fix1/measure-$label.stdout 2>&1; echo "$label exit=$?" >> $R/fix1/k7-exits.txt; }
: > $R/fix1/k7-exits.txt
run k7-before-a-f1 --corral-app /tmp/l527-base/app --areas sidebar,tabbar,titlebar --states default
run k7-before-b-f1 --corral-app /tmp/l527-base/app --areas titlebar,tabbar --states sidebar-hidden,split-right,split-down,split-right-hidden,split-down-hidden
run k7-after-a-f1 --areas sidebar,tabbar,titlebar --states default
run k7-after-b-f1 --areas titlebar,tabbar --states sidebar-hidden,split-right,split-down,split-right-hidden,split-down-hidden
