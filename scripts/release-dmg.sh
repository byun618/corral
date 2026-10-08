#!/usr/bin/env bash
# release-dmg.sh [--tag-prefix v] [--out <폴더>] [--check-only]
# 출고 dmg 빌드 (LIFE-574 D6) — 이 스크립트가 든 체크아웃의 HEAD 가 정확히 태그 <접두>X.Y.Z 이고
# 트리가 깨끗하며 X.Y.Z = app/package.json 버전일 때만 빌드한다. 그래야 설치본 버전 = 태그 = 커밋이 성립한다.
# 빌드 경로는 app/INSTALL.md 「빌드」 그대로(npm ci → 동봉 herdr release 빌드 → npm run package:mac).
#   --out        산출물(dmg·zip)을 복사할 폴더. 없으면 app/dist/ 에만 둔다
#   --check-only 가드만 보고 빌드하지 않는다(리허설·사전 점검)
# 보통 scripts/release.sh 가 태그 push 뒤 임시 worktree 에서 부른다. 손으로 돌릴 때는 태그를 체크아웃한 깨끗한 트리에서.
set -euo pipefail

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

PREFIX="v"; OUT=""; CHECK_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --out) OUT="${2:?--out 값 없음}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    *) die "모르는 인자: $1" ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 가드 — 깨끗한 트리, HEAD = 태그, 태그 버전 = package.json 버전
[ -z "$(git status --porcelain)" ] || die "트리가 깨끗하지 않다 — 출고 dmg 는 태그 위 깨끗한 트리에서만 만든다"
TAG="$(git describe --exact-match --tags --match "${PREFIX}[0-9]*" HEAD 2>/dev/null)" \
  || die "HEAD($(git rev-parse --short HEAD))가 '$PREFIX<버전>' 태그가 아니다 — 출고 dmg 는 태그 위에서만 만든다"
VERSION="${TAG#"$PREFIX"}"
PKG="$(sed -n 's/^  "version": "\([0-9.]*\)",$/\1/p' app/package.json | head -1)"
[ "$VERSION" = "$PKG" ] || die "태그 $TAG 의 버전 $VERSION 과 app/package.json 버전 $PKG 이 다르다"
[ "$(uname -sm)" = "Darwin arm64" ] || die "arm64 macOS 에서만 빌드한다 (지금 $(uname -sm))"
note "가드 통과: $TAG @ $(git rev-parse --short HEAD), 깨끗한 트리, 버전 $VERSION"
[ "$CHECK_ONLY" = 0 ] || { echo "✔ --check-only — 빌드하지 않음"; exit 0; }

# 빌드 — app/INSTALL.md 「빌드」와 같은 경로
cd app
npm ci
export CORRAL_BACKEND_BUILD_ROOT="${CORRAL_BACKEND_BUILD_ROOT:-$(mktemp -d /tmp/corral-herdr-release-XXXXXX)}"
note "herdr build root: $CORRAL_BACKEND_BUILD_ROOT"
CORRAL_BACKEND_PROFILE=release sh scripts/build-terminal-backend.sh
npm run package:mac
cd "$ROOT"

DMG="app/dist/corral-$VERSION-arm64.dmg"
ZIP="app/dist/corral-$VERSION-arm64-mac.zip"
[ -f "$DMG" ] || die "산출물 없음: $DMG"
[ -z "$(git status --porcelain)" ] || die "빌드가 추적 파일을 바꿨다 — 산출물을 쓰지 말고 원인을 본다: $(git status --porcelain | head -5 | tr '\n' ' ')"
if [ -n "$OUT" ]; then
  mkdir -p "$OUT"
  cp "$DMG" "$OUT/"; [ -f "$ZIP" ] && cp "$ZIP" "$OUT/"
  DMG="$OUT/$(basename "$DMG")"
fi
echo "✔ $TAG dmg: $DMG"
echo "  sha256 $(shasum -a 256 "$DMG" | cut -d' ' -f1)  size $(wc -c < "$DMG" | tr -d ' ') bytes"
