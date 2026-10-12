#!/usr/bin/env bash
# release-apk.sh [--tag-prefix v] [--out <폴더>] [--check-only | --preflight]
# release-apk.sh --from-tag <태그> --tag-prefix <접두> [--out <폴더>]   ← 태그 push 뒤 APK 만 다시(release.sh 실패 안내가 출력하는 명령)
# 출고 APK 빌드 (LIFE-599) — release-dmg.sh 와 같은 가드: 이 스크립트가 든 체크아웃의 HEAD 가 정확히 태그 <접두>X.Y.Z 이고
# 트리가 깨끗하며 X.Y.Z = app/package.json 버전이고 원격 태그가 같은 커밋일 때만 빌드한다. 가드는 npm ci·eas 보다 먼저 걸린다.
# 빌드는 mobile/ 의 preview 프로필 로컬 빌드(eas build --local, EAS 쿼터 소모 없음, 서명 = EAS 원격 자격증명).
# versionName = app/package.json 버전(mobile/app.config.ts 가 읽는다) — 태그 버전과 같다. versionCode 는 EAS remote 그대로.
#   --out        APK 를 둘 폴더. 없으면 app/dist/release/<태그>/ (git 무시)
#   --check-only 가드 + 툴체인 전제만 보고 빌드하지 않는다
#   --preflight  툴체인 전제만 본다(태그 가드 없음) — release.sh 가 머지 전에 부른다
#   --from-tag   어느 checkout 에서든: 원격에서 그 태그를 정확히 fetch → 새 임시 worktree(.claude/worktrees/_apk-*)에 태그를 풀고
#                그 트리의 release-apk.sh 로 빌드 → worktree 정리. 앞선 시도가 남긴 worktree·산출물이 있어도 다시 돈다
#                (worktree 는 매번 새 경로, 산출물 자리에 이미 APK 가 있으면 지우지 않고 그 아래 retry-<시각>/ 에 만든다)
# 작업 폴더는 셸 TMPDIR 에 맡기지 않는다 — macOS /tmp(→ /private/tmp 심링크) 아래에서 CMake·ninja 가 논리·실경로를 섞어
# libworklets.so 를 못 찾는 실패가 있었다(LIFE-594 회차 1·2, reanimated #9151). 실경로(pwd -P) 작업 폴더를 만들어
# EAS_LOCAL_BUILD_WORKINGDIR·TMPDIR 로 준다. 기본 위치는 사용자 임시 폴더(getconf DARWIN_USER_TEMP_DIR), 바꾸려면 CORRAL_APK_WORK_BASE(절대경로).
# EAS 의 작업 폴더 자동 정리는 끈다(EAS_LOCAL_BUILD_SKIP_CLEANUP=1) — 성공하면 이 스크립트가 지우고, 실패하면 원인을 보도록 남긴다.
# 보통 scripts/release.sh 가 태그 push 뒤 임시 worktree 에서 부른다. 손으로 돌릴 때는 태그를 체크아웃한 깨끗한 트리에서.
set -euo pipefail

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

PROFILE="preview"
PACKAGE="io.github.byun618.corral.mobile"
# EAS 원격 자격증명 서명(공개 인증서 지문 — 비밀 아님). 폰 설치본과 같아야 adb install -r 이 된다
RELEASE_CERT_SHA256="483a15fa12070225b63bd159ac1ef25c862e23680f7e64d7918faba5501a617a"

PREFIX="v"; OUT=""; MODE="build"; FROM_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --out) OUT="${2:?--out 값 없음}"; shift 2 ;;
    --check-only) MODE="check"; shift ;;
    --preflight) MODE="preflight"; shift ;;
    --from-tag) MODE="from-tag"; FROM_TAG="${2:?--from-tag 값 없음}"; shift 2 ;;
    *) die "모르는 인자: $1" ;;
  esac
done
# --out 은 부른 곳 기준 — 아래에서 cd 하므로 절대경로로 바꿔 둔다(만들지는 않는다)
case "$OUT" in ""|/*) ;; *) OUT="$PWD/$OUT" ;; esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --from-tag — 태그 push 뒤 APK 만 다시. 레포 = 이 스크립트가 든 checkout 의 git 공통 디렉터리(release.sh 와 같다)
if [ "$MODE" = "from-tag" ]; then
  case "$FROM_TAG" in "$PREFIX"[0-9]*) ;; *) die "--from-tag '$FROM_TAG' 가 접두 '$PREFIX' 로 시작하지 않는다 — --tag-prefix 를 함께 준다" ;; esac
  COMMON="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)" || die "git 레포 안의 스크립트로 실행한다"
  REPO="$(dirname "$COMMON")"
  # 정확한 태그만 가져온다 — 로컬에 없어도 된다. 로컬 태그가 원격과 다르면 git 이 거절한다(덮어쓰지 않는다)
  git -C "$REPO" fetch -q origin "refs/tags/$FROM_TAG:refs/tags/$FROM_TAG" || die "원격 태그 $FROM_TAG 를 가져오지 못했다(없거나 로컬 태그가 다른 커밋)"
  OUT="${OUT:-$REPO/app/dist/release/$FROM_TAG}"
  # 매번 새 worktree — 앞선 시도가 남긴 _apk-* 와 겹치지 않는다
  FT_WT="$REPO/.claude/worktrees/_apk-$FROM_TAG-$(date +%Y%m%d-%H%M%S)-$$"
  [ ! -e "$FT_WT" ] || die "임시 worktree 자리가 이미 있다: $FT_WT"
  git -C "$REPO" worktree add -q --detach "$FT_WT" "refs/tags/$FROM_TAG" || die "임시 worktree 를 만들지 못했다: $FT_WT"
  ft_cleanup() { git -C "$REPO" worktree remove --force "$FT_WT" >/dev/null 2>&1 || true; git -C "$REPO" worktree prune; }
  trap ft_cleanup EXIT
  note "태그 $FROM_TAG → 임시 worktree $FT_WT (끝나면 지운다)"
  [ -x "$FT_WT/scripts/release-apk.sh" ] || die "태그 $FROM_TAG 에 scripts/release-apk.sh 가 없다 — 이 태그는 APK 출고 전 버전이다"
  "$FT_WT/scripts/release-apk.sh" --tag-prefix "$PREFIX" --out "$OUT"
  exit $?
fi
cd "$ROOT"

# 툴체인 전제 — JDK · Android SDK(apksigner·aapt2) · eas 로그인 · node · 작업 폴더. 출력: 통과 요약, 실패면 die
BUILD_TOOLS=""; WORK_BASE=""
# 서명자 SHA-256 — apksigner verify 가 성공하고 서명자가 정확히 1개일 때만 그 값. 아니면 die(출고 정책 = EAS 단일 키)
single_signer() {
  local out n
  out="$("$BUILD_TOOLS/apksigner" verify --print-certs "$1" 2>&1)" || die "apksigner verify 실패($1): ${out##*$'\n'}"
  n="$(printf '%s\n' "$out" | grep -c '^Signer #[0-9]* certificate SHA-256 digest: ' || true)"
  [ "$n" = 1 ] || die "서명자가 $n 개다($1) — 출고 APK 는 EAS 키 하나로만 서명된다"
  printf '%s\n' "$out" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p'
}
check_toolchain() {
  local jv java_bin who base
  # JDK — JAVA_HOME 이 있으면 그 java, 없으면 PATH 의 java. /usr/libexec/java_home 은 sdkman 설치 JDK 를 못 찾으므로 보지 않는다
  # 경로 환경변수는 절대경로만 — 상대경로는 사전 점검(본체 cwd)과 태그 worktree 빌드에서 다른 곳을 가리킨다
  local v
  for v in JAVA_HOME ANDROID_HOME CORRAL_APK_WORK_BASE; do
    case "${!v:-/}" in /*) ;; *) die "$v='${!v}' 가 상대경로다 — 절대경로로 준다(사전 점검과 태그 worktree 빌드가 같은 곳을 봐야 한다)" ;; esac
  done
  if [ -n "${JAVA_HOME:-}" ]; then
    java_bin="$JAVA_HOME/bin/java"
    [ -x "$java_bin" ] || die "JAVA_HOME($JAVA_HOME)에 bin/java 가 없다 — APK 빌드에 JDK 17 이 필요하다"
  else
    java_bin="$(command -v java)" || die "java 가 없다(JAVA_HOME 도 없음) — APK 빌드에 JDK 17 이 필요하다"
  fi
  # java 가 실패해도(/usr/bin/java 껍데기는 JDK 를 못 찾으면 exit 1) pipefail 로 조용히 끝나지 않게 출력만 받는다
  jv="$("$java_bin" -version 2>&1 || true)"
  jv="$(echo "$jv" | sed -n '/version "/{s/.*version "\([0-9][0-9]*\).*/\1/p;q;}')"
  [ -n "$jv" ] || die "java -version 이 실패했다($java_bin) — JDK 를 설치하거나 JAVA_HOME 을 준다"
  [ "$jv" -ge 17 ] || die "JDK $jv — APK 빌드는 JDK 17 이상"
  # Android SDK — 서명·버전 확인에 build-tools 의 apksigner·aapt2 를 쓴다
  [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME" ] || die "ANDROID_HOME 이 없거나 폴더가 아니다(${ANDROID_HOME:-미설정}) — Android SDK 경로를 준다"
  BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$BUILD_TOOLS" ] && [ -x "$BUILD_TOOLS/apksigner" ] && [ -x "$BUILD_TOOLS/aapt2" ] \
    || die "ANDROID_HOME/build-tools 에 apksigner·aapt2 가 없다($ANDROID_HOME) — sdkmanager 로 build-tools 를 설치한다"
  # node — eas-cli·mobile npm ci 용. release-dmg.sh 와 같은 기준
  NODE_V="$(node -p 'process.versions.node' 2>/dev/null)" || die "node 가 없다"
  case "$NODE_V" in
    24.*) ;;
    22.*) echo "⚠ node $NODE_V — 로컬 관문 기준은 v24 다(경고만)" >&2 ;;
    *) die "node $NODE_V — engines(>=22.12)·로컬 관문(v24) 밖. v24 를 PATH 앞에 두고 다시" ;;
  esac
  # eas 로그인 — 로컬 빌드도 원격 자격증명(keystore)을 내려받는다. 계정 이름만 출력한다
  command -v eas >/dev/null || die "eas 가 없다 — npm i -g eas-cli"
  who="$(eas whoami 2>/dev/null)" && who="${who%%$'\n'*}" && [ -n "$who" ] || die "eas whoami 실패 — eas login(또는 EXPO_TOKEN) 뒤 다시"
  # 작업 폴더 — 셸 TMPDIR 대신 실경로. 공백이 있으면 CMake·gradle 이 깨지므로 거절한다
  base="${CORRAL_APK_WORK_BASE:-$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)}"
  [ -n "$base" ] && [ -d "$base" ] && [ -w "$base" ] || die "APK 작업 폴더 자리 '${base:-없음}' 가 없거나 쓸 수 없다(CORRAL_APK_WORK_BASE 확인)"
  WORK_BASE="$(cd "$base" && pwd -P)"
  case "$WORK_BASE" in *" "*) die "APK 작업 폴더 자리 '$WORK_BASE' 에 공백이 있다 — CORRAL_APK_WORK_BASE 로 공백 없는 경로를 준다" ;; esac
  note "APK 전제 통과: JDK $jv ($java_bin) · build-tools $(basename "$BUILD_TOOLS") · eas $who · node $NODE_V · 작업 폴더 자리 $WORK_BASE (셸 TMPDIR '${TMPDIR:-없음}' 는 빌드에 쓰지 않는다)"
}

if [ "$MODE" = "preflight" ]; then
  check_toolchain
  echo "✔ --preflight — 태그 가드는 빌드 때 본다"
  exit 0
fi

# 가드 — 깨끗한 트리, HEAD = 태그, 태그 버전 = package.json 버전, 원격 태그 같은 커밋. npm ci·eas 보다 먼저
[ -z "$(git status --porcelain)" ] || die "트리가 깨끗하지 않다 — 출고 APK 는 태그 위 깨끗한 트리에서만 만든다"
TAG="$(git describe --exact-match --tags --match "${PREFIX}[0-9]*" HEAD 2>/dev/null)" \
  || die "HEAD($(git rev-parse --short HEAD))가 '$PREFIX<버전>' 태그가 아니다 — 출고 APK 는 태그 위에서만 만든다"
VERSION="${TAG#"$PREFIX"}"
PKG="$(sed -n 's/^  "version": "\([0-9.]*\)",$/\1/p' app/package.json | head -1)"
[ "$VERSION" = "$PKG" ] || die "태그 $TAG 의 버전 $VERSION 과 app/package.json 버전 $PKG 이 다르다"
# 주석 태그는 "<태그^{}>" 줄이 가리키는 커밋, 가벼운 태그는 그 줄 자체 (release-dmg.sh 와 같다)
REMOTE_PEELED="$(git ls-remote --tags origin | awk -v t="refs/tags/$TAG" '$2 == t "^{}" {p = $1} $2 == t {l = $1} END {print (p != "" ? p : l)}')"
[ "$REMOTE_PEELED" = "$(git rev-parse HEAD)" ] || die "원격 태그 $TAG 가 없거나 HEAD 와 다른 커밋이다(원격 '${REMOTE_PEELED:-없음}') — 원격에 push 된 태그에서만 빌드한다"
check_toolchain
note "가드 통과: $TAG @ $(git rev-parse --short HEAD)(원격 태그 일치), 깨끗한 트리, 버전 $VERSION, 프로필 $PROFILE"
[ "$MODE" = "build" ] || { echo "✔ --check-only — 빌드하지 않음"; exit 0; }

OUT="${OUT:-$ROOT/app/dist/release/$TAG}"
APK="$OUT/corral-mobile-$VERSION.apk"
# 앞선 시도의 APK 는 지우지 않는다 — 그 아래 새 자리에 만든다
if [ -e "$APK" ]; then
  OUT="$OUT/retry-$(date +%Y%m%d-%H%M%S)"
  [ ! -e "$OUT" ] || die "재시도 자리가 이미 있다: $OUT — 잠시 뒤 다시"
  note "산출물 자리에 이미 APK 가 있어 보존하고 새 자리에 만든다: $OUT"
  APK="$OUT/corral-mobile-$VERSION.apk"
fi

# 실경로 작업 폴더 — 생성이 실패하면 빌드 전에 멈춘다. 이름에 태그를 넣지 않는다(NAME_MAX)
WORK_NEW="$(mktemp -d "$WORK_BASE/corral-apk-XXXXXX")" || die "APK 작업 폴더를 만들지 못했다($WORK_BASE) — 빌드하지 않는다"
[ -n "$WORK_NEW" ] && [ -d "$WORK_NEW" ] || die "APK 작업 폴더 생성 결과가 비었다 — 빌드하지 않는다"
WORK="$(cd "$WORK_NEW" && pwd -P)" || die "APK 작업 폴더 실경로를 못 구했다: $WORK_NEW"
# 이번 호출이 만든 폴더인지 — WORK_BASE 바로 아래, 기대 접두. 정리(rm -rf)는 이 확인을 다시 거친다
is_own_work() { case "$1" in "$WORK_BASE"/corral-apk-??????) [ -d "$1" ] ;; *) false ;; esac; }
is_own_work "$WORK" || die "APK 작업 폴더가 기대 자리가 아니다: $WORK (자리 $WORK_BASE) — 빌드하지 않는다"
mkdir -p "$WORK/tmp" "$WORK/build"
note "작업 폴더: $WORK (실패하면 남긴다)"

cd mobile
npm ci
# 비대화형 — 프롬프트가 필요한 상황(로그인 만료·자격증명 없음)이면 기다리지 않고 실패한다
# gradle 데몬을 남기지 않는다(작업 폴더를 지운 뒤 남는 프로세스 방지)
mkdir -p "$OUT"
TMPDIR="$WORK/tmp" EAS_LOCAL_BUILD_WORKINGDIR="$WORK/build" EAS_LOCAL_BUILD_SKIP_CLEANUP=1 GRADLE_OPTS="${GRADLE_OPTS:+$GRADLE_OPTS }-Dorg.gradle.daemon=false" CI=1 \
  eas build -p android --profile "$PROFILE" --local --non-interactive --output "$APK" \
  || die "eas 로컬 빌드 실패 — 작업 폴더를 남겼다: $WORK"
cd "$ROOT"

[ -f "$APK" ] || die "산출물 없음: $APK (작업 폴더 $WORK)"
[ -z "$(git status --porcelain)" ] || die "빌드가 추적 파일을 바꿨다 — 산출물을 쓰지 말고 원인을 본다: $(git status --porcelain | head -5 | tr '\n' ' ')"

# 산출물 확인 — 패키지·versionName·서명
# head 로 자르면 aapt2 가 SIGPIPE 로 끝나 pipefail 에 걸린다 — 전부 받은 뒤 첫 줄만
BADGING="$("$BUILD_TOOLS/aapt2" dump badging "$APK")" || die "aapt2 dump badging 실패: $APK"; BADGING="${BADGING%%$'\n'*}"
GOT_PKG="$(echo "$BADGING" | sed -n "s/.*package: name='\([^']*\)'.*/\1/p")"
GOT_VNAME="$(echo "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
GOT_VCODE="$(echo "$BADGING" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
CERT="$(single_signer "$APK")" || exit 1
[ "$GOT_PKG" = "$PACKAGE" ] || die "패키지가 $GOT_PKG — $PACKAGE 여야 한다($APK)"
[ "$GOT_VNAME" = "$VERSION" ] || die "versionName 이 $GOT_VNAME — 태그 버전 $VERSION 이어야 한다($APK)"
[ "$CERT" = "$RELEASE_CERT_SHA256" ] || die "서명 SHA-256 이 ${CERT:-없음} — EAS 원격 자격증명($RELEASE_CERT_SHA256)이 아니다. 폰에 덮어 설치할 수 없다($APK)"
# 성공 — 이번 호출이 만든 작업 폴더만 지운다
if is_own_work "$WORK"; then rm -rf "$WORK"; else note "⚠ 작업 폴더 $WORK 가 기대 자리가 아니라 지우지 않았다"; fi

echo "✔ $TAG apk: $APK"
echo "  sha256 $(shasum -a 256 "$APK" | cut -d' ' -f1)  size $(wc -c < "$APK" | tr -d ' ') bytes"
echo "  package $GOT_PKG  versionName $GOT_VNAME  versionCode $GOT_VCODE  signer SHA-256 $CERT"
