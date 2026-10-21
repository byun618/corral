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
# 태그가 원격(origin)에도 같은 커밋으로 있어야 출고본이다 — 로컬에만 있는 태그(push 실패 잔재·손 태그)로 만든 dmg 는 설치본 버전 = 원격 태그가 깨진다
# 주석 태그는 "<태그^{}>" 줄이 가리키는 커밋, 가벼운 태그는 그 줄 자체
REMOTE_PEELED="$(git ls-remote --tags origin | awk -v t="refs/tags/$TAG" '$2 == t "^{}" {p = $1} $2 == t {l = $1} END {print (p != "" ? p : l)}')"
[ "$REMOTE_PEELED" = "$(git rev-parse HEAD)" ] || die "원격 태그 $TAG 가 없거나 HEAD 와 다른 커밋이다(원격 '${REMOTE_PEELED:-없음}') — 원격에 push 된 태그에서만 빌드한다"
# node — engines 하한(>=22.12)·로컬 관문 기준(v24, Electron 44 내장 node 도 24 계열). 셸 기본 v20 이면 빌드가 엉뚱하게 깨진다
NODE_V="$(node -p 'process.versions.node' 2>/dev/null)" || die "node 가 없다"
case "$NODE_V" in
  24.*) ;;
  22.*) echo "⚠ node $NODE_V — 로컬 관문 기준은 v24 다(engines 안이라 경고만)" >&2 ;;
  *) die "node $NODE_V — engines(>=22.12)·로컬 관문(v24) 밖. v24 를 PATH 앞에 두고 다시" ;;
esac
# LIFE-676 — npm run build 가 Resource Manager 메모리 도우미(app/helper/corral-footprint.c)를 clang 으로 빌드한다(release.sh 와 같은 점검)
command -v clang >/dev/null 2>&1 || die "clang 이 없다 — 메모리 도우미 빌드에 필요. xcode-select --install 뒤 다시"
note "가드 통과: $TAG @ $(git rev-parse --short HEAD)(원격 태그 일치), 깨끗한 트리, 버전 $VERSION, node $NODE_V"
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
