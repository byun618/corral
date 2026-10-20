#!/bin/zsh
# LIFE-604 최종 관문 — dmg **빌드만**(창 회차·기동은 묶음 테스트 이관). scripts/release-dmg.sh 의 빌드 순서를 그대로 따른다:
#   npm ci → CORRAL_BACKEND_PROFILE=release build-terminal-backend.sh(격리 build root) → npm run package:mac   (T3 인계: package:mac 단독은 build root 없이 실패)
# release-dmg.sh 를 직접 부르지 않는 이유: 그 가드가 HEAD = 원격 출고 태그를 요구한다(구현 브랜치에는 태그가 없다). 가드 밖의 빌드 단계는 같다.
# 설치·복사·실행 단계는 없다 — release-dmg.sh 에도 설치 단계는 없고 `--out` 복사만 있다(쓰지 않음). /Applications/corral.app 를 건드리지 않는다(전후 해시로 확인).
#   app/ 에서: scripts/l604/dmg-build.sh <OUT>   → OUT/{npm-ci,backend,package}.txt·.code · OUT/artifact.txt(경로·크기·sha256) · OUT/installed-*.txt
set -u
OUT=${1:A}; mkdir -p $OUT
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
cd "$(dirname $0)/../.."
APP=$PWD
INSTALLED=/Applications/corral.app/Contents/Info.plist
inst() { print -r -- "$(stat -f '%m %z' $INSTALLED) $(shasum -a 256 $INSTALLED | cut -c1-16) $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' $INSTALLED)"; }
inst > $OUT/installed-before.txt
git rev-parse --short HEAD > $OUT/head.txt
node -p 'process.versions.node' > $OUT/node.txt
npm ci > $OUT/npm-ci.txt 2>&1; echo $? > $OUT/npm-ci.code
[[ $(cat $OUT/npm-ci.code) == 0 ]] || { echo "npm ci 실패"; exit 1; }
export CORRAL_BACKEND_BUILD_ROOT=/tmp/l604f-rel
export CORRAL_BACKEND_TOOLCHAIN_ROOT=${CORRAL_BACKEND_TOOLCHAIN_ROOT:-$(git rev-parse --git-common-dir)/corral-herdr-dev/toolchain}
print -r -- "build root $CORRAL_BACKEND_BUILD_ROOT · toolchain $CORRAL_BACKEND_TOOLCHAIN_ROOT" > $OUT/backend.txt
CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh >> $OUT/backend.txt 2>&1; echo $? > $OUT/backend.code
[[ $(cat $OUT/backend.code) == 0 ]] || { echo "herdr release 빌드 실패"; exit 1; }
npm run package:mac > $OUT/package.txt 2>&1; echo $? > $OUT/package.code
[[ $(cat $OUT/package.code) == 0 ]] || { echo "package:mac 실패"; exit 1; }
VERSION=$(node -p 'require("./package.json").version')
DMG=$APP/dist/corral-$VERSION-arm64.dmg
[[ -f $DMG ]] || { echo "산출물 없음: $DMG"; exit 1; }
print -r -- "$DMG size $(wc -c < $DMG | tr -d ' ') sha256 $(shasum -a 256 $DMG | cut -d' ' -f1)" > $OUT/artifact.txt
inst > $OUT/installed-after.txt
cmp -s $OUT/installed-before.txt $OUT/installed-after.txt || { echo "설치본 Info.plist 가 바뀌었다"; exit 1; }
git status --porcelain -- . > $OUT/porcelain-after.txt
cat $OUT/artifact.txt
