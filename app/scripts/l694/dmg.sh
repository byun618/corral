#!/bin/zsh
# LIFE-694 최종 관문 C8 용 (l675/dmg.sh 사본, 임시 폴더만 /tmp/l694w) — dmg 빌드만(설치·실행 안 함). l691/dmg.sh 를 옮김 — scripts/release-dmg.sh 빌드 순서 그대로(태그 가드만 뺀 dev 빌드):
#   npm ci → CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh → npm run package:mac
# 단계가 하나라도 실패하면 그 자리에서 멈추고 프로세스 exit 1 (l691 은 기록만 했다).
# 사용(app/ 에서): zsh scripts/l694/dmg.sh <로그 파일>
set -u
log=$1
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l694w
mkdir -p $TMPDIR
step() {
  local name=$1; shift
  "$@" 2>&1 | tail -25
  local code=${pipestatus[1]}
  echo "# $name exit $code"
  return $code
}
{
  echo "# uptime $(uptime)"
  echo "# l694-c8-dmg · HEAD $(git rev-parse --short HEAD) · porcelain $(git status --porcelain | wc -l | tr -d ' ')줄 · $(date -u +%FT%TZ) · node $(node -v)"
  step "npm ci" npm ci || exit 1
  export CORRAL_BACKEND_BUILD_ROOT=$(mktemp -d /tmp/l694w/corral-herdr-release-XXXXXX)
  echo "· herdr build root: $CORRAL_BACKEND_BUILD_ROOT"
  CORRAL_BACKEND_PROFILE=release step build-terminal-backend sh scripts/build-terminal-backend.sh || exit 1
  step package:mac npm run package:mac || exit 1
  echo "## 산출 dmg"
  for f in dist/*.dmg(N); do echo "$f · $(stat -f '%z bytes · %Sm' -t %FT%T $f) · sha256 $(shasum -a 256 $f | cut -d' ' -f1)"; done
  echo "# $(date -u +%FT%TZ) 끝 · exit 0"
} > $log 2>&1
code=$?
tail -1 $log | grep -q '끝 · exit 0' || code=1
exit $code
