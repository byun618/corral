#!/bin/sh
# K2 양성 대조 — 같은 훅 시험을 **기준 commit(87c08227) 의 훅**으로 돌린다. 결함 경로 시험이 실패해야 시험이 결함을 잡는 것이다.
# 훅 파일을 잠시 기준본으로 바꾸고 끝나면(실패해도) 되돌린다. 종료코드 = vitest 종료코드.
set -u
root=$(git rev-parse --show-toplevel)
f="$root/app/src/renderer/src/hooks/useLifecycleActions.ts"
keep=$(mktemp /tmp/l490-hook.XXXXXX)
cp "$f" "$keep"
git -C "$root" show 87c08227:app/src/renderer/src/hooks/useLifecycleActions.ts > "$f"
( cd "$root/app" && npx vitest run src/renderer/src/hooks/useLifecycleActions.active-pending.test.mjs --reporter=verbose )
code=$?
cp "$keep" "$f"; rm -f "$keep"
git -C "$root" diff --quiet 87c08227 -- app/src/renderer/src/hooks/useLifecycleActions.ts && echo "WARN: hook equals base after restore"
exit $code
