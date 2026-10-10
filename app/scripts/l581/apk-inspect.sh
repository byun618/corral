# LIFE-581 Y11 — 판정 APK 확인: 크기·sha256 · 패키지·버전(aapt badging) · 서명자(apksigner) — 서명자가 578·580 판정 APK 와 같아야 폰에 덮어 설치된다.
set -eu
APK=$HOME/Library/Caches/l581fg/${1:-corral-preview-local.apk}
BT=/opt/homebrew/share/android-commandlinetools/build-tools/36.0.0
echo "build-tools: 36.0.0"; stat -f '%z bytes' "$APK"; shasum -a 256 "$APK"
"$BT/aapt" dump badging "$APK" | grep -E "^package:|^sdkVersion|^targetSdkVersion|^application-label:"
"$BT/apksigner" verify --print-certs "$APK" | grep -E "Signer #1 certificate (SHA-256|DN)"
"$BT/apksigner" verify --print-certs "$APK" | grep -q "483a15fa12070225b63bd159ac1ef25c862e23680f7e64d7918faba5501a617a" && echo "서명자 = 578·580 판정 APK 와 같은 키"
