#!/bin/sh
# LIFE-515 G6 — 사용자 설정 해시(읽기만). 시작·끝에 같은 목록을 찍어 대조한다(전 = 후, g6-compare.mjs).
# 범위(q1 코디 답 조건 1): ~/.orca/keybindings.json · ~/.claude/settings.json·hooks/** · ~/.codex/config.toml · ~/.grok/config.toml·trusted_folders.toml·hooks/** ·
# 사용자 corral settings.json(네이티브 원복 = 백업 바이트 복원)·keybindings.json(없음 유지). grok 런타임 파일은 grok-runtime.sh 가 따로 찍는다(대조 아님 — 목록).
# 줄 형식:
#   일반 파일    `<sha256>  <크기>B  ~/<경로>`
#   심볼릭 링크  `<대상 내용 sha256>  <대상 크기>B  ~/<경로> -> <링크 대상>` (fix2 R2-02 — 대상 경로·대상 내용 둘 다 대조된다)
#   고정 파일 없음 `absent  ~/<경로>` (fix1 R1-01)
# 실패는 exit 3 — 빈·불완전 출력으로 끝나 비교기가 통과로 읽지 않게 한다(fix2 R2-01: 파이프를 쓰지 않고 명령마다 종료코드를 본다).
#   상위 경로 탐색 불가(EACCES)·상위 경로 중간이 폴더가 아님(ENOTDIR) — fix3 R3-01: `[ -e ]`·`[ -L ]` 는 이때도 false 라 「없음」 으로 잘못 읽힌다 ·
#   해시·크기를 못 읽음 · 끊긴 링크 · 폴더를 가리키는 링크 · hooks 폴더 자체가 링크 · 일반 파일·링크·폴더가 아닌 종류(fifo 등) · find 탐색 오류(읽을 수 없는 하위 폴더 등) · 정렬 실패.
# 시험용: L515_G6_HOME 이 있으면 HOME 대신 그 경로를 본다(자체 검사는 임시 HOME 에서 — 사용자 경로를 건드리지 않는다).
ROOT="${L515_G6_HOME:-$HOME}"
UD="$ROOT/Library/Application Support/corral"
TMP="${TMPDIR:-/tmp}/l515-g6.$$"
fail() { echo "g6-hash: $1" >&2; rm -f "$TMP".*; exit 3; }
line() {
  out=$(shasum -a 256 "$1") || fail "해시 실패 $1"
  sum=${out%% *}
  size=$(wc -c <"$1") || fail "크기 실패 $1"
  size=$(echo $size)
  [ -n "$sum" ] && [ -n "$size" ] || fail "빈 해시·크기 $1"
  if [ -L "$1" ]; then
    target=$(readlink "$1") || fail "readlink 실패 $1"
    echo "$sum  ${size}B  ~/${1#$ROOT/} -> $target"
  else
    echo "$sum  ${size}B  ~/${1#$ROOT/}"
  fi
}
entry() {
  if [ -L "$1" ]; then
    [ -e "$1" ] || fail "끊긴 링크 $1"
    [ -f "$1" ] || fail "파일이 아닌 대상을 가리키는 링크 $1"
    line "$1"
  elif [ -f "$1" ]; then line "$1"
  elif [ -d "$1" ]; then :
  else fail "지원하지 않는 종류 $1"
  fi
}
# fix3 R3-01 — 「없음」 은 ENOENT 만이다. ROOT 부터 대상의 부모까지 각 단계가 「탐색 가능한 폴더」 인지 먼저 본다.
# 어느 단계가 없으면(부모가 탐색 가능하다는 것을 이미 확인했으니 ENOENT) 그 아래는 전부 없음 → 0 을 돌려 「없음」 기록을 허락한다.
# 있는데 폴더가 아니거나(ENOTDIR·끊긴 링크) 탐색 권한이 없으면(EACCES) 수집 실패. 이 확인을 거친 뒤에만 `[ -e ]`·`[ -L ]` 결과를 믿는다.
parents_ok() {
  [ -d "$ROOT" ] && [ -x "$ROOT" ] || fail "ROOT 탐색 불가 $ROOT"
  rel=${1#$ROOT/}
  parent_rel=${rel%/*}
  [ "$parent_rel" = "$rel" ] && return 0
  cur=$ROOT
  old_ifs=$IFS; IFS=/; set -f
  for part in $parent_rel; do
    cur="$cur/$part"
    if [ -L "$cur" ] || [ -e "$cur" ]; then
      [ -d "$cur" ] || { IFS=$old_ifs; set +f; fail "상위 경로가 폴더가 아님(ENOTDIR) $cur"; }
      [ -x "$cur" ] || { IFS=$old_ifs; set +f; fail "상위 폴더 탐색 불가(EACCES) $cur"; }
    else
      break
    fi
  done
  IFS=$old_ifs; set +f
  return 0
}
for f in "$ROOT/.orca/keybindings.json" "$ROOT/.claude/settings.json" "$ROOT/.codex/config.toml" "$ROOT/.grok/config.toml" "$ROOT/.grok/trusted_folders.toml" "$UD/settings.json" "$UD/keybindings.json"; do
  parents_ok "$f"
  if [ -L "$f" ] || [ -e "$f" ]; then
    [ -L "$f" ] || [ -f "$f" ] || fail "고정 경로가 파일이 아님 $f"
    entry "$f"
  else echo "absent  ~/${f#$ROOT/}"; fi
done
for d in "$ROOT/.claude/hooks" "$ROOT/.grok/hooks"; do
  parents_ok "$d"
  [ -L "$d" ] && fail "hooks 폴더가 링크 $d"
  if [ ! -e "$d" ]; then echo "absent  ~/${d#$ROOT/}/"; continue; fi
  [ -d "$d" ] || fail "hooks 가 폴더가 아님 $d"
  find "$d" -mindepth 1 > "$TMP.list" 2> "$TMP.err" || fail "find 실패 $d: $(cat "$TMP.err")"
  [ -s "$TMP.err" ] && fail "find 오류 출력 $d: $(cat "$TMP.err")"
  LC_ALL=C sort "$TMP.list" > "$TMP.sorted" || fail "정렬 실패 $d"
  while IFS= read -r f; do entry "$f"; done < "$TMP.sorted"
done
rm -f "$TMP".*
exit 0
