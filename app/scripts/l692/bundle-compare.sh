#!/bin/zsh
# LIFE-692 K4 번들 대조 — 기준 빌드 out 과 이 브랜치 빌드 out 의 청크별 바이트(해시 뗀 이름으로 맞춤) + 새 기여 표지 문자열이 든 청크.
# 사용: bundle-compare.sh <기준 out> <브랜치 out>
# 종료코드(f1 F4): 입력 디렉터리가 없거나 · 어느 쪽 청크 표가 비거나 · 표지가 브랜치에서 하나도 안 잡히면 1(빈 표가 정상 출력처럼 보이지 않게).
set -u
base=${1:-}; branch=${2:-}
for dir in $base $branch; do [[ -n $dir && -d $dir ]] || { echo "입력 디렉터리 없음: '$dir'" >&2; exit 1 }; done
table() { (cd $1 && find . -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' \) | while read f; do echo "$(echo $f | sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)$/.\1/') $(stat -f %z $f)"; done | sort) }
base_table=$(table $base); branch_table=$(table $branch)
[[ -n $base_table ]] || { echo "기준 청크 표가 비었다: $base" >&2; exit 1 }
[[ -n $branch_table ]] || { echo "브랜치 청크 표가 비었다: $branch" >&2; exit 1 }
echo "## 청크별 바이트 (이름 = 해시 뗀 경로) — 다른 것만 + main·preload·renderer index 는 늘"
echo "| 청크 | 기준 | 브랜치 | 차 |"; echo "| --- | --- | --- | --- |"
join -a1 -a2 -e 0 -o 0,1.2,2.2 <(print -r -- $base_table) <(print -r -- $branch_table) | while read name a b; do
  if [[ $a != $b || $name == ./main/* || $name == ./preload/* || $name == ./renderer/assets/index.js || $name == ./renderer/assets/monaco.js ]]; then echo "| $name | $a | $b | $((b - a)) |"; fi
done
echo
echo "## 새 기여 표지 문자열이 든 청크 (명령 id — linesOperations·comment·indentation·caretOperations·wordPartOperations, 629 액션)"
found=0
for marker in editor.action.deleteLines deleteAllLeft editor.action.moveLinesUpAction editor.action.commentLine editor.action.blockComment editor.action.indentationToSpaces editor.action.transposeLetters cursorWordPartLeft markdown.togglePreview data-markdown-view; do
  for side in base branch; do
    dir=${(P)side}
    hits=$(grep -rl --include='*.js' -- "$marker" $dir | sed -E "s|^$dir/||; s/-[A-Za-z0-9_-]{8}\.js$/.js/" | sort | tr '\n' ' ')
    echo "- \`$marker\` · $side: ${hits:-(없음)}"
    [[ $side == branch && -n $hits ]] && found=$((found + 1))
  done
done
(( found > 0 )) || { echo "표지가 브랜치 어느 청크에서도 안 잡혔다" >&2; exit 1 }
exit 0
