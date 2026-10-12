#!/usr/bin/env bash
# release-apk-install.sh --serial <기기 시리얼> --apk <출고 APK>
# 출고 APK 를 폰에 덮어 설치한다 (LIFE-599, release 스킬 §4). 순서:
#   ① 시리얼로 기기를 고른다(기본값 없음 — 폰·에뮬레이터가 같이 붙어 있어도 엉뚱한 기기에 깔지 않는다)
#   ② 설치 전에 기기 설치본(pm path → adb pull)의 서명과 새 APK 서명을 apksigner 로 대조 — 다르면 설치하지 않고 멈춘다
#   ③ 같을 때만 adb install -r (설치본 데이터·페어링 유지)
#   ④ dumpsys 로 versionName·lastUpdateTime 이 바뀌었는지 확인하고 APK sha256 을 출력한다(출고 보고에 넣는다)
# 설치본을 지우고 새로 까는 길은 이 스크립트에 없다 — 지우면 페어링 토큰·기록이 사라진다. 서명이 다르면 사람이 판단한다.
# 설치본이 없는 기기(첫 설치)도 멈춘다 — 대조할 서명이 없다. 첫 설치는 mobile/README.md §3 대로 손으로.
set -euo pipefail

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

PACKAGE="io.github.byun618.corral.mobile"
SERIAL=""; APK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="${2:?--serial 값 없음}"; shift 2 ;;
    --apk) APK="${2:?--apk 값 없음}"; shift 2 ;;
    *) die "모르는 인자: $1" ;;
  esac
done
[ -n "$SERIAL" ] && [ -n "$APK" ] || die "사용법: release-apk-install.sh --serial <adb devices 의 시리얼> --apk <app/dist/release/<태그>/corral-mobile-X.Y.Z.apk>"
[ -f "$APK" ] || die "APK 없음: $APK"
command -v adb >/dev/null || die "adb 가 없다"
[ -n "${ANDROID_HOME:-}" ] || die "ANDROID_HOME 이 없다 — apksigner·aapt2 를 찾는다"
BUILD_TOOLS="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BUILD_TOOLS" ] && [ -x "$BUILD_TOOLS/apksigner" ] && [ -x "$BUILD_TOOLS/aapt2" ] || die "ANDROID_HOME/build-tools 에 apksigner·aapt2 가 없다"

adbs() { adb -s "$SERIAL" "$@"; }
# 서명을 못 읽으면 빈 값 — 아래 대조가 "없음" 으로 멈춘다(pipefail 로 조용히 끝나지 않게)
cert_of() { "$BUILD_TOOLS/apksigner" verify --print-certs "$1" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' || true; }
# dumpsys package 에서 한 필드(첫 값, 줄 끝까지 — lastUpdateTime 은 "날짜 시각"). 전부 받은 뒤 고른다(head 로 자르면 SIGPIPE·pipefail)
pkg_field() { local d; d="$(adbs shell dumpsys package "$PACKAGE" | tr -d '\r' | sed -n "s/^ *$1=//p")" || die "dumpsys package 실패($SERIAL)"; echo "${d%%$'\n'*}"; }

# ① 기기
[ "$(adbs get-state 2>/dev/null)" = "device" ] || die "기기 $SERIAL 이 연결돼 있지 않다(adb devices 확인)"
note "기기 $SERIAL — $(adbs shell getprop ro.product.model | tr -d '\r')"

# 새 APK — 패키지·버전·서명
BADGING="$("$BUILD_TOOLS/aapt2" dump badging "$APK")" || die "aapt2 dump badging 실패: $APK"; BADGING="${BADGING%%$'\n'*}"
NEW_PKG="$(echo "$BADGING" | sed -n "s/.*package: name='\([^']*\)'.*/\1/p")"
NEW_VNAME="$(echo "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
[ "$NEW_PKG" = "$PACKAGE" ] || die "APK 패키지가 $NEW_PKG — $PACKAGE 가 아니다"
NEW_CERT="$(cert_of "$APK")"
[ -n "$NEW_CERT" ] || die "새 APK 서명을 못 읽었다: $APK"

# ② 설치본 서명 — pm path → pull → apksigner. 설치 전에 대조한다
INSTALLED="$(adbs shell pm path "$PACKAGE" | tr -d '\r' | sed -n 's/^package://p' | grep '/base.apk$' | head -1 || true)"
[ -n "$INSTALLED" ] || die "기기 $SERIAL 에 $PACKAGE 설치본이 없다 — 대조할 서명이 없어 설치하지 않는다(첫 설치는 mobile/README.md §3)"
PULL_DIR="$(mktemp -d)"
trap 'rm -rf "$PULL_DIR"' EXIT
adbs pull "$INSTALLED" "$PULL_DIR/installed.apk" >/dev/null
OLD_CERT="$(cert_of "$PULL_DIR/installed.apk")"
note "설치본 서명 SHA-256 ${OLD_CERT:-없음} · 새 APK 서명 SHA-256 $NEW_CERT"
[ "$OLD_CERT" = "$NEW_CERT" ] || die "서명이 다르다 — 설치하지 않는다. adb install -r 은 서명이 다르면 거절되고, 지우고 까는 길은 페어링·기록을 잃는다. 사용자에게 보고하고 판단을 받는다"

BEFORE_VNAME="$(pkg_field versionName)"; BEFORE_UPDATE="$(pkg_field lastUpdateTime)"
note "설치 전: versionName $BEFORE_VNAME · lastUpdateTime $BEFORE_UPDATE"

# ③ 덮어 설치
adbs install -r "$APK"

# ④ 확인
AFTER_VNAME="$(pkg_field versionName)"; AFTER_UPDATE="$(pkg_field lastUpdateTime)"
note "설치 후: versionName $AFTER_VNAME · lastUpdateTime $AFTER_UPDATE"
[ "$AFTER_UPDATE" != "$BEFORE_UPDATE" ] || die "lastUpdateTime 이 그대로다 — 설치가 반영되지 않았다"
[ "$AFTER_VNAME" = "$NEW_VNAME" ] || die "설치 후 versionName $AFTER_VNAME — 새 APK 의 $NEW_VNAME 과 다르다"
echo "✔ $SERIAL 에 $PACKAGE $AFTER_VNAME 설치 ($BEFORE_VNAME → $AFTER_VNAME)"
echo "  apk $APK  sha256 $(shasum -a 256 "$APK" | cut -d' ' -f1)"
