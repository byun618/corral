#!/bin/zsh
# LIFE-689 g1 K4 — dmg 빌드만(설치·실행 안 함). l691/dmg.sh 에서 옮김 — **단계 실패를 프로세스 종료코드로 올린다**(r1 리뷰: 원본은 마지막 echo 가 exit 0 을 만든다).
# 빌드 순서 = scripts/release-dmg.sh 그대로(태그·트리·원격 가드만 뺀 dev 빌드):
#   npm ci → CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh → npm run package:mac
# 산출 dmg 경로·sha256 을 로그 끝에 적는다. 첫 실패 단계에서 멈추고 그 단계 이름과 exit 를 남긴 뒤 1 로 끝난다.
# 사용(app/ 에서): zsh scripts/l689/dmg.sh <로그 파일>
set -u
log=$1
app=${0:A:h:h:h}
cd $app
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l689w
mkdir -p $TMPDIR
step() {  # step <이름> <명령...> — 출력 꼬리만 로그에, 파이프 첫 명령의 exit 를 센다
  local name=$1; shift
  "$@" > $TMPDIR/dmg-$name.out 2>&1
  local code=$?
  tail -25 $TMPDIR/dmg-$name.out
  echo "# $name exit $code"
  return $code
}
run() {
  echo "# g1-dmg · HEAD $(git rev-parse --short HEAD) · porcelain $(git status --porcelain | wc -l | tr -d ' ')줄 · $(date -u +%FT%TZ) · node $(node -v)"
  step npm-ci npm ci || return 1
  export CORRAL_BACKEND_BUILD_ROOT=$(mktemp -d /tmp/l689w/corral-herdr-release-XXXXXX)
  echo "· herdr build root: $CORRAL_BACKEND_BUILD_ROOT"
  CORRAL_BACKEND_PROFILE=release step build-terminal-backend sh scripts/build-terminal-backend.sh || return 1
  step package-mac npm run package:mac || return 1
  local version=$(node -p 'require("./package.json").version')
  local dmg=$app/dist/corral-$version-arm64.dmg
  [[ -f $dmg ]] || { echo "# dmg 없음 $dmg"; return 1; }
  echo "dmg=$dmg"
  echo "bytes=$(stat -f %z $dmg) mtime=$(stat -f %Sm -t %FT%T $dmg)"
  echo "sha256=$(shasum -a 256 $dmg | cut -d' ' -f1)"
  return 0
}
run > $log 2>&1
code=$?
echo "# $(date -u +%FT%TZ) 끝 · exit $code" >> $log
exit $code
