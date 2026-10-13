#!/bin/zsh
# LIFE-590 수정 r1 — 회귀 시험 양성 대조: 제품 파일 하나를 수정 전(r1 대상 `4205e41e0`) 판으로 잠깐 바꿔 그 시험만 돌린다(실패해야 한다). 끝나면 반드시 되돌린다.
# 사용(app/ 에서): sh scripts/l590/old-code-control.sh <app 상대 제품 파일> <vitest 파일> <-t 이름 조각>
set -u
file=$1; test=$2; name=$3
backup=$(mktemp)
cp "$file" "$backup"
trap 'cp "$backup" "$file"; rm -f "$backup"; git diff --quiet 4205e41e0 -- "$file" && echo "# restore check: $file == old (BUG)" || echo "# restored: $file"' EXIT
git show "4205e41e0:app/$file" > "$file"
npx vitest run "$test" -t "$name"
