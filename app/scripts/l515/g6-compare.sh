#!/bin/sh
# LIFE-515 G6 — 작업 시작 해시(g6-before.txt, 넓은 범위 — ~/.grok 최상위 전부 포함)와 지금(g6-hash.sh, q1 엄격 범위)을 견준다.
# 엄격 범위의 줄이 시작 해시에 그대로 있으면 통과(전 = 후). 시작 해시에만 있는 ~/.grok 런타임 줄은 대조하지 않고 목록만 낸다(q1).
# 시작 해시에 그 파일 줄이 아예 없으면(작업 시작 범위 밖 — ~/.grok/hooks/ 는 시작 스크립트의 `~/.grok/*` 글롭이 폴더라 건너뛰었다) 둘째 기준
# (네이티브 관문 g6-pre.txt — 같은 엄격 범위, 관문 직전 12:26)과 대조한다. 첫 회차(R018)는 이 구분 없이 「다름」 으로 셌다 — 그 행은 지우지 않는다.
# 사용(저장소 루트): sh app/scripts/l515/g6-compare.sh <g6-before.txt> <g6-after.txt 를 쓸 경로> [둘째 기준 g6-pre.txt]
set -u
BEFORE=$1; AFTER=$2; SECOND=${3:-}
sh "$(dirname "$0")/g6-hash.sh" > "$AFTER"
bad=0
while IFS= read -r line; do
  hash=$(echo "$line" | awk '{print $1}'); name=$(echo "$line" | awk '{print $NF}')
  if grep -qF -- "$line" "$BEFORE"; then echo "✔ 전=후 $name"
  elif ! grep -qF -- "$name" "$BEFORE" && [ -n "$SECOND" ] && grep -qF -- "$line" "$SECOND"; then echo "✔ 전=후 $name (작업 시작 해시 범위 밖 → 네이티브 관문 직전 g6-pre 와 같음)"
  else echo "✘ 다름 $name ($hash) — 시작: $(grep -F -- "$name" "$BEFORE" | head -1) · 둘째 기준: $([ -n "$SECOND" ] && grep -F -- "$name" "$SECOND" | head -1)"; bad=1; fi
done < "$AFTER"
echo "(대조 아님) 시작 해시에만 있는 ~/.grok 런타임 줄: $(grep -c '~/.grok/' "$BEFORE") 중 엄격 범위 밖 $(grep '~/.grok/' "$BEFORE" | grep -vc -e 'config.toml' -e 'trusted_folders.toml' -e '/hooks/')"
exit $bad
