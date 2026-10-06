#!/bin/sh
# LIFE-515 K8ⓑ — grok 런타임 상태 목록(읽기만, 대조 아님). ~/.grok 최상위 파일 해시·크기 + 하위 폴더 파일 수·최신 mtime(폴더는 1GB 라 해시하지 않는다).
# 설정 파일(config.toml·trusted_folders.toml·hooks/)은 g6-hash.sh 가 엄격 대조한다. 바뀐 런타임 파일은 RESULT 에 「K8ⓑ grok 기동의 자체 기록」(q1).
G="$HOME/.grok"
for f in "$G"/* "$G"/.[!.]*; do
  [ -f "$f" ] && echo "file $(shasum -a 256 "$f" | cut -d' ' -f1) $(wc -c <"$f" | tr -d ' ')B ${f#$HOME/}"
done
for d in "$G"/*/; do
  d=${d%/}; n=$(find "$d" -type f 2>/dev/null | wc -l | tr -d ' ')
  latest=$(find "$d" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -n | tail -1)
  echo "dir  files=$n latest_mtime=${latest:-none} ${d#$HOME/}"
done
