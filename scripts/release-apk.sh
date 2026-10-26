#!/usr/bin/env bash
# LIFE-703 최종 관문 ⓙ 스텁 — --preflight 는 통과, 그 밖은 호출만 남긴다(정상 종료)
if [ "${1:-}" = --preflight ]; then echo "apk-stub preflight pwd=$PWD" >> /tmp/l703g/stub.log; echo "· APK 전제 스텁 통과"; exit 0; fi
echo "apk-stub pwd=$PWD script=$0 describe=$(git -C "$(dirname "$0")" describe --tags --exact-match 2>/dev/null) args=$*" | tee -a /tmp/l703g/stub.log
