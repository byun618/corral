#!/usr/bin/env bash
# release-upload.sh --tag <태그> --dir <산출물 폴더> [--tag-prefix v] [--no-apk | --apk <APK 경로>] [--dry-run]
# 출고 산출물을 그 태그의 GitHub Release 에 올린다 (LIFE-729) — release-dmg.sh·release-apk.sh 와 같은 방식: 태그 하나 + 폴더를 입력으로 받고 가드가 먼저 걸린다.
# 올리는 것: corral-X.Y.Z-arm64.dmg · corral-mobile-X.Y.Z.apk(--no-apk 면 뺀다) · 바이너리마다 체크섬 파일 <바이너리>.sha256
#   (shasum -a 256 출력 꼴 「<hex>  <이름>」 — 받은 사람은 같은 폴더에서 shasum -a 256 -c <바이너리>.sha256). zip 은 올리지 않는다(자동 업데이트 없음).
# 체크섬 파일을 바이너리마다 따로 두는 것은 asset 을 한 번 올리면 다시 쓰지 않기 위해서다 — 나중에 APK 를 더해도 이미 올린 파일을 바꾸지 않는다.
# 멱등 — 서버 asset 의 digest(sha256:…)로 판정한다. 올리기 전에 올릴 것 전부를 먼저 본다:
#   없음 → 올린다 · 같은 이름·같은 digest → 건너뜀 · 같은 이름·다른 digest / digest 없음 / 올리기가 끝나지 않은 asset → 하나라도 있으면 아무것도 올리지 않고 거절.
#   지우거나 덮어쓰지 않는다(--clobber 는 지운 뒤 올려 실패하면 원본을 잃는다). 그런 asset 은 사람이 보고 지운 뒤 같은 명령을 다시 친다.
# 올린 뒤 서버 asset 목록을 다시 읽어 올릴 것 전부가 uploaded 이고 digest = 로컬 sha256 인지 확인한다. 도중에 실패하면 같은 명령 재실행이 빠진 것만 올린다.
#   --dry-run  가드·판정만 보고 올리지 않는다
#   --apk      올릴 APK 를 사람이 고른다 — 폴더 맨 위나 retry-<시각>/ 바로 아래의 corral-mobile-X.Y.Z.apk.
# 재시도 APK: release-apk.sh 는 APK 를 쓴 뒤에 검증하고, 맨 위에 APK 가 이미 있으면 retry-<시각>/ 에 새로 만든다 — 맨 위 APK 는 검증에서 거절된 것일 수 있다.
#   그래서 retry-*/ 에 APK 가 하나라도 있으면 --apk 없이는 아무것도 올리지 않고 후보를 보인다. 고르는 기준은 release-apk.sh 가 「✔ <태그> apk: <경로>」 로 낸 경로다.
# 보통 scripts/release.sh ship 이 dmg·APK 뒤에 부른다. 어느 cwd 에서 불러도 이 스크립트가 든 레포(gh 의 대상 레포)에서 돈다.
set -euo pipefail

die() { echo "✖ $1" >&2; exit 1; }
ROOT_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")" # 안내 명령용 이 스크립트 절대경로
note() { echo "· $1"; }
NL=$'\n'
BAD=""; addbad() { BAD="$BAD${BAD:+$NL}  $1"; }

TAG=""; DIR=""; PREFIX="v"; NO_APK=0; DRY_RUN=0; APK_PICK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag 값 없음}"; shift 2 ;;
    --dir) DIR="${2:?--dir 값 없음}"; shift 2 ;;
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --no-apk) NO_APK=1; shift ;;
    --apk) APK_PICK="${2:?--apk 값 없음}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "모르는 인자: $1" ;;
  esac
done
[ -n "$TAG" ] || die "--tag 필수"
[ -n "$DIR" ] || die "--dir 필수"
# --dir 은 부른 곳 기준 — 아래에서 cd 하므로 절대경로로
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac
case "$APK_PICK" in ""|/*) ;; *) APK_PICK="$PWD/$APK_PICK" ;; esac
[ -z "$APK_PICK" ] || [ "$NO_APK" = 0 ] || die "--apk 와 --no-apk 는 같이 줄 수 없다" # guard:up-apk-conflict
shq() { local s="$1" q="'\\''"; printf "'%s'" "${s//\'/$q}"; } # release.sh 와 같다

# 가드 — 태그 형식 · 폴더 · 파일 이름 버전 = 태그 버전 · 필요한 파일. 전부 gh 호출 전
case "$TAG" in "$PREFIX"*) ;; *) die "태그 '$TAG' 가 접두 '$PREFIX' 로 시작하지 않는다 — 리허설이면 --tag-prefix 를 함께 준다" ;; esac
VERSION="${TAG#"$PREFIX"}"
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "태그 '$TAG' 가 '$PREFIX<X.Y.Z>' 꼴이 아니다" # guard:up-tag-form
[ -d "$DIR" ] || die "산출물 폴더가 없다: $DIR"
# 폴더 이름이 태그 꼴이면 그 태그여야 한다 — 다른 출고의 폴더를 이 Release 에 올리지 않는다(release.sh 는 app/dist/release/<태그>/ 를 준다)
DB="$(basename "$DIR")"
case "$DB" in "$PREFIX"[0-9]*) [ "$DB" = "$TAG" ] || die "산출물 폴더 '$DB' 가 태그 '$TAG' 와 다르다 — 그 태그의 폴더를 준다" ;; esac # guard:up-dir-tag
DMG="corral-$VERSION-arm64.dmg"; APK="corral-mobile-$VERSION.apk"
BINS="$DMG"; [ "$NO_APK" = 1 ] || BINS="$BINS $APK"
# APK 출처 — 기본은 폴더 맨 위. retry-*/ 에 APK 가 있으면 사람이 --apk 로 고른다(맨 위가 검증 거절본일 수 있다)
APK_SRC="$DIR/$APK"
if [ "$NO_APK" = 0 ]; then
  RETRIES="$(cd "$DIR" && ls -1d retry-*/"$APK" 2>/dev/null || true)"
  if [ -n "$APK_PICK" ]; then
    [ -f "$APK_PICK" ] || die "--apk 파일이 없다: $APK_PICK"
    [ "$(basename "$APK_PICK")" = "$APK" ] || die "--apk 파일 이름이 $APK 가 아니다: $APK_PICK" # guard:up-apk-name
    PD="$(cd "$(dirname "$APK_PICK")" && pwd -P)"; DD="$(cd "$DIR" && pwd -P)"
    { [ "$PD" = "$DD" ] || { [ "$(dirname "$PD")" = "$DD" ] && case "$(basename "$PD")" in retry-*) true ;; *) false ;; esac; }; } \
      || die "--apk 는 산출물 폴더($DIR) 맨 위나 retry-<시각>/ 바로 아래여야 한다: $APK_PICK" # guard:up-apk-place
    APK_SRC="$PD/$APK"
  elif [ -n "$RETRIES" ]; then
    CANDS=""; for c in $( [ -f "$DIR/$APK" ] && echo "$APK"; echo "$RETRIES" ); do
      CANDS="$CANDS$NL  $c — sha256 $(shasum -a 256 "$DIR/$c" | cut -d' ' -f1) · $(stat -f '%Sm' -t '%F %T' "$DIR/$c")$NL$(shq "$ROOT_SELF") --tag $(shq "$TAG") --tag-prefix $(shq "$PREFIX") --dir $(shq "$DIR") --apk $(shq "$DIR/$c")"
    done
    die "재시도 APK 가 있다(retry-*/) — 맨 위 APK 는 검증에서 거절된 것일 수 있어 어느 APK 를 올릴지 정하지 않았다. 아무것도 올리지 않음.${NL}release-apk.sh 가 「✔ $TAG apk: <경로>」 로 낸 APK 를 골라 그 줄의 명령을 그대로 붙여 넣는다:$CANDS" # guard:up-retry
  fi
fi
MISSING=""
for f in $BINS; do
  if [ "$f" = "$APK" ]; then [ -f "$APK_SRC" ] || MISSING="$MISSING $f"; else [ -f "$DIR/$f" ] || MISSING="$MISSING $f"; fi
done
if [ -n "$MISSING" ]; then
  # 다른 버전의 같은 꼴 파일이 있으면 그것을 대 준다(파일 이름 버전 ≠ 태그 버전)
  OTHER="$(cd "$DIR" && ls -1 corral-*-arm64.dmg corral-mobile-*.apk 2>/dev/null | tr '\n' ' ' || true)"
  die "필요한 파일이 없다:$MISSING ($DIR)${OTHER:+ — 폴더에 있는 것: $OTHER(파일 이름 버전이 태그 버전 $VERSION 과 다르다)}$([ "$NO_APK" = 1 ] || echo " — APK 를 빼고 올리려면 --no-apk")" # guard:up-files
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/corral-upload.XXXXXX")" || die "임시 폴더를 만들지 못했다"
trap 'rm -rf "$WORK"' EXIT

# 올릴 것 목록: 이름<TAB>로컬 경로<TAB>로컬 sha256 — 체크섬 파일은 임시 폴더에 그 이름으로 만든다
PLAN=""
for f in $BINS; do
  src="$DIR/$f"; [ "$f" != "$APK" ] || src="$APK_SRC"
  h="$(shasum -a 256 "$src" | cut -d' ' -f1)"
  printf '%s  %s\n' "$h" "$f" > "$WORK/$f.sha256"
  PLAN="$PLAN$f	$src	$h
$f.sha256	$WORK/$f.sha256	$(shasum -a 256 "$WORK/$f.sha256" | cut -d' ' -f1)
"
done

# 서버 asset — 이름<TAB>state<TAB>digest(없으면 빈 칸)
gh release view "$TAG" --json tagName --jq .tagName >/dev/null 2>&1 || die "GitHub Release $TAG 가 없다(또는 조회 실패) — Release 는 release.sh ship 이 만든다. 아무것도 올리지 않음" # guard:up-release
assets() { gh api "repos/{owner}/{repo}/releases/tags/$TAG" --jq '.assets[] | "\(.name)\t\(.state)\t\(.digest // "")"'; }
SERVER="$(assets)" || die "Release $TAG 의 asset 목록을 읽지 못했다 — 아무것도 올리지 않음"

# 판정 — 하나라도 거절이면 아무것도 올리지 않는다
TODO=""
while IFS="$(printf '\t')" read -r name path h; do
  [ -n "$name" ] || continue
  line="$(printf '%s\n' "$SERVER" | awk -F'\t' -v n="$name" '$1 == n' | head -1)"
  if [ -z "$line" ]; then TODO="$TODO$name	$path
"; note "올림 예정: $name (sha256 $h)"; continue; fi
  st="$(printf '%s' "$line" | cut -f2)"; dg="$(printf '%s' "$line" | cut -f3)"
  if [ "$st" != uploaded ]; then addbad "$name: 올리기가 끝나지 않은 asset(state=$st)"; continue; fi # guard:up-state
  if [ -z "$dg" ]; then addbad "$name: 서버 digest 가 없다 — 같은 파일인지 대조할 수 없다"; continue; fi # guard:up-nodigest
  if [ "$dg" = "sha256:$h" ]; then note "건너뜀(같은 digest): $name"; continue; fi # guard:up-same
  addbad "$name: 같은 이름·다른 digest — 서버 $dg · 로컬 sha256:$h" # guard:up-mismatch
done <<P
$PLAN
P
[ -z "$BAD" ] || die "Release $TAG 에 대조가 맞지 않는 asset 이 있다 — 아무것도 올리지 않음(지우거나 덮어쓰지 않는다). 그 asset 을 직접 보고 지울지 정한 뒤 같은 명령을 다시:$NL$BAD" # guard:up-reject
if [ "$DRY_RUN" = 1 ]; then echo "✔ --dry-run — 올리지 않음(올릴 것 $(printf '%s' "$TODO" | grep -c . || true)개)"; exit 0; fi

# 올리기 — 파일마다 한 번씩, --clobber 없이(같은 이름이 그새 생겼으면 gh 가 거절한다)
while IFS="$(printf '\t')" read -r name path; do
  [ -n "$name" ] || continue
  # stdin 을 끊는다 — 이 루프는 here-doc 을 stdin 으로 읽는다. gh 가 stdin 을 읽으면 남은 목록이 사라진다
  gh release upload "$TAG" "$path" </dev/null || die "올리기 실패: $name — 앞서 올린 것은 그대로다. 같은 명령을 다시 돌리면 빠진 것만 올린다" # guard:up-upfail
  note "올림: $name"
done <<T
$TODO
T

# 확인 — 올릴 것 전부가 서버에 uploaded · digest = 로컬 sha256
SERVER="$(assets)" || die "올린 뒤 asset 목록을 읽지 못했다 — 같은 명령을 다시 돌리면 대조부터 한다"
while IFS="$(printf '\t')" read -r name path h; do
  [ -n "$name" ] || continue
  line="$(printf '%s\n' "$SERVER" | awk -F'\t' -v n="$name" '$1 == n' | head -1)"
  [ "$(printf '%s' "$line" | cut -f2)" = uploaded ] && [ "$(printf '%s' "$line" | cut -f3)" = "sha256:$h" ] \
    || die "올린 뒤 대조 실패: $name — 서버 '${line:-없음}' · 로컬 sha256:$h. Release 를 직접 본다" # guard:up-verify
done <<P
$PLAN
P
echo "✔ Release $TAG asset — 서버 digest = 로컬 sha256:"
printf '%s' "$PLAN" | while IFS="$(printf '\t')" read -r name _ h; do [ -n "$name" ] && echo "  $name  sha256 $h"; done
