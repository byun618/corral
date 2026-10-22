#!/usr/bin/env bash
# LIFE-672 빠른 확인 — scripts/release-ff.sh(출고 4단계)를 임시 레포에서 원인별로 돌린다. 실제 출고·본체 checkout 무접촉.
# app/scripts/l672/ff-test.sh <원자료 폴더> [케이스 …]   (케이스 생략 = 전부, 목록은 ALL)
# 임시 레포 = bare origin + clone(main 이 origin 보다 1커밋 뒤). lock 쥐개 = clone 의 .git/index.lock 을 O_EXCL 로 만들어 열어 둔 python —
# 놓을 때(시간이 됐거나 SIGTERM) lock 이 자기가 만든 그대로인지(inode·mtime) 기록한다.
# release-ff.sh 는 git shim 을 거쳐 돈다 — shim 은 argv 를 기록하고(스크립트 자신의 status 에 --no-optional-locks 가 있는지 본다),
# 케이스에 따라 첫 merge 직전 lock 생성(TOCTOU)·「Unable to write index.」 주입(실제 ff 경로 문구가 아닌 방어용 주입)·실제 ff 경로 문구
# 「unable to write new index file」·상한 뒤 마지막 시도만 통과·merge-base/rev-parse/rev-list 실패·merge 실패 사이 원격 갈라짐을 흉내 낸다.
# e2e = 실제 scripts/release.sh 를 가짜 gh 로 임시 레포에서 끝까지 돌린다(4단계 lock 실패 → 경고 뒤 5·6단계·「✔ 출고」).
# **판정 회차는 직렬로 돌린다** — 한 번에 이 스크립트 하나, 다른 무거운 작업과 겹치지 않게(쥐개 2초·30초 상한 케이스가 부하에 민감하다).
# 임시 폴더는 TMPDIR 과 무관하게 /tmp/l672ff.XXXXXX(짧은 고정 접두) — 문구의 경로 길이가 환경마다 달라지지 않게.
set -uo pipefail

ALL="r1a r1-toctou r1-unable-injected r1-final r1-caughtup r1-caughtup-clean r2a r2b r2-vanish r2-lsoferr r2-lsofstderr r2-noindex r3a r3a-lock r3-ahead r3b r3-noref r3d-dirty r3d-branch r3e r3-reflock r3-newindex r3-postdiverge r8-mergebase r8-revparse r8-revlist r8-status r8-branch r8-gitpath r-gitdir r-gitindex r-linked r1-tagdiff r2-lsofdigit e2e e2e-ff e2e-dirty e2e-ahead e2e-noff"
OUT="${1:?원자료 폴더}"; shift
CASES="${*:-$ALL}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FF="$ROOT/scripts/release-ff.sh"
REAL_GIT="$(command -v git)"
mkdir -p "$OUT" "${TMPDIR:-/tmp}" || exit 1
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d /tmp/l672ff.XXXXXX)" || { echo "mktemp 실패 — /tmp 확인" >&2; exit 1; }
HOLDER=""
cleanup() {
  [ -n "$HOLDER" ] && kill "$HOLDER" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
PIDS="$OUT/helper-pids.txt"
SUMMARY="$OUT/summary.txt"
: > "$PIDS"; : > "$SUMMARY"
echo "# ff-test $(date '+%F %T') · git $(git --version | cut -d' ' -f3-) · work $WORK · release-ff.sh sha1 $(shasum "$FF" | cut -c1-12) · ff-test.sh sha1 $(shasum "${BASH_SOURCE[0]}" | cut -c1-12)" | tee -a "$SUMMARY"

g() { "$REAL_GIT" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

# ── shim (케이스마다 SHIM 폴더를 PATH 앞에 둔다) ──
SHIM="$WORK/shim"; mkdir -p "$SHIM"
cat > "$SHIM/git" <<EOF
#!/bin/bash
# git shim — argv 기록 + SHIM_MODE 주입
echo "\$*" >> "\$SHIM_LOG"
case "\${SHIM_MODE:-}" in
  mbfail) # merge-base 만 git 오류(128)
    case " \$* " in *" merge-base "*) echo "fatal: 흉내 merge-base 오류" >&2; exit 128 ;; esac ;;
  rpfail) # merge-base 가 한 번 불린 뒤부터 rev-parse 는 전부 실패
    case " \$* " in *" merge-base "*) touch "\$SHIM_STATE/mb" ;; esac
    case " \$* " in *" rev-parse "*) if [ -e "\$SHIM_STATE/mb" ]; then echo "fatal: 흉내 rev-parse 오류" >&2; exit 128; fi ;; esac ;;
  stfail) # status 는 전부 실패
    case " \$* " in *" status "*) echo "fatal: 흉내 status 오류" >&2; exit 128 ;; esac ;;
  brfail) # branch 는 전부 실패
    case " \$* " in *" branch "*) echo "fatal: 흉내 branch 오류" >&2; exit 128 ;; esac ;;
  gpfail) # rev-parse --git-path 는 실패
    case " \$* " in *" --git-path "*) echo "fatal: 흉내 --git-path 오류" >&2; exit 128 ;; esac ;;
  rlfail) # rev-list 는 전부 실패
    case " \$* " in *" rev-list "*) echo "fatal: 흉내 rev-list 오류" >&2; exit 128 ;; esac ;;
esac
case " \$* " in *" merge "*)
  n=\$(( \$(cat "\$SHIM_STATE/merges" 2>/dev/null || echo 0) + 1 )); echo \$n > "\$SHIM_STATE/merges"
  case "\${SHIM_MODE:-}" in
    toctou) # 첫 merge 직전에 lock 을 만들어 2초 쥔다(스크립트의 lock 확인은 이미 지난 뒤)
      if [ \$n = 1 ]; then
        python3 "\$SHIM_HOLD" "\$SHIM_LOCK" 2 "\$SHIM_STATE/holder.txt" </dev/null >/dev/null 2>&1 &  # 명령 치환 파이프를 물지 않게
        echo "toctou holder pid \$!" >> "\$SHIM_PIDS"
        i=0; while [ ! -e "\$SHIM_LOCK" ] && [ \$i -lt 100 ]; do sleep 0.02; i=\$((i + 1)); done
      fi ;;
    unable) # 첫 merge 만 index 를 못 썼다고 실패(lock 파일 없음)
      if [ \$n = 1 ]; then echo "error: Unable to write index." >&2; exit 128; fi ;;
    always) # 모든 merge 가 lock 파일 없이 index 를 못 썼다고 실패 — 상한까지 간다
      echo "error: Unable to write index." >&2; exit 128 ;;
    newindex) # 실제 git 2.50.1 ff 경로의 index 쓰기 실패 문구 — 재시도하지 않아야 한다
      echo "error: unable to write new index file" >&2; exit 1 ;;
    postdiverge) # 첫 merge 가 실패하는 사이 원격이 갈라진다(origin/main 을 무관한 커밋으로 옮김)
      if [ \$n = 1 ]; then
        t=\$("$REAL_GIT" rev-parse "HEAD^{tree}"); c=\$(echo x | "$REAL_GIT" -c user.name=t -c user.email=t@t commit-tree "\$t")
        "$REAL_GIT" update-ref refs/remotes/origin/main "\$c"
        echo "error: 흉내 merge 실패" >&2; exit 1
      fi ;;
    final) # 바로 앞에 sleep 이 있었던 merge(대기 루프 안)는 전부 실패 — sleep 없이 이어진 merge(상한 뒤 마지막 시도)만 통과
      if [ \$n = 1 ] || [ -e "\$SHIM_STATE/slept" ]; then rm -f "\$SHIM_STATE/slept"; echo "error: Unable to write index." >&2; exit 128; fi ;;
  esac ;;
esac
exec "$REAL_GIT" "\$@"
EOF
mkdir -p "$WORK/shim-final" "$WORK/shim-vanish" "$WORK/shim-lsoferr" "$WORK/shim-lsofstderr" "$WORK/shim-lsofdigit"
cat > "$WORK/shim-final/sleep" <<'EOF'
#!/bin/bash
touch "$SHIM_STATE/slept"; exec /bin/sleep 0.01
EOF
cat > "$WORK/shim-vanish/stat" <<'EOF'
#!/bin/bash
# 타임아웃 순간 lock 이 사라지는 경우 — 첫 stat 호출 직전에 lock 을 치운다(쥔 쪽이 놓은 것을 흉내, 임시 레포 안)
if [ ! -e "$SHIM_STATE/vanished" ]; then touch "$SHIM_STATE/vanished"; rm -f "$SHIM_LOCK"; fi
exec /usr/bin/stat "$@"
EOF
cat > "$WORK/shim-lsoferr/lsof" <<'EOF'
#!/bin/bash
echo "lsof: 흉내 낸 오류" >&2; exit 2
EOF
cat > "$WORK/shim-lsofstderr/lsof" <<'EOF'
#!/bin/bash
# 종료코드는 「일치 없음」 과 같은 1 이지만 stderr 에 오류가 있다(없는 경로·잘못된 옵션 등)
echo "lsof: status error on 흉내: No such file or directory" >&2; exit 1
EOF
cat > "$WORK/shim-lsofdigit/lsof" <<'EOF'
#!/bin/bash
# stdout 은 비고 stderr 에 숫자만 있는 줄 — pid 로 세면 안 된다
echo "424242" >&2; exit 1
EOF
HOLD_PY="$WORK/hold.py"
cat > "$HOLD_PY" <<'EOF'
# hold.py <lock> <초> <결과 파일> — git 처럼 O_EXCL 로 만들어 쥐고, 놓을 때 lock 이 그대로인지 기록한 뒤 스스로 놓는다(임시 레포 안)
import os, signal, sys, time
path, secs, result = sys.argv[1], float(sys.argv[2]), sys.argv[3]
fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
st = os.fstat(fd)
def release(*_):
    try:
        now = os.stat(path)
        same = now.st_ino == st.st_ino and now.st_mtime_ns == st.st_mtime_ns
        msg = f"intact ino {st.st_ino}" if same else f"CHANGED ino {st.st_ino}->{now.st_ino} mtime {st.st_mtime_ns}->{now.st_mtime_ns}"
    except FileNotFoundError:
        msg = f"GONE ino {st.st_ino}"
    with open(result, "w") as f:
        f.write(msg + "\n")
    os.close(fd)
    if not msg.startswith("GONE"):
        os.unlink(path)
    sys.exit(0)
signal.signal(signal.SIGTERM, release)
time.sleep(secs)
release()
EOF
chmod +x "$SHIM/git" "$WORK/shim-final/sleep" "$WORK/shim-vanish/stat" "$WORK/shim-lsoferr/lsof" "$WORK/shim-lsofstderr/lsof" "$WORK/shim-lsofdigit/lsof"

# mkrepo <이름> → $W/origin.git, $W/b (main 이 origin/main 보다 1커밋 뒤, origin/main 은 fetch 로 최신)
mkrepo() {
  W="$WORK/$1"; mkdir -p "$W/state"
  g init -q --bare -b main "$W/origin.git"
  g init -q -b main "$W/seed"
  echo one > "$W/seed/f.txt"; g -C "$W/seed" add f.txt; g -C "$W/seed" commit -qm one
  echo two >> "$W/seed/f.txt"; g -C "$W/seed" commit -qam two
  g -C "$W/seed" remote add origin "$W/origin.git"; g -C "$W/seed" push -q origin main
  g clone -q "$W/origin.git" "$W/b"
  g -C "$W/b" reset -q --hard HEAD~1
  B="$W/b"; LOCK="$B/.git/index.lock"
}

# hold <초> → 쥐개 PID 를 HOLDER 에. lock 을 만든 뒤에 돌아온다
hold() {
  python3 "$HOLD_PY" "$LOCK" "$1" "$W/state/holder.txt" &
  HOLDER=$!
  echo "$CASE holder pid $HOLDER hold ${1}s lock $LOCK" >> "$PIDS"
  local i=0; while [ ! -e "$LOCK" ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i + 1)); done
}

stopholder() {
  [ -n "$HOLDER" ] || return 0
  kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
  echo "$CASE holder pid $HOLDER stopped" >> "$PIDS"; HOLDER=""
}

lockstat() { stat -f '%i %m %z' "$1" 2>/dev/null || echo "없음"; }

# ff [env …] — shim 을 거쳐 release-ff.sh 를 돈다(extra PATH 는 XPATH)
ff() {
  run env PATH="${XPATH:+$XPATH:}$SHIM:$PATH" SHIM_LOG="$W/state/git-argv.txt" SHIM_STATE="$W/state" SHIM_LOCK="$LOCK" \
    SHIM_HOLD="$HOLD_PY" SHIM_PIDS="$PIDS" "$@" "$FF" --repo "${FF_REPO:-$B}" --base "${FF_BASE:-main}" ${FF_TAG:+--tag "$FF_TAG"}
}

# run → RC, ELAPSED(초, 소수). 출력은 $LOG 에 덧붙인다
run() {
  local t0 t1
  {
    echo "repo $B · before HEAD $(git -C "$B" rev-parse --short HEAD) origin/main $(git -C "$B" rev-parse -q --verify --short origin/main || echo 없음) · lock $(lockstat "$LOCK")"
    echo "\$ $*"
  } >> "$LOG"
  t0="$(python3 -c 'import time; print(time.time())')"
  "$@" >> "$LOG" 2>&1; RC=$?
  t1="$(python3 -c 'import time; print(time.time())')"
  ELAPSED="$(python3 -c "print(round($t1 - $t0, 2))")"
  echo "exit=$RC elapsed=${ELAPSED}s · after HEAD $(git -C "$B" rev-parse --short HEAD) · lock $(lockstat "$LOCK")" >> "$LOG"
}

FAILS=0
check() { # check <설명> <조건 명령…>
  local what="$1"; shift
  if "$@"; then echo "  ok   $what" >> "$LOG"; else echo "  FAIL $what" >> "$LOG"; FAILS=$((FAILS + 1)); CASE_FAIL=1; fi
}
has() { grep -qF -- "$1" "$LOG"; }
hasnt() { ! grep -qF -- "$1" "$LOG"; }
lt() { python3 -c "import sys; sys.exit(0 if $1 < $2 else 1)"; }
ge() { python3 -c "import sys; sys.exit(0 if $1 >= $2 else 1)"; }
head_is_origin() { [ "$(git -C "$B" rev-parse HEAD)" = "$(git -C "$B" rev-parse origin/main)" ]; }
head_unchanged() { [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]; }
holder_intact() { grep -q '^intact' "$W/state/holder.txt" 2>/dev/null; }
# 스크립트 자신의 status 는 전부 --no-optional-locks (status 호출이 1번 이상 있어야 한다 — 양성 대조)
status_suppressed() {
  local st; st="$(grep -E '(^| )status( |$)' "$W/state/git-argv.txt" 2>/dev/null)"
  [ -n "$st" ] && ! echo "$st" | grep -qv -- '--no-optional-locks'
}
realpath_of() { python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
# 비대칭 갈라짐: 로컬 2커밋 · origin 1커밋
diverge() {
  echo l1 > "$B/g.txt"; g -C "$B" add g.txt; g -C "$B" commit -qm l1
  echo l2 >> "$B/g.txt"; g -C "$B" commit -qam l2
  BEFORE="$(git -C "$B" rev-parse HEAD)"
}

for CASE in $CASES; do
  CASE_FAIL=0; HOLDER=""; XPATH=""; RC=""; ELAPSED=""; FF_REPO=""; FF_BASE=""; FF_TAG=""
  mkrepo "$CASE"
  LOG="$OUT/$CASE.txt"
  echo "## $CASE — $(date '+%F %T')" > "$LOG"
  BEFORE="$(git -C "$B" rev-parse HEAD)"
  case "$CASE" in
    r1a) # lock 을 2초 쥐었다 놓는다 → 기다렸다가 ff
      hold 2
      ff
      stopholder
      check "exit 0" [ "$RC" = 0 ]
      check "대기 사실 한 줄(index.lock 대기 N회·N초)" has "index.lock 대기"
      check "ff 문구" has "fast-forward → origin/main"
      check "HEAD = origin/main" head_is_origin
      check "1.5초 이상 기다렸다(쥐개 2초)" ge "$ELAPSED" 1.5
      check "쥐개의 lock 이 놓을 때까지 그대로(inode·mtime)" holder_intact
      check "스크립트의 status 는 전부 --no-optional-locks" status_suppressed
      ;;
    r1-toctou) # lock 확인 뒤 첫 merge 직전에 lock 이 생긴다(v0.3.1 형태) → merge 실패 → 다시 기다려 ff
      ff SHIM_MODE=toctou
      sleep 0.2
      check "exit 0" [ "$RC" = 0 ]
      check "ff 시도 2회(첫 시도는 lock 에 막힘)" has "ff 시도 2회"
      check "lock 이 풀릴 때까지 여러 번 기다렸다(대기 2회 이상)" grep -qE "index.lock 대기 ([2-9]|[1-9][0-9])회" "$LOG"
      check "대기 문구" has "index.lock 이 잡혀 있다"
      check "HEAD = origin/main" head_is_origin
      check "shim 쥐개의 lock 이 놓을 때까지 그대로(inode·mtime)" holder_intact
      check "스크립트의 status 는 전부 --no-optional-locks" status_suppressed
      ;;
    r1-unable-injected) # lock 파일 없이 git 이 「Unable to write index.」(주입 문구 — 실제 ff 경로 문구 아님)로 실패 → 다시 시도
      ff SHIM_MODE=unable
      check "exit 0" [ "$RC" = 0 ]
      check "ff 시도 2회" has "ff 시도 2회"
      check "HEAD = origin/main" head_is_origin
      check "갈라졌다·index lock 아님 문구 없음" hasnt "아님"
      ;;
    r1-final) # 대기 루프 안 merge 는 전부 실패, 상한 뒤 마지막 시도만 통과 → 포기하지 않고 ff
      XPATH="$WORK/shim-final"
      ff SHIM_MODE=final
      check "exit 0" [ "$RC" = 0 ]
      check "상한 뒤 마지막 시도 문구" has "상한에 닿은 뒤 마지막 시도로 됐다"
      check "대기 60회" has "index.lock 대기 60회"
      check "HEAD = origin/main" head_is_origin
      ;;
    r1-caughtup|r1-caughtup-clean) # lock 대기 중 다른 git 작업이 HEAD 를 origin 으로 옮긴다(update-ref) — 우리가 ff 한 것이 아니다
      # -clean: origin 의 새 커밋이 빈 커밋이라 작업 트리가 그대로 맞다 → 그새 최신 exit 0. 그 밖: 파일이 달라 미커밋으로 보인다 → exit 3
      if [ "$CASE" = r1-caughtup-clean ]; then
        g -C "$W/seed" commit -q --allow-empty -m empty; g -C "$W/seed" push -q origin main
        g -C "$B" fetch -q origin; g -C "$B" reset -q --hard origin/main~1; BEFORE="$(git -C "$B" rev-parse HEAD)"
      fi
      : > "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      (sleep 1.2; "$REAL_GIT" -C "$B" update-ref refs/heads/main refs/remotes/origin/main) &
      SIDE=$!; echo "$CASE side pid $SIDE (1.2초 뒤 update-ref)" >> "$PIDS"
      ff
      wait "$SIDE" 2>/dev/null; echo "$CASE side pid $SIDE done" >> "$PIDS"
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "HEAD = origin/main(다른 쪽이 옮김)" head_is_origin
      check "「fast-forward →」 로 말하지 않는다" hasnt "fast-forward →"
      check "ff 시도 0회" hasnt "ff 시도 1회"
      check "lock 그대로($BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      if [ "$CASE" = r1-caughtup-clean ]; then
        check "exit 0" [ "$RC" = 0 ]
        check "그새 최신 문구" has "그새 최신(origin/main)이 됐다 — 이 스크립트는 ff 하지 않음"
      else
        check "exit 3" [ "$RC" = 3 ]
        check "HEAD 만 옮겨졌을 수 있다 문구" has "HEAD 만 옮겨졌을 수 있다"
      fi
      ;;
    r2a) # 쥐개가 상한보다 오래(40초) 쥔다 → 30초(+2) 안에 포기, 쥐개 pid 가 문구에
      hold 40
      HPID="$HOLDER"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      ff
      AFTER_LOCK="$(lockstat "$LOCK")"
      stopholder
      check "exit 2" [ "$RC" = 2 ]
      check "30초 이상" ge "$ELAPSED" 30
      check "32초 미만(상한+2초 이내)" lt "$ELAPSED" 32
      check "lock 경로" has "lock: $(realpath_of "$LOCK")"
      check "나이(mtime 기준)" has "초(mtime 기준)"
      check "크기" has "크기 0바이트"
      check "열고 있는 프로세스 = 쥐개 pid $HPID" has "열고 있는 프로세스: pid $HPID "
      check "잰 대기 횟수·경과 문구(대기 N회·30초 넘음, ff 시도 0회)" grep -qE "index.lock 대기 [1-9][0-9]회·3[0-9]초, ff 시도 0회" "$LOG"
      check "지우지 않는다 문구" has "스크립트는 lock 을 지우지 않는다"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      check "쥐개의 lock 이 놓을 때까지 그대로(inode·mtime)" holder_intact
      check "HEAD 불변" head_unchanged
      check "스크립트의 status 는 전부 --no-optional-locks" status_suppressed
      ;;
    r2b) # 쥐개 없이 0바이트 lock 만(남은 lock) → 열고 있는 프로세스 없음
      : > "$LOCK"; touch -t "$(date -v-2H +%Y%m%d%H%M.%S)" "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      ff
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "exit 2" [ "$RC" = 2 ]
      check "30초 이상" ge "$ELAPSED" 30
      check "32초 미만" lt "$ELAPSED" 32
      check "열고 있는 프로세스: 없음(계정 한정 문구)" has "열고 있는 프로세스: 없음(이 계정에서 보이는 프로세스 중)"
      check "나이 2시간 근처(7200초대)" grep -qE '나이 72[0-9][0-9]초' "$LOG"
      check "지우지 않는다 문구" has "스크립트는 lock 을 지우지 않는다"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      check "HEAD 불변" head_unchanged
      ;;
    r2-vanish) # 상한에서 lock 문구를 쓰는 순간 lock 이 사라진다 → 무음으로 죽지 않고 문구가 나온다
      : > "$LOCK"
      XPATH="$WORK/shim-vanish"
      ff
      check "exit 2(목록 안)" [ "$RC" = 2 ]
      check "포기 문구" has "index.lock 이 풀리지 않았다"
      check "방금 사라졌다 문구" has "방금 사라졌다"
      check "HEAD 불변" head_unchanged
      ;;
    r2-lsoferr) # lsof 가 오류로 끝나면 「없음」 이 아니라 확인 불가
      : > "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      XPATH="$WORK/shim-lsoferr"
      ff
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "exit 2" [ "$RC" = 2 ]
      check "확인 불가(lsof 종료코드 2 · stderr)" has "열고 있는 프로세스: 확인 불가(lsof 종료코드 2 · lsof: 흉내 낸 오류)"
      check "「없음」 이 아니다" hasnt "열고 있는 프로세스: 없음"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      ;;
    r2-lsofstderr) # lsof 종료코드는 1(일치 없음과 같음)이지만 stderr 에 오류 → 「없음」 이 아니라 확인 불가
      : > "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      XPATH="$WORK/shim-lsofstderr"
      ff
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "exit 2" [ "$RC" = 2 ]
      check "확인 불가(lsof 종료코드 1 · stderr)" has "열고 있는 프로세스: 확인 불가(lsof 종료코드 1 · lsof: status error"
      check "「없음」 이 아니다" hasnt "열고 있는 프로세스: 없음"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      ;;
    r2-noindex) # lock 파일은 없는데 모든 merge 가 index 를 못 썼다고 실패 → 상한 뒤 마지막 시도도 실패 → exit 2(성공으로 끝나면 안 된다)
      XPATH="$WORK/shim-final"
      ff SHIM_MODE=always
      check "exit 2" [ "$RC" = 2 ]
      check "lock 없이 index 를 못 썼다는 문구" has "기다리는 동안 index 를 쓰지 못했다"
      check "지금은 lock 없음" has "지금은 lock 없음"
      check "git 첫 줄" has "git: error: Unable to write index."
      check "HEAD 불변" head_unchanged
      ;;
    r3a|r3a-lock) # 로컬 2커밋 · origin 1커밋 → 갈라짐(앞섬 2·뒤짐 1), 기다리지 않는다. -lock 은 0바이트 lock 까지 남겨 둔 채
      diverge
      [ "$CASE" = r3a-lock ] && : > "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      ff
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "exit 5" [ "$RC" = 5 ]
      check "갈라졌다 + 앞섬 2·뒤짐 1" has "로컬만 있는 커밋 2개(앞섬) · origin 만 있는 커밋 1개(뒤짐)"
      check "기다리지 않았다(2초 미만)" lt "$ELAPSED" 2
      check "lock 대기 문구 없음" hasnt "기다린다"
      check "HEAD 불변" head_unchanged
      check "lock 상태 그대로($BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      [ "$CASE" = r3a-lock ] && check "lock 이 실제로 있었다(양성 대조)" [ "$BEFORE_LOCK" != "없음" ]
      ;;
    r3-ahead) # 로컬이 앞서기만 함 → 갈라짐이 아니라 앞섬(exit 7)
      g -C "$B" merge -q --ff-only origin/main
      echo l1 > "$B/g.txt"; g -C "$B" add g.txt; g -C "$B" commit -qm l1; BEFORE="$(git -C "$B" rev-parse HEAD)"
      ff
      check "exit 7" [ "$RC" = 7 ]
      check "앞섬 문구" has "1커밋 앞섬 — origin 에 없는 로컬 커밋이다"
      check "기다리지 않았다(2초 미만)" lt "$ELAPSED" 2
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "HEAD 불변" head_unchanged
      ;;
    r3b) # origin URL 을 못 쓰게 → fetch 실패
      g -C "$B" remote set-url origin "$WORK/$CASE/없는-origin.git"
      ff
      check "exit 4" [ "$RC" = 4 ]
      check "fetch 실패 문구" has "fetch 실패"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "기다리지 않았다(2초 미만)" lt "$ELAPSED" 2
      check "HEAD 불변" head_unchanged
      ;;
    r3-noref) # fetch 는 되지만 refs/remotes/origin/main 이 생기지 않는 설정 → 원인 문구로 exit 4
      g -C "$B" config remote.origin.fetch '+refs/heads/x:refs/remotes/origin/x'
      g -C "$B" update-ref -d refs/remotes/origin/main
      ff
      check "exit 4" [ "$RC" = 4 ]
      check "origin/main 없음 문구" has "fetch 뒤에도 원격 추적 ref 가 없다: refs/remotes/origin/main"
      check "git 원문(fatal) 없음" hasnt "fatal:"
      check "HEAD 불변" head_unchanged
      ;;
    r3d-dirty) # 미커밋
      echo dirty >> "$B/f.txt"
      ff
      check "exit 3" [ "$RC" = 3 ]
      check "미커밋 문구" has "미커밋 변경 1건"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "HEAD 불변" head_unchanged
      check "스크립트의 status 는 전부 --no-optional-locks" status_suppressed
      ;;
    r3d-branch) # 다른 브랜치
      g -C "$B" switch -q -c other
      ff
      check "exit 3" [ "$RC" = 3 ]
      check "다른 브랜치 문구" has "본체 checkout 은 other 브랜치 — 기준 브랜치(main)가 아니어서"
      check "HEAD 불변" head_unchanged
      ;;
    r3e) # 이미 최신
      g -C "$B" merge -q --ff-only origin/main; BEFORE="$(git -C "$B" rev-parse HEAD)"
      ff
      check "exit 0" [ "$RC" = 0 ]
      check "이미 최신 문구" has "이미 최신"
      check "HEAD 불변" head_unchanged
      ;;
    r3-reflock) # ref lock(refs/heads/main.lock) → index lock 이 아니라 exit 6, git 첫 줄, ref lock 은 그대로
      REFLOCK="$B/.git/refs/heads/main.lock"; : > "$REFLOCK"
      BEFORE_LOCK="$(lockstat "$REFLOCK")"
      ff
      AFTER_LOCK="$(lockstat "$REFLOCK")"
      check "exit 6" [ "$RC" = 6 ]
      check "index lock·갈라짐 아님 문구" has "index lock·갈라짐 아님"
      check "git 원문 첫 줄(main.lock)" has "main.lock"
      check "ref lock 그대로($BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      check "ref lock 이 실제로 있었다(양성 대조)" [ "$BEFORE_LOCK" != "없음" ]
      check "HEAD 불변" head_unchanged
      ;;
    r3-newindex) # 실제 ff 경로 문구 「unable to write new index file」 — 작업 트리가 이미 바뀐 뒤라 재시도하지 않고 exit 6
      ff SHIM_MODE=newindex
      check "exit 6" [ "$RC" = 6 ]
      check "재시도하지 않았다(대기 문구 없음)" hasnt "기다린다"
      check "git 첫 줄" has "git: error: unable to write new index file"
      check "merge 는 1번만" [ "$(cat "$W/state/merges")" = 1 ]
      ;;
    r3-postdiverge) # 첫 확인 때는 뒤짐이었는데 merge 가 실패하는 사이 원격이 갈라졌다 → 두 번째 조상 확인이 갈라짐으로 말한다
      ff SHIM_MODE=postdiverge
      check "exit 5" [ "$RC" = 5 ]
      check "갈라졌다 + 앞섬 1·뒤짐 1" has "로컬만 있는 커밋 1개(앞섬) · origin 만 있는 커밋 1개(뒤짐)"
      check "exit 6 문구 없음" hasnt "index lock·갈라짐 아님"
      check "HEAD 불변" head_unchanged
      ;;
    r8-mergebase) # merge-base 만 git 오류 → exit 8
      ff SHIM_MODE=mbfail
      check "exit 8" [ "$RC" = 8 ]
      check "merge-base 오류 문구" has "git merge-base 가 종료코드 128 로 실패해 원인을 가리지 못했다"
      check "HEAD 불변" head_unchanged
      ;;
    r8-revparse) # 대기 중 rev-parse 가 실패 → 빈 값 비교로 성공하지 않고 exit 8 (lock 을 두어 루프를 한 번 돌게)
      : > "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      ff SHIM_MODE=rpfail
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "exit 8" [ "$RC" = 8 ]
      check "git 조회 오류 문구(rev-parse)" has "git 조회가 실패해 상태를 가리지 못했다(git rev-parse HEAD)"
      check "거짓 성공 문구 없음" hasnt "fast-forward →"
      check "HEAD 불변" head_unchanged
      check "lock 그대로($BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      ;;
    r8-revlist) # 갈라진 레포에서 rev-list 가 실패 → 빈 개수의 「갈라졌다」 가 아니라 exit 8
      diverge
      ff SHIM_MODE=rlfail
      check "exit 8" [ "$RC" = 8 ]
      check "git 조회 오류 문구(rev-list)" has "git 조회가 실패해 상태를 가리지 못했다(git rev-list"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "HEAD 불변" head_unchanged
      ;;
    r-gitindex) # 바깥 GIT_INDEX_FILE·GIT_COMMON_DIR 이 다른 곳을 가리켜도 --repo 의 index·레포로 ff 한다
      O="$W/other"; g clone -q "$W/origin.git" "$O"; g -C "$O" reset -q --hard HEAD~1
      OTHER_BEFORE="$(git -C "$O" rev-parse HEAD)"
      ff GIT_INDEX_FILE="$W/없는/index" GIT_COMMON_DIR="$O/.git"
      check "exit 0" [ "$RC" = 0 ]
      check "--repo 가 ff 됐다(HEAD = origin/main)" head_is_origin
      check "미커밋으로 오판하지 않았다" hasnt "미커밋"
      check "다른 레포는 그대로" [ "$(git -C "$O" rev-parse HEAD)" = "$OTHER_BEFORE" ]
      ;;
    r8-status|r8-branch|r8-gitpath) # 미커밋 확인 status · branch --show-current · rev-parse --git-path 실패 → exit 8(깨끗함·다른 브랜치로 오판하지 않는다)
      case "$CASE" in r8-status) M=stfail; WHAT_GIT="git status" ;; r8-branch) M=brfail; WHAT_GIT="git branch --show-current" ;; *) M=gpfail; WHAT_GIT="git rev-parse --git-path index.lock" ;; esac
      ff SHIM_MODE=$M
      check "exit 8" [ "$RC" = 8 ]
      check "git 조회 오류 문구($WHAT_GIT)" has "git 조회가 실패해 상태를 가리지 못했다($WHAT_GIT)"
      check "다른 판정 문구 없음(미커밋·브랜치·ff)" hasnt "fast-forward →"
      check "HEAD 불변" head_unchanged
      ;;
    r-linked) # linked worktree 를 --repo 로 — 그 worktree 자신의 index.lock(.git/worktrees/<이름>/index.lock)을 기다렸다가 ff
      g -C "$W/seed" push -q origin main:feat
      g -C "$B" fetch -q origin
      g -C "$B" worktree add -q -b feat "$W/wt" "$(git -C "$B" rev-parse origin/feat~1)"
      MAINLOCK="$LOCK"; LOCK="$(git -C "$W/wt" rev-parse --path-format=absolute --git-path index.lock)"
      echo "linked worktree lock: $LOCK" >> "$LOG"
      WT_BEFORE="$(git -C "$W/wt" rev-parse HEAD)"
      hold 2
      FF_REPO="$W/wt"; FF_BASE=feat
      ff
      stopholder
      check "exit 0" [ "$RC" = 0 ]
      check "per-worktree lock 경로(.git/worktrees/wt/index.lock)" [ "$LOCK" = "$(realpath_of "$B")/.git/worktrees/wt/index.lock" ]
      check "그 lock 을 기다렸다(대기 문구)" has "index.lock 이 잡혀 있다"
      check "lock 이 풀린 뒤 ff 시도 1회로 됐다(엉뚱한 lock 을 보면 실패 시도가 쌓인다)" has "ff 시도 1회"
      check "linked worktree HEAD = origin/feat" [ "$(git -C "$W/wt" rev-parse HEAD)" = "$(git -C "$W/wt" rev-parse origin/feat)" ]
      check "linked worktree 가 실제로 움직였다" [ "$(git -C "$W/wt" rev-parse HEAD)" != "$WT_BEFORE" ]
      check "본체 index.lock 은 없음 그대로" [ "$(lockstat "$MAINLOCK")" = "없음" ]
      check "쥐개의 lock 이 놓을 때까지 그대로(inode·mtime)" holder_intact
      ;;
    r1-tagdiff) # --tag 가 origin/<base> 와 다른 커밋 — ff 대상은 origin/main, 문구가 태그와 다르다고 말한다
      g -C "$B" tag v9.9.9 "$BEFORE"
      FF_TAG=v9.9.9
      ff
      check "exit 0" [ "$RC" = 0 ]
      check "HEAD = origin/main(대상은 origin)" head_is_origin
      check "문구가 실제 대상 origin/main 과 태그 불일치를 말한다" has "fast-forward → origin/main (⚠ 태그 v9.9.9 와 다른 커밋"
      check "「→ v9.9.9」 로 말하지 않는다" hasnt "fast-forward → v9.9.9"
      ;;
    r2-lsofdigit) # lsof 가 stdout 없이 stderr 에 숫자 한 줄 — pid 로 세지 않고 확인 불가
      : > "$LOCK"
      BEFORE_LOCK="$(lockstat "$LOCK")"
      XPATH="$WORK/shim-lsofdigit"
      ff
      AFTER_LOCK="$(lockstat "$LOCK")"
      check "exit 2" [ "$RC" = 2 ]
      check "확인 불가(lsof 종료코드 1 · 424242)" has "열고 있는 프로세스: 확인 불가(lsof 종료코드 1 · 424242)"
      check "pid 424242 로 세지 않았다" hasnt "pid 424242"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      ;;
    r-gitdir) # 바깥 GIT_DIR·GIT_WORK_TREE 가 다른 레포를 가리켜도 --repo 를 ff 한다
      O="$W/other"; g clone -q "$W/origin.git" "$O"; g -C "$O" reset -q --hard HEAD~1
      OTHER_BEFORE="$(git -C "$O" rev-parse HEAD)"
      ff GIT_DIR="$O/.git" GIT_WORK_TREE="$O"
      check "exit 0" [ "$RC" = 0 ]
      check "--repo 가 ff 됐다(HEAD = origin/main)" head_is_origin
      check "다른 레포는 그대로" [ "$(git -C "$O" rev-parse HEAD)" = "$OTHER_BEFORE" ]
      ;;
    e2e|e2e-ff|e2e-dirty|e2e-ahead|e2e-noff) # 실제 release.sh 를 끝까지 — e2e: 4단계 lock 실패가 경고로 남고 5·6단계로(R2ⓒ·R4ⓑ) ·
      # e2e-ff: lock 없이 4단계 ff 성공 뒤 5단계로 · e2e-dirty: 본체 미커밋(exit 3)은 ⚠ 경고 없이 스크립트 문구만 ·
      # e2e-ahead: 3단계 뒤 본체에 로컬 커밋이 생겨 앞섬만(exit 7) — ⚠ 없이 · e2e-noff: release-ff.sh 가 없는 사본 — ⚠ 뒤 5단계로
      g -C "$B" merge -q --ff-only origin/main  # 스크립트 커밋을 올린 뒤 release.sh 의 버전 커밋이 본체를 1커밋 뒤로 만든다
      mkdir -p "$B/scripts" "$B/app"
      cp "$ROOT/scripts/release.sh" "$B/scripts/"
      [ "$CASE" = e2e-noff ] || cp "$ROOT/scripts/release-ff.sh" "$B/scripts/"
      printf '{\n  "name": "x",\n  "version": "0.0.1",\n  "private": true\n}\n' > "$B/app/package.json"
      printf '{\n  "name": "x",\n  "version": "0.0.1",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "0.0.1"\n    }\n  }\n}\n' > "$B/app/package-lock.json"
      printf '.claude/worktrees/\napp/dist/\n' > "$B/.gitignore"
      g -C "$B" add -A; g -C "$B" commit -qm "release 스크립트"; g -C "$B" push -q origin HEAD:main
      g -C "$B" fetch -q origin
      BEFORE="$(git -C "$B" rev-parse HEAD)"
      mkdir -p "$W/bin"
      cat > "$W/bin/gh" <<'GH'
#!/usr/bin/env bash
# 가짜 gh — PR 은 이미 머지됨, release create/view 는 성공
echo "gh $*" >> "$(dirname "$0")/gh-calls.txt"
case "$*" in
  "pr view"*state,baseRefName*) echo "MERGED main LIFE-0-x false false 0000000000000000000000000000000000000000" ;;
  "release create"*) # e2e-ahead: 태그 push 뒤 본체에 로컬 커밋이 생긴 상태를 만든다(origin 보다 앞섬만)
    if [ -n "${E2E_AHEAD_REPO:-}" ]; then
      git -C "$E2E_AHEAD_REPO" fetch -q origin && git -C "$E2E_AHEAD_REPO" merge -q --ff-only origin/main \
        && git -C "$E2E_AHEAD_REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m "로컬 커밋" || exit 1
    fi ;;
  "release view"*) echo "https://example.invalid/release" ;;
  *) echo "가짜 gh: 모르는 호출 $*" >&2; exit 1 ;;
esac
GH
      chmod +x "$W/bin/gh"
      echo "노트" > "$W/notes.md"
      if [ "$CASE" = e2e-noff ]; then check "release-ff.sh 가 사본에 없다" [ ! -e "$B/scripts/release-ff.sh" ]
      else check "release-ff.sh 사본 = 레포 원본(sha1 $(shasum < "$FF" | cut -c1-12))" [ "$(shasum < "$FF")" = "$(shasum < "$B/scripts/release-ff.sh")" ]; fi
      check "release.sh 사본 = 레포 원본(sha1 $(shasum < "$ROOT/scripts/release.sh" | cut -c1-12))" [ "$(shasum < "$ROOT/scripts/release.sh")" = "$(shasum < "$B/scripts/release.sh")" ]
      [ "$CASE" = e2e ] && hold 45
      [ "$CASE" = e2e-dirty ] && echo stray > "$B/stray.txt"
      AHEAD_REPO=""; [ "$CASE" = e2e-ahead ] && AHEAD_REPO="$B"
      run env PATH="$W/bin:$PATH" E2E_AHEAD_REPO="$AHEAD_REPO" bash -c 'command -v gh; exec "$0" "$@"' "$B/scripts/release.sh" --prs 1 --notes "$W/notes.md" --skip-build --skip-apk
      stopholder
      cp "$W/bin/gh-calls.txt" "$OUT/$CASE-gh-calls.txt" 2>/dev/null
      check "가짜 gh 를 썼다" has "$W/bin/gh"
      check "exit 0(출고 계속)" [ "$RC" = 0 ]
      check "버전 커밋·태그 push(3단계)" has "태그 v0.0.2 push"
      case "$CASE" in
        e2e)
          check "4단계 lock 문구(잰 대기 횟수·경과)" grep -qE "index.lock 이 풀리지 않았다\(index.lock 대기 [1-9][0-9]회·3[0-9]초" "$LOG"
          check "4단계 경고(release.sh 호출부)" has "fast-forward 하지 않았다(위 원인) — 출고(원격)는 끝났다"
          check "본체 HEAD 불변(ff 안 됨)" head_unchanged
          check "쥐개의 lock 이 놓을 때까지 그대로(inode·mtime)" holder_intact ;;
        e2e-ff)
          check "4단계 ff 성공 문구(실제 대상 origin/main = 태그)" has "본체 브랜치 main fast-forward → origin/main (= 태그 v0.0.2)"
          check "4단계 경고 없음" hasnt "fast-forward 하지 않았다"
          check "본체 HEAD = origin/main(ff 됨)" head_is_origin ;;
        e2e-dirty)
          check "4단계 미커밋 문구(스크립트)" has "미커밋 변경 1건 — fast-forward 하지 않음"
          check "release.sh 호출부 ⚠ 경고 없음(exit 3)" hasnt "fast-forward 하지 않았다(위 원인)"
          check "본체 HEAD 불변" head_unchanged ;;
        e2e-ahead)
          check "4단계 앞섬 문구(스크립트, exit 7)" has "1커밋 앞섬 — origin 에 없는 로컬 커밋이다"
          check "release.sh 호출부 ⚠ 경고 없음(exit 7)" hasnt "fast-forward 하지 않았다(위 원인)" ;;
        e2e-noff)
          check "release-ff.sh 부재 ⚠ 문구" has "⚠ scripts/release-ff.sh 가 없어 본체 main fast-forward 를 건너뜀 — 출고(원격)는 끝났다"
          check "본체 HEAD 불변" head_unchanged ;;
      esac
      check "5단계로 갔다(--skip-build)" has "--skip-build — dmg 는 나중에"
      check "6단계로 갔다(--skip-apk)" has "--skip-apk — APK 는 나중에"
      check "끝 문구 ✔ 출고 v0.0.2" has "✔ 출고 v0.0.2"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      ;;
    *) echo "모르는 케이스 $CASE" >&2; exit 64 ;;
  esac
  [ -f "$W/state/holder.txt" ] && echo "holder: $(cat "$W/state/holder.txt")" >> "$LOG"
  [ -f "$W/state/git-argv.txt" ] && { echo "--- git argv (shim)"; cat "$W/state/git-argv.txt"; } >> "$LOG"
  if [ "$CASE_FAIL" = 0 ]; then R=PASS; else R=FAIL; fi
  echo "$CASE $R exit=$RC elapsed=${ELAPSED}s log=$LOG" | tee -a "$SUMMARY"
done

# 띄운 쥐개가 남지 않았는지
sleep 2.5
LEFT="$(ps -Ao pid,ppid,etime,command | grep -F "$WORK" | grep -v grep || true)"
echo "남은 도우미: ${LEFT:-없음}" | tee -a "$SUMMARY" >> "$PIDS"
echo "총 실패 검사 $FAILS" | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
