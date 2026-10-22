#!/usr/bin/env bash
# LIFE-672 빠른 확인 — scripts/release-ff.sh(출고 4단계)를 임시 레포에서 원인별로 돌린다. 실제 출고·본체 checkout 무접촉.
# app/scripts/l672/ff-test.sh <원자료 폴더> [케이스 …]   (케이스 생략 = 전부: r1a r2a r2b r3a r3a-lock r3b r3d-dirty r3d-branch r3e e2e)
# 임시 레포 = bare origin + clone(main 이 origin 보다 1커밋 뒤). lock 쥐개 = clone 의 .git/index.lock 을 O_EXCL 로 만들어 열어 둔 python.
# e2e = 실제 scripts/release.sh 를 가짜 gh 로 임시 레포에서 끝까지 돌린다(4단계 lock 실패 → 경고 뒤 5·6단계·「✔ 출고」).
set -uo pipefail

OUT="${1:?원자료 폴더}"; shift
CASES="${*:-r1a r2a r2b r3a r3a-lock r3b r3d-dirty r3d-branch r3e e2e}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FF="$ROOT/scripts/release-ff.sh"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/l672ff.XXXXXX")"
PIDS="$OUT/helper-pids.txt"
SUMMARY="$OUT/summary.txt"
: > "$PIDS"; : > "$SUMMARY"
echo "# ff-test $(date '+%F %T') · git $(git --version | cut -d' ' -f3-) · work $WORK · release-ff.sh sha1 $(shasum "$FF" | cut -c1-12)" | tee -a "$SUMMARY"

g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }

# mkrepo <이름> → $W/origin.git, $W/b (main 이 origin/main 보다 1커밋 뒤, origin/main 은 fetch 로 최신)
mkrepo() {
  W="$WORK/$1"; mkdir -p "$W"
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
  python3 -c '
import os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
time.sleep(float(sys.argv[2]))
os.close(fd)
os.unlink(sys.argv[1])  # git 처럼 쥔 쪽이 스스로 놓는다(임시 레포 안)
' "$LOCK" "$1" &
  HOLDER=$!
  echo "$CASE holder pid $HOLDER hold ${1}s lock $LOCK" >> "$PIDS"
  local i=0; while [ ! -e "$LOCK" ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i + 1)); done
}

stopholder() { [ -n "${HOLDER:-}" ] && kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; echo "$CASE holder pid $HOLDER stopped" >> "$PIDS"; HOLDER=""; }

lockstat() { stat -f '%i %m %z' "$LOCK" 2>/dev/null || echo "없음"; }

# run → RC, LOG, ELAPSED(초, 소수)
run() {
  LOG="$OUT/$CASE.txt"
  local t0 t1
  {
    echo "## $CASE — $(date '+%F %T')"
    echo "repo $B · before HEAD $(git -C "$B" rev-parse --short HEAD) origin/main $(git -C "$B" rev-parse --short origin/main) · lock $(lockstat)"
    echo "\$ $*"
  } > "$LOG"
  t0="$(python3 -c 'import time; print(time.time())')"
  "$@" >> "$LOG" 2>&1; RC=$?
  t1="$(python3 -c 'import time; print(time.time())')"
  ELAPSED="$(python3 -c "print(round($t1 - $t0, 2))")"
  echo "exit=$RC elapsed=${ELAPSED}s · after HEAD $(git -C "$B" rev-parse --short HEAD) · lock $(lockstat)" >> "$LOG"
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

for CASE in $CASES; do
  CASE_FAIL=0; HOLDER=""
  mkrepo "$CASE"
  BEFORE="$(git -C "$B" rev-parse HEAD)"
  case "$CASE" in
    r1a) # lock 을 2초 쥐었다 놓는다 → 기다렸다가 ff
      hold 2
      run "$FF" --repo "$B" --base main --tag v9.9.9
      stopholder
      check "exit 0" [ "$RC" = 0 ]
      check "대기 사실 한 줄(index.lock 대기 N회·N초)" has "index.lock 대기"
      check "ff 문구" has "fast-forward → v9.9.9"
      check "HEAD = origin/main" head_is_origin
      check "1.5초 이상 기다렸다(쥐개 2초)" ge "$ELAPSED" 1.5
      ;;
    r2a) # 쥐개가 상한보다 오래(40초) 쥔다 → 30초(+2) 안에 포기, 쥐개 pid 가 문구에
      hold 40
      BEFORE_LOCK="$(lockstat)"
      run "$FF" --repo "$B" --base main
      AFTER_LOCK="$(lockstat)"
      check "exit 2" [ "$RC" = 2 ]
      check "30초 이상" ge "$ELAPSED" 30
      check "32초 미만(상한+2초 이내)" lt "$ELAPSED" 32
      check "lock 경로" has "lock: $(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$LOCK")"
      check "나이(mtime 기준)" has "초(mtime 기준)"
      check "크기" has "크기 0바이트"
      check "열고 있는 프로세스 = 쥐개 pid" has "열고 있는 프로세스: pid $HOLDER"
      check "지우지 않는다 문구" has "스크립트는 lock 을 지우지 않는다"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      stopholder
      ;;
    r2b) # 쥐개 없이 0바이트 lock 만(남은 lock) → 열고 있는 프로세스 없음
      : > "$LOCK"; touch -t "$(date -v-2H +%Y%m%d%H%M.%S)" "$LOCK"
      BEFORE_LOCK="$(lockstat)"
      run "$FF" --repo "$B" --base main
      AFTER_LOCK="$(lockstat)"
      check "exit 2" [ "$RC" = 2 ]
      check "30초 이상" ge "$ELAPSED" 30
      check "32초 미만" lt "$ELAPSED" 32
      check "열고 있는 프로세스: 없음" has "열고 있는 프로세스: 없음"
      check "나이 2시간 근처(7200초대)" grep -qE '나이 72[0-9][0-9]초' "$LOG"
      check "지우지 않는다 문구" has "스크립트는 lock 을 지우지 않는다"
      check "lock 그대로(inode·mtime·크기 $BEFORE_LOCK)" [ "$BEFORE_LOCK" = "$AFTER_LOCK" ]
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    r3a|r3a-lock) # 로컬에만 있는 커밋 → 갈라짐(앞섬 1·뒤짐 1), 기다리지 않는다. -lock 은 lock 까지 남겨 둔 채
      echo local > "$B/g.txt"; g -C "$B" add g.txt; g -C "$B" commit -qm local; BEFORE="$(git -C "$B" rev-parse HEAD)"
      [ "$CASE" = r3a-lock ] && : > "$LOCK"
      run "$FF" --repo "$B" --base main
      check "exit 5" [ "$RC" = 5 ]
      check "갈라졌다 + 앞섬 1·뒤짐 1" has "로컬만 있는 커밋 1개(앞섬) · origin 만 있는 커밋 1개(뒤짐)"
      check "기다리지 않았다(2초 미만)" lt "$ELAPSED" 2
      check "lock 대기 문구 없음" hasnt "기다린다"
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    r3b) # origin URL 을 못 쓰게 → fetch 실패
      g -C "$B" remote set-url origin "$WORK/$CASE/없는-origin.git"
      run "$FF" --repo "$B" --base main
      check "exit 4" [ "$RC" = 4 ]
      check "fetch 실패 문구" has "fetch 실패"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "기다리지 않았다(2초 미만)" lt "$ELAPSED" 2
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    r3d-dirty) # 미커밋
      echo dirty >> "$B/f.txt"
      run "$FF" --repo "$B" --base main
      check "exit 3" [ "$RC" = 3 ]
      check "미커밋 문구" has "미커밋 변경 1건"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    r3d-branch) # 다른 브랜치
      g -C "$B" switch -q -c other
      run "$FF" --repo "$B" --base main
      check "exit 3" [ "$RC" = 3 ]
      check "다른 브랜치 문구" has "본체 checkout 은 other — main 가 아니라"
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    r3e) # 이미 최신
      g -C "$B" merge -q --ff-only origin/main; BEFORE="$(git -C "$B" rev-parse HEAD)"
      run "$FF" --repo "$B" --base main
      check "exit 0" [ "$RC" = 0 ]
      check "이미 최신 문구" has "이미 최신"
      check "HEAD 불변" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    e2e) # 실제 release.sh 를 끝까지 — 4단계 lock 실패가 경고로 남고 5·6단계로 간다(R2ⓒ·R4ⓑ)
      g -C "$B" merge -q --ff-only origin/main  # 스크립트 커밋을 올린 뒤 release.sh 의 버전 커밋이 본체를 1커밋 뒤로 만든다
      mkdir -p "$B/scripts" "$B/app"
      cp "$ROOT/scripts/release.sh" "$ROOT/scripts/release-ff.sh" "$B/scripts/"
      printf '{\n  "name": "x",\n  "version": "0.0.1",\n  "private": true\n}\n' > "$B/app/package.json"
      printf '{\n  "name": "x",\n  "version": "0.0.1",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "0.0.1"\n    }\n  }\n}\n' > "$B/app/package-lock.json"
      printf '.claude/worktrees/\napp/dist/\n' > "$B/.gitignore"
      g -C "$B" add -A; g -C "$B" commit -qm "release 스크립트"; g -C "$B" push -q origin HEAD:main
      g -C "$B" fetch -q origin
      BEFORE="$(git -C "$B" rev-parse HEAD)"
      mkdir -p "$WORK/$CASE/bin"
      cat > "$WORK/$CASE/bin/gh" <<'GH'
#!/usr/bin/env bash
# 가짜 gh — PR 은 이미 머지됨, release create/view 는 성공
echo "gh $*" >> "$(dirname "$0")/gh-calls.txt"
case "$*" in
  "pr view"*state,baseRefName*) echo "MERGED main LIFE-0-x false false 0000000000000000000000000000000000000000" ;;
  "release create"*) ;;
  "release view"*) echo "https://example.invalid/release" ;;
  *) echo "가짜 gh: 모르는 호출 $*" >&2; exit 1 ;;
esac
GH
      chmod +x "$WORK/$CASE/bin/gh"
      echo "노트" > "$WORK/$CASE/notes.md"
      check "release-ff.sh 사본 = 레포 원본(sha1)" [ "$(shasum < "$ROOT/scripts/release-ff.sh")" = "$(shasum < "$B/scripts/release-ff.sh")" ]
      check "release.sh 사본 = 레포 원본(sha1)" [ "$(shasum < "$ROOT/scripts/release.sh")" = "$(shasum < "$B/scripts/release.sh")" ]
      hold 45
      run env PATH="$WORK/$CASE/bin:$PATH" bash -c 'command -v gh; exec "$0" "$@"' "$B/scripts/release.sh" --prs 1 --notes "$WORK/$CASE/notes.md" --skip-build --skip-apk
      stopholder
      cp "$WORK/$CASE/bin/gh-calls.txt" "$OUT/e2e-gh-calls.txt" 2>/dev/null
      check "가짜 gh 를 썼다" has "$WORK/$CASE/bin/gh"
      check "exit 0(출고 계속)" [ "$RC" = 0 ]
      check "버전 커밋·태그 push(3단계)" has "태그 v0.0.2 push"
      check "4단계 lock 문구" has "index.lock 이 30초 동안 풀리지 않았다"
      check "4단계 경고(release.sh 호출부)" has "fast-forward 하지 않았다(위 원인) — 출고(원격)는 끝났다"
      check "5단계로 갔다(--skip-build)" has "--skip-build — dmg 는 나중에"
      check "6단계로 갔다(--skip-apk)" has "--skip-apk — APK 는 나중에"
      check "끝 문구 ✔ 출고 v0.0.2" has "✔ 출고 v0.0.2"
      check "갈라졌다 문구 없음" hasnt "갈라졌다"
      check "본체 HEAD 불변(ff 안 됨)" [ "$(git -C "$B" rev-parse HEAD)" = "$BEFORE" ]
      ;;
    *) echo "모르는 케이스 $CASE" >&2; exit 64 ;;
  esac
  if [ "$CASE_FAIL" = 0 ]; then R=PASS; else R=FAIL; fi
  echo "$CASE $R exit=$RC elapsed=${ELAPSED}s log=$LOG" | tee -a "$SUMMARY"
done

# 띄운 쥐개가 남지 않았는지
sleep 0.2
LEFT="$(ps -Ao pid,ppid,etime,command | grep -F "$WORK" | grep -v grep || true)"
echo "남은 도우미: ${LEFT:-없음}" | tee -a "$SUMMARY" >> "$PIDS"
rm -rf "$WORK"
echo "총 실패 검사 $FAILS" | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
