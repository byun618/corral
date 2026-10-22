#!/usr/bin/env bash
# LIFE-672 변이 대조 — 제품 코드에 결함을 하나씩 넣고 해당 시험이 실패(= 잡음)하는지 본다. 끝나면 원본 바이트로 복원·대조.
# app/scripts/l672/mutate.sh <원자료 폴더> [변이 id …]   (생략 = 전부). 레포 루트 기준 경로, node v24·짧은 TMPDIR 필요(B 변이)
# 리뷰 r1 의 생존 변이(M03·M04·M10·M19·T6b·G1-3 rm)와 수정 r1 의 새 분기(G1-1·G1-6·C1-8·C1-4·T6-tree)를 다시 건다.
set -uo pipefail

OUT="${1:?원자료 폴더}"; shift
IDS="${*:-M03 M04 M10 M19 G1-3rm G1-1 G1-6 C1-8 C1-4 T6b T6-tree}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p "$OUT" "${TMPDIR:-/tmp}"
OUT="$(cd "$OUT" && pwd)"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"
BAK="$(mktemp -d "${TMPDIR:-/tmp}/l672mut.XXXXXX")" || exit 1
FILES="scripts/release-ff.sh app/src/main/explorer-hub.ts app/src/main/git-status.ts"
for f in $FILES; do mkdir -p "$BAK/$(dirname "$f")"; cp "$ROOT/$f" "$BAK/$f"; done
restore() { for f in $FILES; do cp "$BAK/$f" "$ROOT/$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT
echo "# mutate $(date '+%F %T') · release-ff.sh sha1 $(shasum "$ROOT/scripts/release-ff.sh" | cut -c1-12)" | tee -a "$SUMMARY"

# mutate <파일> <원문> <바꿀 문> — 원문이 정확히 1번 있어야 한다
mutate() {
  python3 - "$ROOT/$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
n = s.count(old)
if n != 1:
    sys.exit(f"원문 {n}회 — 변이를 걸 수 없다: {old!r}")
open(path, "w").write(s.replace(old, new))
PY
}

for ID in $IDS; do
  restore
  LOG="$OUT/$ID.txt"
  KIND=ff; CASES=""
  case "$ID" in
    M03) WHAT="재시도 grep 에서 'Unable to write index' 제거"; CASES="r1-unable"
         mutate scripts/release-ff.sh "grep -qE 'index\.lock|Unable to write index'" "grep -qE 'index\.lock'" ;;
    M04) WHAT="재시도 조건에서 git 문구 grep 통째 제거(lock 존재만)"; CASES="r1-unable r1-toctou"
         mutate scripts/release-ff.sh "if [ -e \"\$LOCK\" ] || echo \"\$LAST_ERR\" | grep -qE 'index\.lock|Unable to write index'; then return 1; fi" "if [ -e \"\$LOCK\" ]; then return 1; fi" ;;
    M10) WHAT="스크립트 자신의 status 에서 --no-optional-locks 제거"; CASES="r1a r3d-dirty"
         mutate scripts/release-ff.sh 'DIRTY="$(git --no-optional-locks status --porcelain)"' 'DIRTY="$(git status --porcelain)"' ;;
    M19) WHAT="앞섬/뒤짐 rev-list 범위 맞바꿈"; CASES="r3a"
         mutate scripts/release-ff.sh 'ahead="$(git rev-list --count "$REMOTE..HEAD")"' 'ahead="$(git rev-list --count "HEAD..$REMOTE")"'
         mutate scripts/release-ff.sh 'behind="$(git rev-list --count "HEAD..$REMOTE")"' 'behind="$(git rev-list --count "$REMOTE..HEAD")"' ;;
    G1-3rm) WHAT="갈라짐 경로에서 lock 삭제"; CASES="r3a-lock"
         mutate scripts/release-ff.sh '  local ahead behind' '  local ahead behind; rm -f "$LOCK"' ;;
    G1-1) WHAT="git 환경변수 unset 제거"; CASES="r-gitdir"
         mutate scripts/release-ff.sh 'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR' ': unset 제거' ;;
    G1-6) WHAT="상한 뒤 마지막 시도 제거"; CASES="r1-final"
         mutate scripts/release-ff.sh 'if [ ! -e "$LOCK" ] && try_ff; then' 'if false; then' ;;
    C1-8) WHAT="lsof 실패도 「없음」"; CASES="r2-lsoferr"
         mutate scripts/release-ff.sh 'if [ "$rc" = 1 ]; then echo "없음"' 'if true; then echo "없음"' ;;
    C1-4) WHAT="lock 소멸 시 기본값 없이 stat(구 형태)"; CASES="r2-vanish"
         mutate scripts/release-ff.sh 'mtime="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || true)"' 'mtime="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null)"' ;;
    T6b) KIND=vitest; WHAT="탐색기 runGitStatus 가 억제 없는 인자로 호출"
         mutate app/src/main/explorer-hub.ts "execFile('git', ['-C', cwd, ...GIT_STATUS_ARGS]" "execFile('git', ['-C', cwd, ...GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks')]" ;;
    T6-tree) KIND=vitest; WHAT="트리 골격 getGitStatus 가 억제 없는 인자로 호출"
         mutate app/src/main/git-status.ts "await run('git', ['-C', worktreePath, ...GIT_STATUS_ARGS]" "await run('git', ['-C', worktreePath, ...GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks')]" ;;
    *) echo "모르는 변이 $ID" >&2; exit 64 ;;
  esac
  MRC=$?
  {
    echo "## $ID — $WHAT ($(date '+%F %T'))"
    echo "--- 변이 diff(원본 대비)"; for f in $FILES; do diff -u "$BAK/$f" "$ROOT/$f"; done
  } > "$LOG"
  if [ "$MRC" != 0 ]; then echo "$ID 변이 적용 실패" | tee -a "$SUMMARY"; continue; fi
  if [ "$KIND" = ff ]; then
    echo "\$ app/scripts/l672/ff-test.sh <tmp> $CASES" >> "$LOG"
    "$ROOT/app/scripts/l672/ff-test.sh" "$OUT/$ID-run" $CASES >> "$LOG" 2>&1; RC=$?
    grep -h "FAIL " "$OUT/$ID-run/"*.txt >> "$LOG" 2>/dev/null
  else
    echo "\$ (app) npx vitest run src/main/git-optional-locks.test.ts" >> "$LOG"
    (cd "$ROOT/app" && npx vitest run src/main/git-optional-locks.test.ts) >> "$LOG" 2>&1; RC=$?
  fi
  if [ "$RC" != 0 ]; then V="잡힘"; else V="생존"; fi
  echo "시험 종료코드 $RC → $V" >> "$LOG"
  echo "$ID $V (시험 종료코드 $RC) — $WHAT" | tee -a "$SUMMARY"
done
restore
for f in $FILES; do cmp -s "$BAK/$f" "$ROOT/$f" && echo "복원 확인 $f 같음" || echo "복원 실패 $f"; done | tee -a "$SUMMARY"
