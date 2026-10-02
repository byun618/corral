#!/bin/zsh
export PATH=/Users/byun/.nvm/versions/node/v24.14.1/bin:$PATH
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-445-worktree-refresh-claude/app
echo "HEAD $(git rev-parse HEAD) · dirty $(git status --porcelain | wc -l)"
case $1 in
  typecheck) npm run typecheck ;;
  test) mkdir -p /tmp/l445t && TMPDIR=/tmp/l445t npx vitest run ;;
  build) npm run build ;;
  lint) npx eslint . ; c=$?; echo "lint-exit=$c"; exit 0 ;;
esac
