#!/bin/sh
# LIFE-491 K5ⓒ — 문자열 리터럴 `'(detached)'`(작은따옴표 포함 — 주석 속 산문 「없는(detached)」 은 센티널이 아니다, 첫 판 g01·g02 가 그것까지 셌다)이 app/src 제품 코드(시험 파일 제외)에 몇 건인가. git-status.ts 의 git 출력 판독(`# branch.head (detached)`)은 예외로 따로 센다.
# 사용: sh sentinel-grep.sh <commit 또는 WORKTREE> — WORKTREE 면 작업 트리, 아니면 그 commit 의 트리를 grep 한다(양성 대조). 종료코드 = 예외 밖 건수(0 이면 통과).
REF=$1; root=$(git rev-parse --show-toplevel)
if [ "$REF" = WORKTREE ]; then hits=$(cd "$root" && git grep -n -F "'(detached)'" -- 'app/src' ':!*.test.*' ':!*nodetest*')
else hits=$(cd "$root" && git grep -n -F "'(detached)'" "$REF" -- 'app/src' ':!*.test.*' ':!*nodetest*'); fi
echo "$hits"
other=$(printf '%s\n' "$hits" | grep -v '^$' | grep -v 'app/src/main/git-status.ts' | wc -l | tr -d ' ')
echo "예외(git-status.ts) 밖: $other"
exit "$other"
