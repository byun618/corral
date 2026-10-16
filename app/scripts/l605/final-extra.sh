#!/bin/zsh
# LIFE-605 최종 관문 보충(창 없는 부분) — final.sh 가 덮지 않는 C12·C13 행. app/ 에서: scripts/l605/final-extra.sh <OUT>
# C12: renderer-source-branch(+자기시험) · 「Jira 숨김(T6)」 단언 뒤집기(q-entry·final-c11 — 격리 앱을 띄우는 스크립트라 **돌리지 않고** 단언 글을 대조, 기준 commit 사본이 옛 단언임을 양성 대조) · 두 파일 문법.
# C13: data-* 존재(기준 대조 + 양성 대조) · 토큰 두 파일 기준 대비 변경 0 · 이 작업이 더한 CSS 의 var(--…) 가 앱 토큰 파일에 정의됨(새 토큰 0) · app-screens.md 갱신(기준 대비 diff 있음).
set -u
OUT=${1:A}; mkdir -p $OUT
print -r -- 'fail incomplete' > $OUT/ALL
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
BASE_COMMIT=af6d8d068
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
: > $OUT/VERDICT
failed=0
source scripts/l605/judge.zsh
run fx-source-branch 0 node scripts/l600/renderer-source-branch.mjs
run fx-st-source-branch 0 node scripts/l600/renderer-source-branch.mjs --self-test
# 새 단언 글이 있고 옛 단언(「jira 숨김(T6)」·`!…addJira`)이 없어야 0. 세 grep 을 모두 돌려 찾은 줄을 출력에 남긴다(양성 대조가 옛 단언 줄을 보인다).
t6() { grep -nF "$2" $1; local new=$?; grep -nF 'jira 숨김(T6)' $1; local old=$?; grep -nF '!dom.empty.addJira' $1; local neg=$?; [[ $new == 0 && $old != 0 && $neg != 0 ]]; }
run_grep fx-t6-flip-q-entry 0 'LIFE-605 뒤집음' t6 scripts/l600/q-entry.mjs 'jira 있음(LIFE-605 뒤집음)'
run_grep fx-t6-flip-final-c11 0 'LIFE-605 뒤집음' t6 scripts/l600/final-c11.mjs 'add=jira·form·card·error·space-row·repo-default 존재(LIFE-605 뒤집음)'
git show ${BASE_COMMIT}:app/scripts/l600/q-entry.mjs > $OUT/base-q-entry.mjs
run_grep fx-pc-t6-base 1 'jira 숨김(T6)' t6 $OUT/base-q-entry.mjs 'jira 있음(LIFE-605 뒤집음)'
run fx-syntax-t6 0 node --check scripts/l600/q-entry.mjs scripts/l600/final-c11.mjs
run fx-data-attrs 0 node scripts/l605/check-data-attrs.mjs --base $BASE_COMMIT
run_grep fx-pc-data-attrs-base 1 'BASE data-connection-account ' node scripts/l605/check-data-attrs.mjs --base HEAD
run fx-tokens-unchanged 0 git diff --exit-code --stat $BASE_COMMIT HEAD -- ../specs/design-tokens.css src/renderer/src/design-tokens.css
newvars() { git diff -U0 $BASE_COMMIT HEAD -- 'src/renderer/**/*.css' | grep '^+[^+]' | grep -oE 'var\(--[a-z0-9-]+' | sed 's/var(//' | sort -u > $OUT/used-vars.txt
  grep -oE -- '--[a-z0-9-]+:' src/renderer/src/design-tokens.css | tr -d ':' | sort -u > $OUT/defined-vars.txt
  print -r -- "쓴 변수 $(grep -c '' $OUT/used-vars.txt)개"; comm -23 $OUT/used-vars.txt $OUT/defined-vars.txt | sed 's/^/정의 없음 /'; [[ -z $(comm -23 $OUT/used-vars.txt $OUT/defined-vars.txt) ]]; }
run fx-css-vars-defined 0 newvars
run fx-app-screens-updated 1 git diff --quiet $BASE_COMMIT HEAD -- ../specs/app-screens.md
python3 -I scripts/l605/scrub-raw.py $OUT > $OUT/scrub.txt
judge_close 11
