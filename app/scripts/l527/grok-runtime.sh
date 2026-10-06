#!/bin/sh
# LIFE-527 K9 — l526 복사(코드 줄의 잔존 검색어 l526→l527·ROOT 꼴 /tmp/l527n*·이 빌드 경로·L526_ 환경변수 이름만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-526 K4ⓐ — l516 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l526·이 빌드 경로만 sed 로 바꿈). 아래는 원 주석.
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
