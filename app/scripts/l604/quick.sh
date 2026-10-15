#!/bin/zsh
# LIFE-604 빠른 관문 — 실행마다 출력·종료코드를 OUT 아래 파일로 남긴다(명시 실행 목록의 원자료). app/ 에서: scripts/l604/quick.sh <OUT>
set -u
OUT=$1; mkdir -p $OUT
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l604t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
run() { local id=$1; shift; "$@" > $OUT/$id.txt 2>&1; echo $? > $OUT/$id.code; echo "$id exit $(cat $OUT/$id.code)"; }
run typecheck npm run typecheck
run boundary npm run check:boundary
run lint npm run lint
run lint-touched npx eslint src/shared/work.ts src/main/work src/renderer/src/quick-create-model.ts src/renderer/src/quick-create-model.test.ts src/renderer/src/hooks/useQuickCreate.ts src/renderer/src/hooks/useTasksPage.ts src/renderer/src/components/QuickCreate.tsx src/renderer/src/components/TasksPage.tsx src/renderer/src/components/TasksViews.tsx src/renderer/src/components/TasksPage.create.test.tsx src/renderer/src/components/TasksPage.start.test.tsx src/renderer/src/components/TasksPage.test.tsx src/renderer/src/tasks-model.ts src/renderer/src/task-detail-model.ts scripts/l604
run test npm test
run nodetest node scripts/run-nodetest.mjs
run create-main npx vitest run src/main/work/create.test.ts src/main/work/mock-source.contract.test.ts src/main/work/la-source.contract.test.ts src/main/work/activity-store.test.ts src/main/work/contract-e123.test.ts
L604_BREAK=create-fields run pc-create-fields npx vitest run src/main/work/la-source.contract.test.ts
run create-renderer npx vitest run src/renderer/src/components/TasksPage.create.test.tsx src/renderer/src/components/TasksPage.start.test.tsx src/renderer/src/quick-create-model.test.ts src/renderer/src/components/TasksPage.test.tsx src/shared/keybindings.test.ts src/renderer/src/components/ShortcutsSection.test.tsx
run data-attrs node scripts/l604/check-data-attrs.mjs
run build npm run build
echo done > $OUT/ALL
