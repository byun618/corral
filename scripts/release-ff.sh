#!/usr/bin/env bash
# release-ff.sh --repo <본체 checkout> [--base main] [--tag <태그>]
# 출고 4단계 (LIFE-672) — 본체 checkout 이 base 이고 깨끗하면 origin/<base> 로 fast-forward 한다.
# release.sh 가 이 스크립트를 부른다. 실제 출고 없이 4단계만 따로 돌릴 때도 이 스크립트를 그대로 쓴다.
#
# index.lock 대기: 총 30초 · 0.5초 간격 — 관측한 lock 유지는 중앙값 0.13초·최대 1.55초(설치본 corral 의 주기 git status,
# LIFE-672 00-analysis F1). 30초를 넘게 남아 있는 lock 은 남은 lock 으로 보고 사람에게 넘긴다.
# 재시도는 lock 때문일 때만 한다 — 갈라짐·앞섬·로컬 변경·fetch 실패는 바로 원인을 말하고 끝낸다.
# 원인은 git 문구 접두(error:/fatal:)가 아니라 lock 파일 존재·조상 관계(merge-base --is-ancestor)로 가린다.
# **lock 은 지우지 않는다** — 경로·나이·크기·열고 있는 프로세스만 보여 주고 사람이 판단한다(남의 git 작업을 깨지 않게).
# git 값은 변수로 먼저 받고 실패하면 exit 8 로 끝낸다 — 함수가 if·|| 안에서 불려 set -e 가 꺼져 있어도 빈 값으로 판정하지 않게.
#
# 종료코드: 0 ff 했거나 이미(그새) 최신 · 2 index.lock 이 끝내 안 풀림 · 3 base 가 아니거나 미커밋 · 4 fetch 실패(origin/<base> 없음 포함)
#           5 갈라짐 · 6 그 밖의 ff 실패(ref lock·index 새로 쓰기 실패 등, git 첫 줄을 보여 준다) · 7 로컬이 앞섬만(ff 할 것 없음)
#           8 git 조회 오류 · 64 인자 오류
# 출력은 release.sh 의 note 와 같은 「· 」 줄이다.
set -euo pipefail
# --repo 가 이기게 — 바깥 git 환경변수가 다른 레포·index 를 가리키면 그쪽을 보거나 ff 하게 된다
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

WAIT_TOTAL_S=30
WAIT_STEP_S=0.5
WAIT_MAX_STEPS=60 # WAIT_TOTAL_S / WAIT_STEP_S

note() { echo "· $1"; }
first_line() { echo "$1" | grep -v '^$' | head -1 || true; }

REPO=""; BASE="main"; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo 값 없음}"; shift 2 ;;
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --tag) TAG="${2:?--tag 값 없음}"; shift 2 ;;
    *) echo "✖ 모르는 인자: $1" >&2; exit 64 ;;
  esac
done
[ -n "$REPO" ] || { echo "✖ 사용법: release-ff.sh --repo <본체 checkout> [--base main] [--tag <태그>]" >&2; exit 64; }
cd "$REPO"
TO="${TAG:-origin/$BASE}"
WHO="본체 브랜치 $BASE"

# 문구는 stderr 로 — 명령 치환 안에서 불려도 사라지지 않게
git_fail() { note "⚠ $WHO fast-forward 못 함 — git 조회가 실패해 상태를 가리지 못했다(git $1)" >&2; exit 8; }

# 미커밋 변경 줄 — 이 스크립트의 git status 는 optional lock 을 잡지 않는다(대기 중인 lock 경합을 스스로 만들지 않게)
dirty_lines() { git --no-optional-locks status --porcelain || git_fail "status"; }

CUR="$(git branch --show-current)" || git_fail "branch --show-current"
if [ "$CUR" != "$BASE" ]; then
  note "본체 checkout 은 ${CUR:-(detached HEAD)} 브랜치 — 기준 브랜치($BASE)가 아니어서 fast-forward 하지 않음"
  exit 3
fi
DIRTY="$(dirty_lines)" || exit 8
if [ -n "$DIRTY" ]; then
  note "본체 checkout 에 미커밋 변경 $(echo "$DIRTY" | wc -l | tr -d ' ')건 — fast-forward 하지 않음(git status)"
  exit 3
fi

if ! FETCH_ERR="$(git fetch -q origin "$BASE" 2>&1)"; then
  note "⚠ origin 에서 브랜치 $BASE 를 가져오지 못했다(fetch 실패) — $WHO 은 그대로. $(first_line "$FETCH_ERR")"
  exit 4
fi
REMOTE="refs/remotes/origin/$BASE"
if ! git rev-parse -q --verify "$REMOTE^{commit}" >/dev/null; then
  note "⚠ fetch 뒤에도 원격 추적 ref 가 없다: $REMOTE (remote.origin.fetch 설정 확인) — $WHO 은 그대로"
  exit 4
fi

LOCK="$(git rev-parse --path-format=absolute --git-path index.lock)" || git_fail "rev-parse --git-path index.lock"

# same_as_remote → 0 HEAD = origin · 1 다름. git 실패는 exit 8
same_as_remote() {
  local head remote
  head="$(git rev-parse HEAD)" || git_fail "rev-parse HEAD"
  remote="$(git rev-parse "$REMOTE")" || git_fail "rev-parse $REMOTE"
  [ "$head" = "$remote" ]
}

# is_ancestor <a> <b> → 0 조상 · 1 아님. git 오류(그 밖의 종료코드)는 원인 판별 불가로 끝낸다
is_ancestor() {
  local rc=0
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null || rc=$?
  case "$rc" in
    0|1) return "$rc" ;;
    *) note "⚠ $WHO fast-forward 못 함 — git merge-base 가 종료코드 $rc 로 실패해 원인을 가리지 못했다"; exit 8 ;;
  esac
}

# HEAD 가 origin 의 조상이 아니면(앞섬만 또는 갈라짐) 기다려도 안 풀린다 — 원인을 말하고 끝낸다
not_behind_exit() {
  local ahead behind
  ahead="$(git rev-list --count "$REMOTE..HEAD")" || git_fail "rev-list $REMOTE..HEAD"
  behind="$(git rev-list --count "HEAD..$REMOTE")" || git_fail "rev-list HEAD..$REMOTE"
  if [ "$behind" = 0 ]; then
    note "⚠ $WHO 이 origin/$BASE 브랜치보다 ${ahead}커밋 앞섬 — origin 에 없는 로컬 커밋이다. fast-forward 할 것 없음(git log origin/$BASE..$BASE)"
    exit 7
  fi
  note "⚠ $WHO 이 origin/$BASE 브랜치와 갈라졌다 — 로컬만 있는 커밋 ${ahead}개(앞섬) · origin 만 있는 커밋 ${behind}개(뒤짐). fast-forward 하지 않음(git log origin/$BASE..$BASE)"
  exit 5
}

# 열고 있는 프로세스 — lsof 로 본다. 종료코드 1 + stderr 없음 = 「없음」(이 계정에서 보이는 프로세스 한정), 그 밖은 확인 불가
lock_holders() {
  local res rc pids err pid line=""
  command -v lsof >/dev/null 2>&1 || { echo "확인 불가(lsof 없음)"; return; }
  res="$(lsof -t -- "$LOCK" 2>&1; echo "rc=$?")"
  rc="$(echo "$res" | sed -n 's/^rc=//p' | tail -1)"
  pids="$(echo "$res" | grep -E '^[0-9]+$' || true)"
  err="$(echo "$res" | grep -vE '^[0-9]+$|^rc=' || true)"
  if [ -z "$pids" ]; then
    if [ "$rc" = 1 ] && [ -z "$err" ]; then echo "없음(이 계정에서 보이는 프로세스 중)"
    else echo "확인 불가(lsof 종료코드 $rc${err:+ · $(first_line "$err" | cut -c1-80)})"; fi
    return
  fi
  for pid in $pids; do
    line="$line${line:+ / }pid $pid $(ps -o command= -p "$pid" 2>/dev/null | tr '\n' ' ' | cut -c1-160)"
  done
  echo "$line"
}

waited() { echo "index.lock 대기 ${STEPS}회·$((SECONDS - T0))초, ff 시도 ${TRIES}회"; }

lock_note() {
  local mtime size now
  mtime="$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null || true)"
  size="$(stat -f %z "$LOCK" 2>/dev/null || stat -c %s "$LOCK" 2>/dev/null || true)"
  now="$(date +%s)"
  note "⚠ $WHO fast-forward 못 함 — index.lock 이 풀리지 않았다($(waited))"
  if [ -z "$mtime" ]; then
    note "  lock: $LOCK · 방금 사라졌다(나이·크기를 읽기 전에) — 다시 돌리면 된다: $0 --repo '$REPO' --base $BASE"
    return
  fi
  note "  lock: $LOCK · 나이 $((now - mtime))초(mtime 기준) · 크기 ${size:-?}바이트 · 열고 있는 프로세스: $(lock_holders)"
  note "  스크립트는 lock 을 지우지 않는다 — 다른 git 작업이 없는지 확인 후 사람이 지운다. 그 뒤: git -C '$REPO' merge --ff-only origin/$BASE"
}

# 대기 중 다른 git 작업이 HEAD 를 origin 으로 옮겼다 — 우리가 ff 한 것이 아니다. 작업 트리가 따라왔는지 다시 본다
caught_up_exit() {
  local dirty
  dirty="$(dirty_lines)" || exit 8
  if [ -n "$dirty" ]; then
    note "⚠ $WHO 은 기다리는 동안 다른 git 작업으로 origin 과 같아졌지만 미커밋 변경 $(echo "$dirty" | wc -l | tr -d ' ')건이 보인다 — HEAD 만 옮겨졌을 수 있다(git status)"
    exit 3
  fi
  note "$WHO 은 기다리는 동안 다른 git 작업으로 그새 최신($TO)이 됐다 — 이 스크립트는 ff 하지 않음($(waited))"
  exit 0
}

# try_ff → 0 ff 됨 · 1 lock 때문에 못 함(기다릴 것) · 원인이 따로 있으면 여기서 끝낸다(그새 최신 포함)
try_ff() {
  if same_as_remote; then caught_up_exit; fi
  is_ancestor HEAD "$REMOTE" || not_behind_exit
  [ ! -e "$LOCK" ] || return 1
  TRIES=$((TRIES + 1))
  if LAST_ERR="$(git merge -q --ff-only "$REMOTE" 2>&1)"; then return 0; fi
  # 실패 — lock 이 지금 있거나 git 이 index lock 을 못 잡았다고 했으면 lock 경합으로 보고 기다린다.
  # 'Unable to write index' 는 게이트 ⓪ 에서 넣은 방어(주입 시험 문구) — git 2.50.1 ff 경로의 실제 문구가 아니다.
  # 실제 ff 경로 문구 'unable to write new index file' 은 작업 트리가 이미 바뀐 뒤라 재시도하지 않는다(exit 6)
  if [ -e "$LOCK" ] || echo "$LAST_ERR" | grep -qE 'index\.lock|Unable to write index'; then return 1; fi
  is_ancestor HEAD "$REMOTE" || not_behind_exit
  note "⚠ $WHO fast-forward 실패(index lock·갈라짐 아님 — ref lock·index 새로 쓰기 실패·로컬 변경 겹침 등) — git: $(first_line "$LAST_ERR")"
  exit 6
}

TRIES=0; STEPS=0; T0=$SECONDS; LAST_ERR=""
if same_as_remote; then
  note "$WHO 은 이미 최신($TO) — fast-forward 할 것 없음"
  exit 0
fi
while :; do
  if try_ff; then
    if [ "$STEPS" = 0 ] && [ "$TRIES" -le 1 ]; then note "$WHO fast-forward → $TO"
    else note "$WHO fast-forward → $TO — $(waited)"; fi
    exit 0
  fi
  # 0.5초 × 60회를 채우면 포기한다. git 호출이 느려 늘어지는 경우를 위해 초 단위 상한(+1초)도 둔다
  if [ "$STEPS" -ge "$WAIT_MAX_STEPS" ] || [ $((SECONDS - T0)) -gt "$WAIT_TOTAL_S" ]; then break; fi
  if [ "$STEPS" = 0 ]; then note "본체 index.lock 이 잡혀 있다 — 최대 ${WAIT_TOTAL_S}초 기다린다(${WAIT_STEP_S}초 간격)"; fi
  STEPS=$((STEPS + 1))
  sleep "$WAIT_STEP_S"
done

# 상한 — 그 사이 lock 이 사라졌으면 한 번 더 해 본다
if [ ! -e "$LOCK" ] && try_ff; then
  note "$WHO fast-forward → $TO — 상한에 닿은 뒤 마지막 시도로 됐다($(waited))"
  exit 0
fi
if [ -e "$LOCK" ]; then lock_note; exit 2; fi
note "⚠ $WHO fast-forward 실패 — 기다리는 동안 index 를 쓰지 못했다($(waited), 지금은 lock 없음). git: $(first_line "$LAST_ERR")"
exit 2
