#!/bin/bash
# R4 원자료 — 작업 트리 루트에서 실행
cd "$(git rev-parse --show-toplevel)"
P='\brm\b|unlink|rmdir|-delete|\bmv\b'
echo "# R4 최종 관문 — $(date '+%F %T') · 기준 510152c65 대비 작업 트리 · release-ff.sh sha1 $(shasum scripts/release-ff.sh | cut -c1-12) · release.sh sha1 $(shasum scripts/release.sh | cut -c1-12)"
echo; echo "## ⓐ lock 을 지우는 코드"
echo "\$ grep -nE \"$P\" scripts/release-ff.sh"; grep -nE "$P" scripts/release-ff.sh; echo "exit=$? (1 = 0줄)"
echo "\$ git diff 510152c65 -- scripts/release.sh app/src/main/git-status.ts app/src/main/explorer-hub.ts | grep \"^+\" | grep -nE \"$P\""
git diff 510152c65 -- scripts/release.sh app/src/main/git-status.ts app/src/main/explorer-hub.ts | grep "^+" | grep -nE "$P"; echo "exit=$? (1 = 0줄)"
echo "\$ grep -n \"LOCK\" scripts/release-ff.sh"; grep -n "LOCK" scripts/release-ff.sh
echo; echo "## ⓑ 새 die·exit — release.sh diff 의 + 줄"
echo "\$ git diff 510152c65 -- scripts/release.sh | grep '^+' | grep -nE '\bdie\b|\bexit\b'"
git diff 510152c65 -- scripts/release.sh | grep '^+' | grep -nE '\bdie\b|\bexit\b'; echo "exit=$? (1 = 0줄)"
echo; echo "## 종료코드 — 머리 주석 목록 vs 코드의 exit"
grep -n "^# *종료코드\|^#  *[0-9] " scripts/release-ff.sh | head -5
grep -noE "exit [0-9]+" scripts/release-ff.sh | tr '\n' ' '; echo
echo; echo "## ⓒ release.sh diff 전체 (4단계 밖은 머리 주석 2줄뿐)"
git diff 510152c65 -- scripts/release.sh
echo; echo "## ⓓ bash -n"
for f in scripts/release.sh scripts/release-ff.sh app/scripts/l672/ff-test.sh app/scripts/l672/mutate.sh app/scripts/l672/native-r8.sh app/scripts/l672/lockprobe.sh app/scripts/l672/explorer-ms.sh app/scripts/l672/r1b-contend.sh app/scripts/l672/r5.sh app/scripts/l672/verify-native.sh; do
  [ -e "$f" ] || { echo "$f 없음"; continue; }; bash -n "$f"; echo "bash -n $f exit=$?"; done
echo "shellcheck: $(command -v shellcheck || echo '없음(공백)')"
