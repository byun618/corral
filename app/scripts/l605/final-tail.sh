#!/bin/zsh
# LIFE-605 최종 관문 dmg(빌드만) — `scripts/release-dmg.sh` 와 같은 순서(npm ci → 동봉 herdr release 빌드 → npm run package:mac). app/ 에서: scripts/l605/final-tail.sh <OUT>
# release-dmg.sh 는 HEAD 가 원격 태그일 때만 빌드한다(작업 브랜치는 아님) — 그 가드가 거절함을 한 행으로 남기고, 빌드 단계만 같은 명령으로 돌린다.
# release-dmg.sh 에는 설치·실행 단계가 없다(--out 복사만 — 쓰지 않음). **기동하지 않는다 · /Applications/corral.app 을 바꾸지 않는다** — 앞뒤 stat 대조 행.
set -u
OUT=${1:A}; mkdir -p $OUT
print -r -- 'fail incomplete' > $OUT/ALL
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
git rev-parse --short HEAD > $OUT/head.txt
: > $OUT/VERDICT
failed=0
source scripts/l605/judge.zsh
installed() { stat -f '%m %z %N' /Applications/corral.app /Applications/corral.app/Contents/Info.plist /Applications/corral.app/Contents/MacOS/* ; shasum -a 256 /Applications/corral.app/Contents/Info.plist | cut -c1-16; }
installed > $OUT/installed-before.txt 2>&1
run_grep dmg-guard 1 '태그가 아니다' bash ../scripts/release-dmg.sh --check-only
run dmg-npm-ci 0 npm ci
HERDR_ROOT=/tmp/l605-dmg-herdr
print -r -- $HERDR_ROOT > $OUT/herdr-root.txt
CORRAL_BACKEND_BUILD_ROOT=$HERDR_ROOT CORRAL_BACKEND_PROFILE=release run dmg-backend 0 sh scripts/build-terminal-backend.sh
CORRAL_BACKEND_BUILD_ROOT=$HERDR_ROOT run dmg-package 0 npm run package:mac
VERSION=$(node -p "require('./package.json').version")
artifact() { local dmg=dist/corral-$VERSION-arm64.dmg; [[ -f $dmg ]] || { print -r -- "없음 $dmg"; return 1; }; print -r -- "path $PWD/$dmg"; print -r -- "size $(wc -c < $dmg | tr -d ' ')"; print -r -- "sha256_8 $(shasum -a 256 $dmg | cut -c1-8)"; }
run_grep dmg-artifact 0 'sha256_8 ' artifact
treeclean() { git status --porcelain -- . ; [[ -z $(git status --porcelain -- .) ]]; }
run dmg-tree-clean 0 treeclean
installed > $OUT/installed-after.txt 2>&1
run dmg-installed-untouched 0 cmp $OUT/installed-before.txt $OUT/installed-after.txt
judge_close 8
