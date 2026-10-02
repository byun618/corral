#!/bin/zsh
# LIFE-445 K9ⓐ 검사 — typecheck·test·build·lint 를 이 스크립트가 든 app/ 에서 돈다(경로는 스크립트 위치 기준).
# lint 는 eslint 종료코드를 삼키고 개수 줄(`lint-exit=`)을 남긴다 — 판정은 기준선 대비 증가 0 으로 따로 본다.
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
cd "${0:A:h}/../.." || exit 2
echo "HEAD $(git rev-parse HEAD) · dirty $(git status --porcelain | wc -l)"
case $1 in
  typecheck) npm run typecheck ;;
  test) mkdir -p /tmp/l445t && TMPDIR=/tmp/l445t npx vitest run ;;
  build) npm run build ;;
  lint) npx eslint . ; c=$?; echo "lint-exit=$c"; exit 0 ;;
esac
