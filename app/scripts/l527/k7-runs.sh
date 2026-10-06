#!/bin/zsh
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"  # worktree 루트 — 스크립트 위치 기준(fix2 H5)
R=specs/LIFE-527-titlebar/raw/claude
N=$HOME/.nvm/versions/node/v24.14.1/bin/node
M=app/scripts/gui-diff/measure.mjs
run() { label=$1; shift; $N $M --work /tmp/l527w --out $R/measure --ledger $R/measure-runs.md --label $label "$@" > $R/build/measure-$label.stdout 2>&1; echo "$label exit=$?" >> $R/build/k7-exits.txt; }
: > $R/build/k7-exits.txt
run k7-before-a-r2 --corral-app /tmp/l527-base/app --areas sidebar,tabbar,titlebar --states default
run k7-before-b-r2 --corral-app /tmp/l527-base/app --areas titlebar,tabbar --states sidebar-hidden,split-right,split-down,split-right-hidden,split-down-hidden
run k7-before-c-r2 --corral-app /tmp/l527-base/app --areas titlebar,settings --states settings-open
run k7-after-a-r2 --areas sidebar,tabbar,titlebar --states default
run k7-after-b-r2 --areas titlebar,tabbar --states sidebar-hidden,split-right,split-down,split-right-hidden,split-down-hidden
run k7-after-c-r2 --areas titlebar,settings --states settings-open
