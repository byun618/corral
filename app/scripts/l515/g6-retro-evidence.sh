#!/bin/sh
# LIFE-515 fix2 — 옛 수집기(fix1 이하)의 두 결함(R2-01 find 실패 무시 · R2-02 링크 제외)이 이전 회차에 걸리지 않았다는 **관측**(증명 아님).
# 지금 시점의 ~/.claude/hooks·~/.grok/hooks 에 대해: 링크 수 · 일반 파일·폴더 외 종류 수 · find 탐색 오류 유무 · 각 항목 mtime(작업 시작 2026-10-06 전인가).
# 읽기만 한다. 사용: sh app/scripts/l515/g6-retro-evidence.sh
START_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S" "2026-10-06 00:00:00" +%s) || exit 2
for d in "$HOME/.claude/hooks" "$HOME/.grok/hooks"; do
  echo "## ~/${d#$HOME/}"
  ls -ld "$d"
  [ -L "$d" ] && echo "✘ 폴더 자체가 링크"
  err=$(find "$d" -mindepth 0 2>&1 >/dev/null); rc=$?
  if [ $rc -ne 0 ] || [ -n "$err" ]; then echo "✘ find 탐색 오류 rc=$rc: $err"; else echo "✔ find 탐색 오류 없음(하위 폴더 모두 읽기 가능)"; fi
  links=$(find "$d" -type l | wc -l | tr -d ' ')
  others=$(find "$d" ! -type f ! -type d ! -type l | wc -l | tr -d ' ')
  subdirs=$(find "$d" -mindepth 1 -type d | wc -l | tr -d ' ')
  echo "링크 ${links}개 · 하위 폴더 ${subdirs}개 · 파일·폴더·링크 외 종류 ${others}개"
  # 이 루프는 파이프 안(서브셸)이라 변수로 실패를 넘기지 못한다 — ✘ 줄로 남기고 끝에서 grep 으로 센다(R065 는 이 두 줄이 없던 판본).
  [ "$links" = 0 ] || echo "✘ 링크가 있다"
  [ "$others" = 0 ] || echo "✘ 지원하지 않는 종류가 있다"
  find "$d" -mindepth 0 | LC_ALL=C sort | while IFS= read -r f; do
    m=$(stat -f %m "$f")
    if [ "$m" -lt "$START_EPOCH" ]; then mark="✔ 작업 시작 전"; else mark="✘ 작업 시작 뒤"; fi
    echo "$mark  $(stat -f '%Sm %HT' -t '%Y-%m-%dT%H:%M:%S%z' "$f")  ~/${f#$HOME/}"
  done
done | tee /dev/stderr | grep -q "^✘" && exit 1
exit 0
