# LIFE-581 Y11 APK — 로컬 preview 빌드(EAS 원격 서명). 578·F-K1 교훈: 작업 폴더가 /tmp(심링크)면 ninja 가 libworklets.so 를 못 찾는다 →
# 작업 폴더를 심링크 없는 ~/Library/Caches/l581fg/eas-work 로, TMPDIR 도 같은 곳. 산출 APK 는 커밋하지 않는다(해시만).
set -u
OUT=$HOME/Library/Caches/l581fg
mkdir -p $OUT/eas-work $OUT/tmp
export EAS_LOCAL_BUILD_WORKINGDIR=$OUT/eas-work TMPDIR=$OUT/tmp
npm run build:local:preview -- --non-interactive --output $OUT/corral-preview-local.apk 2>&1 | sed -E "s/eyJ[A-Za-z0-9+\/=_-]{200,}/<redacted: EAS job base64>/g"
exit ${pipestatus[1]}
