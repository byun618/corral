#!/bin/zsh
# LIFE-692 K4 번들 대조 — 기준 빌드 out 과 이 브랜치 빌드 out 의 청크별 바이트(해시 뗀 이름으로 맞춤) + 새 기여 표지 문자열이 든 청크.
# 사용: bundle-compare.sh <기준 out> <브랜치 out>
set -u
base=$1; branch=$2
table() { (cd $1 && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) | while read f; do echo "$(echo $f | sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)$/.\1/') $(stat -f %z $f)"; done | sort) }
echo "## 청크별 바이트 (이름 = 해시 뗀 경로) — 다른 것만 + main·preload·renderer index 는 늘"
echo "| 청크 | 기준 | 브랜치 | 차 |"; echo "| --- | --- | --- | --- |"
join -a1 -a2 -e 0 -o 0,1.2,2.2 <(table $base) <(table $branch) | while read name a b; do
  if [[ $a != $b || $name == ./main/* || $name == ./preload/* || $name == ./renderer/assets/index.js || $name == ./renderer/assets/monaco.js ]]; then echo "| $name | $a | $b | $((b - a)) |"; fi
done
echo
echo "## 새 기여 표지 문자열이 든 청크 (명령 id — linesOperations·comment·indentation·caretOperations·wordPartOperations, 629 액션)"
for marker in editor.action.deleteLines deleteAllLeft editor.action.moveLinesUpAction editor.action.commentLine editor.action.blockComment editor.action.indentationToSpaces editor.action.transposeLetters cursorWordPartLeft markdown.togglePreview data-markdown-view; do
  for side in base branch; do
    dir=${(P)side}
    hits=$(grep -rl --include='*.js' -- "$marker" $dir | sed -E "s|^$dir/||; s/-[A-Za-z0-9_-]{8}\.js$/.js/" | sort | tr '\n' ' ')
    echo "- \`$marker\` · $side: ${hits:-(없음)}"
  done
done
