#!/bin/sh
# LIFE-515 G6 — 사용자 설정 해시(읽기만). 시작·끝에 같은 목록을 찍어 대조한다(전 = 후, g6-compare.mjs).
# 범위(q1 코디 답 조건 1): ~/.orca/keybindings.json · ~/.claude/settings.json·hooks/** · ~/.codex/config.toml · ~/.grok/config.toml·trusted_folders.toml·hooks/** ·
# 사용자 corral settings.json(네이티브 원복 = 백업 바이트 복원)·keybindings.json(없음 유지). grok 런타임 파일은 grok-runtime.sh 가 따로 찍는다(대조 아님 — 목록).
# 줄 형식: `<sha256>  <크기>B  ~/<경로>` · 고정 파일이 없으면 `absent  ~/<경로>` (fix1 R1-01 — 부재도 명시 줄). hooks 폴더는 하위 파일 전부(find).
# 해시·크기를 못 읽으면 그 자리에서 exit 3 — 빈 출력으로 끝나 비교기가 통과로 읽지 않게 한다.
UD="$HOME/Library/Application Support/corral"
line() {
  # 파이프 종료코드는 마지막 명령(cut·tr) 것이라 실패는 빈 값으로 잡는다
  sum=$(shasum -a 256 "$1" | cut -d' ' -f1)
  size=$(wc -c <"$1" | tr -d ' ')
  [ -n "$sum" ] && [ -n "$size" ] || exit 3
  echo "$sum  ${size}B  ~/${1#$HOME/}"
}
for f in "$HOME/.orca/keybindings.json" "$HOME/.claude/settings.json" "$HOME/.codex/config.toml" "$HOME/.grok/config.toml" "$HOME/.grok/trusted_folders.toml" "$UD/settings.json" "$UD/keybindings.json"; do
  if [ -f "$f" ]; then line "$f"; elif [ -e "$f" ]; then exit 3; else echo "absent  ~/${f#$HOME/}"; fi
done
for d in "$HOME/.claude/hooks" "$HOME/.grok/hooks"; do
  [ -d "$d" ] || { echo "absent  ~/${d#$HOME/}/"; continue; }
  find "$d" -type f | LC_ALL=C sort > "${TMPDIR:-/tmp}/l515-g6-hooks.$$" || exit 3
  while IFS= read -r f; do line "$f" || exit 3; done < "${TMPDIR:-/tmp}/l515-g6-hooks.$$"
  rm -f "${TMPDIR:-/tmp}/l515-g6-hooks.$$"
done
exit 0
