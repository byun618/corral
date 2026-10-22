#!/usr/bin/env bash
# release-ff.sh --repo <본체 checkout> [--base main] [--tag <태그>]
# 출고 4단계 (LIFE-672) — 본체 checkout 이 base 이고 깨끗하면 origin/<base> 로 fast-forward 한다.
# release.sh 가 이 스크립트를 부른다. 실제 출고 없이 4단계만 따로 돌릴 때도 이 스크립트를 그대로 쓴다.
#
# index.lock 대기: 총 30초 · 0.5초 간격 — 관측한 lock 유지는 중앙값 0.13초·최대 1.55초(설치본 corral 의 주기 git status,
# LIFE-672 00-analysis F1). 30초를 넘게 남아 있는 lock 은 남은 lock 으로 보고 사람에게 넘긴다.
# 재시도는 lock 때문일 때만 한다 — 갈라짐·로컬 변경·fetch 실패는 바로 원인을 말하고 끝낸다.
# 원인은 git 문구 접두(error:/fatal:)가 아니라 lock 파일 존재·조상 관계(merge-base --is-ancestor)로 가린다.
# **lock 은 지우지 않는다** — 경로·나이·크기·열고 있는 프로세스만 보여 주고 사람이 판단한다(남의 git 작업을 깨지 않게).
#
# 종료코드: 0 ff 했거나 이미 최신 · 2 lock 이 끝내 안 풀림 · 3 base 가 아니거나 미커밋 · 4 fetch 실패 · 5 갈라짐 · 6 그 밖의 ff 실패
# 출력은 release.sh 의 note 와 같은 「· 」 줄이다.
set -euo pipefail

WAIT_TOTAL_S=30
WAIT_STEP_S=0.5
WAIT_MAX_STEPS=60 # WAIT_TOTAL_S / WAIT_STEP_S

note() { echo "· $1"; }

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

# 이 스크립트의 git status 는 optional lock 을 잡지 않는다 — 대기 중인 lock 경합을 스스로 만들지 않게
CUR="$(git branch --show-current)"
if [ "$CUR" != "$BASE" ]; then
  note "본체 checkout 은 ${CUR:-(detached HEAD)} — $BASE 가 아니라 fast-forward 하지 않음"
  exit 3
fi
DIRTY="$(git --no-optional-locks status --porcelain)"
if [ -n "$DIRTY" ]; then
  note "본체 checkout 에 미커밋 변경 $(echo "$DIRTY" | wc -l | tr -d ' ')건 — fast-forward 하지 않음(git status)"
  exit 3
fi

if ! FETCH_ERR="$(git fetch -q origin "$BASE" 2>&1)"; then
  note "⚠ origin 에서 $BASE 를 가져오지 못했다(fetch 실패) — 본체 $BASE 는 그대로. $(echo "$FETCH_ERR" | grep -v "^$" | head -1)"
  exit 4
fi

LOCK="$(git rev-parse --path-format=absolute --git-path index.lock)"
REMOTE="refs/remotes/origin/$BASE"

# 갈라짐: 로컬에 origin 에 없는 커밋이 있다 — 기다려도 안 풀린다
diverged_note() {
  local ahead behind
  ahead="$(git rev-list --count "$REMOTE..HEAD")"
  behind="$(git rev-list --count "HEAD..$REMOTE")"
  note "⚠ 본체 $BASE 가 origin/$BASE 와 갈라졌다 — 로컬만 있는 커밋 ${ahead}개(앞섬) · origin 만 있는 커밋 ${behind}개(뒤짐). fast-forward 하지 않음(git log origin/$BASE..$BASE)"
}

# 열고 있는 프로세스 — lsof 로 본다. 없으면 「없음」, lsof 가 없으면 확인 불가
lock_holders() {
  local out pid line
  command -v lsof >/dev/null 2>&1 || { echo "확인 불가(lsof 없음)"; return; }
  out="$(lsof -t -- "$LOCK" 2>/dev/null || true)"
  [ -n "$out" ] || { echo "없음"; return; }
  line=""
  for pid in $out; do
    line="$line${line:+ / }pid $pid $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-160)"
  done
  echo "$line"
}

lock_note() {
  local mtime size now
  if mtime="$(stat -f %m "$LOCK" 2>/dev/null)"; then size="$(stat -f %z "$LOCK" 2>/dev/null)"
  else mtime="$(stat -c %Y "$LOCK" 2>/dev/null)"; size="$(stat -c %s "$LOCK" 2>/dev/null)"; fi
  now="$(date +%s)"
  note "⚠ 본체 $BASE fast-forward 못 함 — index.lock 이 ${WAIT_TOTAL_S}초 동안 풀리지 않았다(${1}회 시도)"
  note "  lock: $LOCK · 나이 $((now - ${mtime:-$now}))초(mtime 기준) · 크기 ${size:-?}바이트 · 열고 있는 프로세스: $(lock_holders)"
  note "  스크립트는 lock 을 지우지 않는다 — 다른 git 작업이 없는지 확인 후 사람이 지운다. 그 뒤: git -C '$REPO' merge --ff-only origin/$BASE"
}

TRIES=0; STEPS=0; T0=$SECONDS; LAST_ERR=""
while :; do
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "$REMOTE")" ]; then
    if [ "$TRIES" = 0 ] && [ "$STEPS" = 0 ]; then note "본체 $BASE 는 이미 최신($TO) — fast-forward 할 것 없음"
    else note "본체 $BASE 는 그새 최신이 됐다($TO) — index.lock 대기 ${STEPS}회·$((SECONDS - T0))초"; fi
    exit 0
  fi
  if ! git merge-base --is-ancestor HEAD "$REMOTE"; then
    diverged_note
    exit 5
  fi
  if [ ! -e "$LOCK" ]; then
    TRIES=$((TRIES + 1))
    if LAST_ERR="$(git merge -q --ff-only "$REMOTE" 2>&1)"; then
      if [ "$STEPS" = 0 ]; then note "본체 $BASE fast-forward → $TO"
      else note "본체 $BASE fast-forward → $TO — index.lock 대기 ${STEPS}회·$((SECONDS - T0))초, ff 시도 ${TRIES}회"; fi
      exit 0
    fi
    # 실패 — lock 경합인지 본다. lock 이 지금 있거나 git 이 index 를 못 썼다고 했고, HEAD 가 아직 origin 의 조상이면 다시 기다린다
    if [ ! -e "$LOCK" ] && ! echo "$LAST_ERR" | grep -qE 'index\.lock|Unable to write index'; then
      git merge-base --is-ancestor HEAD "$REMOTE" || { diverged_note; exit 5; }
      note "⚠ 본체 $BASE fast-forward 실패(lock·갈라짐 아님) — 로컬 변경과 겹치는지 본다(git status). git: $(echo "$LAST_ERR" | grep -v '^$' | head -1)"
      exit 6
    fi
  fi
  # 0.5초 × 60회를 채우면 포기한다. git 호출이 느려 늘어지는 경우를 위해 초 단위 상한(+1초)도 둔다
  if [ "$STEPS" -ge "$WAIT_MAX_STEPS" ] || [ $((SECONDS - T0)) -gt "$WAIT_TOTAL_S" ]; then
    if [ -e "$LOCK" ]; then lock_note "$TRIES"; exit 2; fi
    note "⚠ 본체 $BASE fast-forward 실패 — ${WAIT_TOTAL_S}초 동안 index 를 쓰지 못했다(지금은 lock 없음). git: $(echo "$LAST_ERR" | grep -v '^$' | head -1)"
    exit 2
  fi
  if [ "$STEPS" = 0 ]; then note "본체 index.lock 이 잡혀 있다 — 최대 ${WAIT_TOTAL_S}초 기다린다(${WAIT_STEP_S}초 간격)"; fi
  STEPS=$((STEPS + 1))
  sleep "$WAIT_STEP_S"
done
