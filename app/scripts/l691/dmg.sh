#!/bin/zsh
# LIFE-691 g1 K4 — dmg 빌드만(설치·실행 안 함). scripts/release-dmg.sh 의 빌드 순서 그대로(태그 가드만 뺀 dev 빌드):
#   npm ci → CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh → npm run package:mac
# 사용(app/ 에서): zsh scripts/l691/dmg.sh <로그 파일>
set -u
log=$1
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l691w
{
  echo "# g-dmg · HEAD $(git rev-parse --short HEAD) · $(date -u +%FT%TZ) · node $(node -v)"
  set -o pipefail
  npm ci 2>&1 | tail -5; echo "# npm ci exit $?"
  export CORRAL_BACKEND_BUILD_ROOT=$(mktemp -d /tmp/l691w/corral-herdr-release-XXXXXX)
  echo "· herdr build root: $CORRAL_BACKEND_BUILD_ROOT"
  CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh 2>&1 | tail -8; echo "# build-terminal-backend exit $?"
  npm run package:mac 2>&1 | tail -25; echo "# package:mac exit $?"
  echo "# $(date -u +%FT%TZ) 끝"
} > $log 2>&1
