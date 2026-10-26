#!/usr/bin/env bash
# LIFE-703 최종 관문 ⓙ 스텁 — 실 빌드 없이 호출만 남긴다(정상 종료)
echo "dmg-stub pwd=$PWD script=$0 describe=$(git -C "$(dirname "$0")" describe --tags --exact-match 2>/dev/null) args=$*" | tee -a /tmp/l703g/stub.log
