#!/bin/zsh
# LIFE-605 최종 관문 마무리 — 비밀값 grep(커밋할 원자료 전체) · 잔존(프로세스·/tmp·기준 worktree). app/ 에서: scripts/l605/final-residue.sh <OUT>
# /tmp 는 이 작업이 만든 것만 지운다(/tmp/l605-dmg-herdr · /tmp/l605w-*). 리뷰어 /tmp/l605-review-r* · /tmp/l605t(TMPDIR) 는 건드리지 않는다.
set -u
OUT=${1:A}; mkdir -p $OUT
print -r -- 'fail incomplete' > $OUT/ALL
cd "$(dirname $0)/../.."
RAW=../specs/LIFE-605-jira-cloud/raw
git rev-parse --short HEAD > $OUT/head.txt
: > $OUT/VERDICT
failed=0
source scripts/l605/judge.zsh
secrets() { local hits=$(grep -rlE 'ATATT|fixture\.invalid|Basic [A-Za-z0-9+/=]{12,}' $RAW); print -r -- "파일 $(find $RAW -type f | wc -l | tr -d ' ')개 · 적중 ${hits:-없음}"; [[ -z $hits ]]; }
run sc-raw-secret 0 secrets
# 이메일 꼴 — secret-grep 자기시험의 「바늘@파일」 표지(`email@corral.ndjson`·`token@blob.bin` 류, 끝이 파일 확장자)는 주소가 아니라 뺀다.
emails() { local hits=$(grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' $RAW | grep -vE '@[A-Za-z0-9-]+\.(ndjson|bin|json|txt|log)$' | sort -u); print -r -- "적중 ${hits:-없음}"; [[ -z $hits ]]; }
run sc-raw-email 0 emails
tmpclean() { [[ -d /tmp/l605-dmg-herdr ]] && rm -rf /tmp/l605-dmg-herdr; for d in /tmp/l605w-*(N); do rm -rf $d; done; print -r -- "남은 /tmp/l605*:"; print -l /tmp/l605*(N); [[ ! -e /tmp/l605-dmg-herdr && -z $(print /tmp/l605w-*(N)) ]]; }
run res-tmp 0 tmpclean
# 전체 ps 는 사용자 다른 프로세스의 인자가 들어 있어 원자료에 넣지 않는다(/tmp/l605t 에만) — 후보 줄만 출력에.
procs() { ps -Ao pid,ppid,etime,command > /tmp/l605t/ps-all.txt; local mine=$(grep -E 'vitest|mut\.py|electron-builder|final\.sh|before-after\.sh|final-tail|selfcheck\.sh|quick\.sh|l605w|l605-dmg|cargo|rustc|LIFE-605-jira-cloud-claude/app' /tmp/l605t/ps-all.txt | grep -vE 'grep -E|final-residue'); print -r -- "후보 ${mine:-없음}"; print -r -- "하트비트(이 일감 — 보고 직전에 끈다): $(grep -F 'hb6.sh' /tmp/l605t/ps-all.txt | grep -v grep | awk '{print $1}')"; [[ -z $mine ]]; }
run res-procs 0 procs
worktree() { git worktree list | tee /dev/stderr | grep -c 'LIFE-605-base-' | grep -qx 0; }
run res-base-worktree 0 worktree
judge_close 5
