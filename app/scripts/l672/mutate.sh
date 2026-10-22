#!/usr/bin/env bash
# LIFE-672 변이 대조 — 제품 코드에 결함을 하나씩 넣고 해당 시험이 실패(= 잡음)하는지 본다.
# app/scripts/l672/mutate.sh <원자료 폴더> [변이 id …]   (생략 = 전부). node v24 필요(B 변이)
# 변이는 **사본 트리**(mktemp -d /tmp/l672mut.XXXXXX)에서만 건다 — 작업 트리는 건드리지 않는다. 사본: scripts/·app/scripts/l672/·
# app/src/·app 설정 파일, app/node_modules 는 심링크. 변이마다 사본의 원본 바이트로 되돌린 뒤 하나만 바꾼다.
# 판정: 「잡힘」 = 시험 로그에 케이스 FAIL 줄(ff-test) 또는 vitest 「N failed」 ≥ 1 · 「생존」 = 시험 종료코드 0 ·
#       「판정불가」 = 비0 인데 FAIL 줄이 없음(러너 실패 등) · 「적용 실패」 = 원문을 못 찾음
# 판정 회차는 직렬로 돌린다. INFRA(기본 목록 밖)는 판정 방식 자체의 대조 — 러너 실패가 「잡힘」 으로 세지지 않는지.
set -uo pipefail

OUT="${1:?원자료 폴더}"; shift
ALLIDS="M03 M04 M10 M19 G1-3rm G1-1 G1-6 C1-8 C1-4 T6b T6-tree N4 N11 N19 N-post N-ahead-sleep C2-4rp C2-4rl C2-6 C2-9 C2-7"
IDS="${*:-$ALLIDS}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"
T="$(mktemp -d /tmp/l672mut.XXXXXX)" || exit 1
trap 'rm -rf "$T"' EXIT
# 사본 트리
mkdir -p "$T/scripts" "$T/app/scripts" "$T/pristine"
cp "$SRC/scripts/release.sh" "$SRC/scripts/release-ff.sh" "$T/scripts/"
cp -R "$SRC/app/scripts/l672" "$T/app/scripts/"
cp -R "$SRC/app/src" "$T/app/src"
cp "$SRC/app/package.json" "$SRC"/app/tsconfig*.json "$T/app/"
ln -s "$SRC/app/node_modules" "$T/app/node_modules"
FILES="scripts/release-ff.sh scripts/release.sh app/src/main/explorer-hub.ts app/src/main/git-status.ts"
for f in $FILES; do mkdir -p "$T/pristine/$(dirname "$f")"; cp "$T/$f" "$T/pristine/$f"; done
reset_copy() { for f in $FILES; do cp "$T/pristine/$f" "$T/$f"; done; }
echo "# mutate $(date '+%F %T') · 사본 $T · 원본 release-ff.sh sha1 $(shasum "$SRC/scripts/release-ff.sh" | cut -c1-12) · release.sh sha1 $(shasum "$SRC/scripts/release.sh" | cut -c1-12)" | tee -a "$SUMMARY"

# mutate <사본 안 파일> <원문> <바꿀 문> — 원문이 정확히 1번 있어야 한다
mutate() {
  python3 - "$T/$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
n = s.count(old)
if n != 1:
    sys.exit(f"원문 {n}회 — 변이를 걸 수 없다: {old!r}")
open(path, "w").write(s.replace(old, new))
PY
}

FF=scripts/release-ff.sh
for ID in $IDS; do
  reset_copy
  LOG="$OUT/$ID.txt"
  KIND=ff; CASES=""; MRC=0
  case "$ID" in
    M03) WHAT="재시도 grep 에서 'Unable to write index' 제거"; CASES="r1-unable-injected"
         mutate $FF "grep -qE 'index\.lock|Unable to write index'" "grep -qE 'index\.lock'" || MRC=1 ;;
    M04) WHAT="재시도 조건에서 git 문구 grep 통째 제거(lock 존재만)"; CASES="r1-unable-injected r1-toctou"
         mutate $FF "if [ -e \"\$LOCK\" ] || echo \"\$LAST_ERR\" | grep -qE 'index\.lock|Unable to write index'; then return 1; fi" "if [ -e \"\$LOCK\" ]; then return 1; fi" || MRC=1 ;;
    M10) WHAT="스크립트 자신의 status 에서 --no-optional-locks 제거"; CASES="r1a r3d-dirty"
         mutate $FF 'dirty_lines() { git --no-optional-locks status --porcelain' 'dirty_lines() { git status --porcelain' || MRC=1 ;;
    M19) WHAT="앞섬/뒤짐 rev-list 범위 맞바꿈"; CASES="r3a"
         mutate $FF 'ahead="$(git rev-list --count "$REMOTE..HEAD")"' 'ahead="$(git rev-list --count "HEAD..$REMOTE")"' || MRC=1
         mutate $FF 'behind="$(git rev-list --count "HEAD..$REMOTE")"' 'behind="$(git rev-list --count "$REMOTE..HEAD")"' || MRC=1 ;;
    G1-3rm) WHAT="갈라짐 경로에서 lock 삭제"; CASES="r3a-lock"
         mutate $FF '  local ahead behind' '  local ahead behind; rm -f "$LOCK"' || MRC=1 ;;
    G1-1) WHAT="git 환경변수 unset 제거"; CASES="r-gitdir"
         mutate $FF 'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR' ': unset 제거' || MRC=1 ;;
    G1-6) WHAT="상한 뒤 마지막 시도 제거"; CASES="r1-final"
         mutate $FF 'if [ ! -e "$LOCK" ] && try_ff; then' 'if false; then' || MRC=1 ;;
    C1-8) WHAT="lsof 실패도 「없음」"; CASES="r2-lsoferr"
         mutate $FF 'if [ "$rc" = 1 ] && [ -z "$err" ]; then echo' 'if true; then echo' || MRC=1 ;;
    C1-4) WHAT="lock 소멸 시 기본값 없이 stat(구 형태)"; CASES="r2-vanish"
         mutate $FF 'mtime="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || true)"' 'mtime="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null)"' || MRC=1 ;;
    N4) WHAT="merge-base 오류 분기(exit 8) 제거 → return 1"; CASES="r8-mergebase"
         mutate $FF '로 실패해 원인을 가리지 못했다"; exit 8 ;;' '로 실패해 원인을 가리지 못했다"; return 1 ;;' || MRC=1 ;;
    N11) WHAT="unset 을 GIT_DIR GIT_WORK_TREE 로 좁힘"; CASES="r-gitindex"
         mutate $FF 'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR' 'unset GIT_DIR GIT_WORK_TREE' || MRC=1 ;;
    N19) WHAT="상한 뒤 lock 없이 index 를 못 쓴 분기 exit 2 → exit 0"; CASES="r2-noindex"
         mutate $FF ', 지금은 lock 없음). git: $(first_line "$LAST_ERR")"
exit 2' ', 지금은 lock 없음). git: $(first_line "$LAST_ERR")"
exit 0' || MRC=1 ;;
    N-post) WHAT="merge 실패 뒤 두 번째 is_ancestor 제거"; CASES="r3-postdiverge"
         mutate $FF '  is_ancestor HEAD "$REMOTE" || not_behind_exit
  note "⚠ $WHO fast-forward 실패(index lock' '  note "⚠ $WHO fast-forward 실패(index lock' || MRC=1 ;;
    N-ahead-sleep) WHAT="앞섬 exit 7 앞에 sleep 3"; CASES="r3-ahead"
         mutate $FF '    exit 7' '    sleep 3; exit 7' || MRC=1 ;;
    C2-4rp) WHAT="루프 비교를 구 형태로(rev-parse 실패를 빈 값 비교)"; CASES="r8-revparse"
         mutate $FF '  head="$(git rev-parse HEAD)" || git_fail "rev-parse HEAD"
  remote="$(git rev-parse "$REMOTE")" || git_fail "rev-parse $REMOTE"' '  head="$(git rev-parse HEAD)"
  remote="$(git rev-parse "$REMOTE")"' || MRC=1 ;;
    C2-4rl) WHAT="rev-list 실패를 받지 않음(구 형태)"; CASES="r8-revlist"
         mutate $FF 'ahead="$(git rev-list --count "$REMOTE..HEAD")" || git_fail "rev-list $REMOTE..HEAD"' 'ahead="$(git rev-list --count "$REMOTE..HEAD")"' || MRC=1
         mutate $FF 'behind="$(git rev-list --count "HEAD..$REMOTE")" || git_fail "rev-list HEAD..$REMOTE"' 'behind="$(git rev-list --count "HEAD..$REMOTE")"' || MRC=1 ;;
    C2-6) WHAT="그새 최신 경로에서 미커밋 재확인·별 문구 제거(구 형태: ff 성공으로 말함)"; CASES="r1-caughtup r1-caughtup-clean"
         mutate $FF '  if same_as_remote; then caught_up_exit; fi' '  if same_as_remote; then return 0; fi' || MRC=1 ;;
    C2-9) WHAT="lsof stderr 무시(종료코드 1 이면 「없음」)"; CASES="r2-lsofstderr"
         mutate $FF 'if [ "$rc" = 1 ] && [ -z "$err" ]; then echo' 'if [ "$rc" = 1 ]; then echo' || MRC=1 ;;
    C2-7) WHAT="release.sh 호출부가 3·7 에도 ⚠ 경고"; CASES="e2e-dirty"
         mutate scripts/release.sh '    0|3|7) ;;' '    0) ;;' || MRC=1 ;;
    T6b) KIND=vitest; WHAT="탐색기 runGitStatus 가 억제 없는 인자로 호출"
         mutate app/src/main/explorer-hub.ts "execFile('git', ['-C', cwd, ...GIT_STATUS_ARGS]" "execFile('git', ['-C', cwd, ...GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks')]" || MRC=1 ;;
    T6-tree) KIND=vitest; WHAT="트리 골격 getGitStatus 가 억제 없는 인자로 호출"
         mutate app/src/main/git-status.ts "await run('git', ['-C', worktreePath, ...GIT_STATUS_ARGS]" "await run('git', ['-C', worktreePath, ...GIT_STATUS_ARGS.filter((arg) => arg !== '--no-optional-locks')]" || MRC=1 ;;
    INFRA) WHAT="(변이 없음) 러너가 모르는 케이스로 실패 — 판정불가로 나오는지 보는 인프라 대조"; CASES="no-such-case" ;;
    *) echo "모르는 변이 $ID" >&2; exit 64 ;;
  esac
  {
    echo "## $ID — $WHAT ($(date '+%F %T'))"
    echo "--- 변이 diff(사본 원본 대비)"; for f in $FILES; do diff -u "$T/pristine/$f" "$T/$f"; done
  } > "$LOG"
  if [ "$MRC" != 0 ]; then echo "$ID 적용 실패 — $WHAT" | tee -a "$SUMMARY"; continue; fi
  if [ "$KIND" = ff ]; then
    echo "\$ <사본>/app/scripts/l672/ff-test.sh <tmp> $CASES" >> "$LOG"
    "$T/app/scripts/l672/ff-test.sh" "$OUT/$ID-run" $CASES >> "$LOG" 2>&1; RC=$?
    FAILN="$(cat "$OUT/$ID-run/"*.txt 2>/dev/null | grep -c '^  FAIL ')"
    grep -h '^  FAIL ' "$OUT/$ID-run/"*.txt >> "$LOG" 2>/dev/null
  else
    echo "\$ (사본 app) npx vitest run src/main/git-optional-locks.test.ts" >> "$LOG"
    (cd "$T/app" && npx vitest run src/main/git-optional-locks.test.ts) >> "$LOG" 2>&1; RC=$?
    FAILN="$(grep -E '^ +Tests +[0-9]+ failed' "$LOG" | sed -E 's/^ +Tests +([0-9]+) failed.*/\1/' | head -1)"
    FAILN="${FAILN:-0}"
  fi
  if [ "$RC" = 0 ]; then V="생존"
  elif [ "$FAILN" -ge 1 ]; then V="잡힘"
  else V="판정불가"; fi
  echo "시험 종료코드 $RC · FAIL 줄 $FAILN → $V" >> "$LOG"
  echo "$ID $V (종료코드 $RC · FAIL $FAILN) — $WHAT" | tee -a "$SUMMARY"
done
echo "작업 트리 무접촉: 원본 release-ff.sh sha1 $(shasum "$SRC/scripts/release-ff.sh" | cut -c1-12) · release.sh sha1 $(shasum "$SRC/scripts/release.sh" | cut -c1-12)" | tee -a "$SUMMARY"
