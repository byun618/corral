#!/bin/zsh
# LIFE-605 수정 1 R1-Y — C14 「기준 commit 대비 새 실패 0」 전후 비교 틀(LIFE-604 before-after.sh 를 옮김). **수정 1 에서는 만들고 자기점검만 했다**(돌리는 것은 최종 관문).
#   app/ 에서: scripts/l605/before-after.sh <OUT 폴더>
# 1) 기준 worktree 를 .claude/worktrees/LIFE-605-base-af6d8d068 에 만든다(AGENTS.md — worktree 는 그 아래 형제 폴더만). 이미 있으면 그 HEAD 가 기준인지 확인.
#    node_modules 는 기준과 HEAD 의 package.json·package-lock.json 이 같을 때만 이 worktree 것을 심링크로 빌린다(다르면 멈춤 — npm ci 가 필요).
# 2) 같은 명령 쌍을 양쪽에서 돌린다: typecheck · check:boundary · lint · vitest(npm test 의 1단계) · nodetest. 출력 = OUT/{base,head}/<id>.txt·.code
# 3) 비교: typecheck·boundary·nodetest 는 양쪽 0 · lint 는 (파일, 규칙) 묶음이 같음 · vitest 는 FAIL 줄 집합이 같음 + HEAD 시험 수 ≥ 기준(expect-failures.mjs)
#    · 단축키 레지스트리·설정 단축키 표 파일 무변경(git diff 0줄).
# 4) 양성 대조: 기준 lint 출력에 가짜 오류 한 줄을 더한 것을 비교하면 「다름」(exit 1) 이어야 한다 — 비교기가 늘 「같음」 을 내지 않음을 보인다.
# 결과 = OUT/VERDICT(행마다 판정) · OUT/ALL(pass | fail n). 기준 worktree 는 지우지 않는다(다음 회차 재사용) — 정리는 `git worktree remove` 로 손수.
set -u
OUT=${1:A}; mkdir -p $OUT/base $OUT/head
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
HEAD_APP=$PWD
REPO=$(git rev-parse --show-toplevel)
BASE_COMMIT=af6d8d068
BASE_TREE=$REPO/../LIFE-605-base-$BASE_COMMIT
case "$REPO" in */.claude/worktrees/*) ;; *) echo "이 스크립트는 .claude/worktrees 아래 worktree 에서 돈다"; exit 2 ;; esac
if [[ ! -d $BASE_TREE ]]; then
  git worktree add --detach $BASE_TREE $BASE_COMMIT > $OUT/worktree-add.txt 2>&1 || { echo "기준 worktree 만들기 실패"; exit 2; }
fi
[[ $(git -C $BASE_TREE rev-parse --short=9 HEAD) == $BASE_COMMIT ]] || { echo "기준 worktree HEAD 가 $BASE_COMMIT 가 아니다"; exit 2; }
if ! git diff --quiet $BASE_COMMIT HEAD -- app/package.json app/package-lock.json; then echo "package 파일이 다르다 — 기준 쪽 npm ci 필요"; exit 2; fi
[[ -e $BASE_TREE/app/node_modules ]] || ln -s $HEAD_APP/node_modules $BASE_TREE/app/node_modules
git rev-parse --short HEAD > $OUT/head/commit.txt; echo $BASE_COMMIT > $OUT/base/commit.txt

pair() {
  local id=$1; shift
  for side in base head; do
    local dir=$([[ $side == base ]] && echo $BASE_TREE/app || echo $HEAD_APP)
    (cd $dir && "$@") > $OUT/$side/$id.txt 2>&1
    echo $? > $OUT/$side/$id.code
  done
}
pair typecheck npm run typecheck
pair boundary npm run check:boundary
pair lint npm run lint
pair vitest npx vitest run
pair nodetest node scripts/run-nodetest.mjs

: > $OUT/VERDICT
failed=0
row() { print -r -- "$1	$2	$3" >> $OUT/VERDICT; [[ $2 == pass ]] || failed=$((failed + 1)); print -r -- "$1 → $2 ($3)"; }
for id in typecheck boundary nodetest; do
  b=$(cat $OUT/base/$id.code); h=$(cat $OUT/head/$id.code)
  row $id $([[ $b == 0 && $h == 0 ]] && echo pass || echo fail) "base $b · head $h"
done
node scripts/l604/expect-failures.mjs lint $OUT/head/lint.txt $OUT/base/lint.txt > $OUT/lint-compare.txt 2>&1
row lint $([[ $? == 0 ]] && echo pass || echo fail) "$(tail -1 $OUT/lint-compare.txt)"
node scripts/l604/expect-failures.mjs vitest $OUT/head/vitest.txt $OUT/base/vitest.txt > $OUT/vitest-compare.txt 2>&1
same=$?
count() { sed 's/\x1b\[[0-9;]*m//g' $1 | sed -n 's/^ *Tests  *\([0-9]*\) passed.*/\1/p; s/^ *Tests  *[0-9]* failed | \([0-9]*\) passed.*/\1/p' | tail -1; }
bt=$(count $OUT/base/vitest.txt); ht=$(count $OUT/head/vitest.txt)
row vitest $([[ $same == 0 && -n $bt && -n $ht && $ht -ge $bt ]] && echo pass || echo fail) "FAIL 줄 $(tail -1 $OUT/vitest-compare.txt) · 통과 시험 base $bt → head $ht"
lines=$(git diff $BASE_COMMIT HEAD -- app/src/shared/keybindings.ts app/src/renderer/src/components/ShortcutsSection.tsx | wc -l | tr -d ' ')
row actions-registry $([[ $lines == 0 ]] && echo pass || echo fail) "keybindings.ts·ShortcutsSection.tsx diff ${lines}줄"
{ cat $OUT/base/lint.txt; print -r -- '/x/app/src/l605-fake.ts'; print -r -- '  1:1  error  양성 대조로 넣은 가짜 오류  no-undef'; } > $OUT/lint-extra-sample.txt
node scripts/l604/expect-failures.mjs lint $OUT/lint-extra-sample.txt $OUT/base/lint.txt > $OUT/pc-lint-compare.txt 2>&1
pc=$?
# 종료코드 + 기대 문구(가짜 오류 묶음이 「기준 0 → 이번 1」 로 잡힘) — 다른 이유의 exit 1 을 대조 통과로 읽지 않는다(R4-H 와 같은 방식).
row pc-lint-compare $([[ $pc == 1 ]] && grep -qF 'src/l605-fake.ts :: no-undef: 기준 0 → 이번 1' $OUT/pc-lint-compare.txt && echo pass || echo fail) "가짜 오류 한 줄 → 「다름」(exit 1 + 그 묶음 문구) 이어야 함"
print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
cat $OUT/ALL
