#!/bin/sh
# LIFE-556 빠른 관문 B2·B4·M2 — herdr 바이너리 하나를 격리 HOME 에서만 돌려 폴더·업데이트·worktree 위치를 본다.
# 사용자 HOME·XDG·brew 서버를 건드리지 않는다: env -i 로 HOME 하나만 /tmp/l556-* 로 준다.
# 판정은 종료코드다 — 기대와 다른 관측이 하나라도 있으면 exit 1 (fix1 L1·L2).
#
# 인자: <mode bundled|stock> <herdr 바이너리> <격리 root(/tmp/l556-*)>
#   bundled — 동봉 release 를 기대: 폴더 corral-herdr · herdr/herdr-dev 없음 · `herdr update` 거절·무변경 · 업데이트 확인 0행 ·
#             worktree 가 ~/.corral-herdr/worktrees 아래 · ~/.herdr 없음
#   stock   — 양성 대조(stock release, 예: brew herdr): 폴더 herdr · 업데이트 확인 ≥1행 · worktree 가 ~/.herdr/worktrees 아래.
#             `herdr update` 는 부르지 않는다. 같은 질의·같은 대기 시간(WAIT)으로 bundled 와 견준다.
#             fix2 L3 — 원본(예: 사용자 brew 바이너리)을 직접 돌리지 않는다: root 아래 사본으로 돌리고 원본 sha256 전후를 단언한다.
set -u
mode="$1"; bin="$2"; root="$3"
case "$mode" in bundled) appdir=corral-herdr; wtroot=.corral-herdr/worktrees ;; stock) appdir=herdr; wtroot=.herdr/worktrees ;; *) echo "mode must be bundled or stock" >&2; exit 2 ;; esac
case "$root" in /tmp/l556-*|/private/tmp/l556-*) ;; *) echo "root must be /tmp/l556-*" >&2; exit 2 ;; esac
WAIT=4
fails=0
check() { if [ "$1" = ok ]; then echo "PASS $2"; else echo "FAIL $2"; fails=$((fails+1)); fi; }
rm -rf "$root"; mkdir -p "$root/home"
home="$root/home"
if [ "$mode" = stock ]; then
  orig="$bin"; orig_before=$(shasum -a 256 "$orig" | cut -d' ' -f1)
  cp "$orig" "$root/herdr-stock-copy" && bin="$root/herdr-stock-copy"
  echo "== stock 사본으로 실행 (원본 sha256 before $orig_before)"
fi
run() { env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb "$bin" "$@"; }
echo "== mode $mode · $("$bin" --version)"
echo "== session list (격리 HOME, XDG 없음)"
run session list --json
echo "== server 기동"
env -i HOME="$home" PATH=/usr/bin:/bin TERM=dumb "$bin" server > "$root/server.log" 2>&1 &
pid=$!
i=0; while [ $i -lt 40 ] && [ ! -S "$home/.config/$appdir/herdr.sock" ]; do sleep 0.25; i=$((i+1)); done
[ -S "$home/.config/$appdir/herdr.sock" ] && check ok "socket under .config/$appdir" || check no "socket under .config/$appdir"
sleep "$WAIT"
echo "server pid $pid"
echo "== B2 폴더"
for d in .config/herdr .config/herdr-dev .config/corral-herdr .local/state/herdr .local/state/herdr-dev .local/state/corral-herdr; do [ -e "$home/$d" ] && echo "present $d" || echo "absent $d"; done
if [ "$mode" = bundled ]; then
  for d in .config/herdr .config/herdr-dev .local/state/herdr .local/state/herdr-dev; do [ -e "$home/$d" ] && check no "absent $d" || check ok "absent $d"; done
fi
echo "== B4 업데이트 확인 흔적 (tracing 로그 update.check 행 수, 대기 ${WAIT}s)"
log="$home/.config/$appdir/herdr-server.log"
n=$(grep -c "update.check" "$log" 2>/dev/null || true); n=${n:-0}
echo "update.check lines: $n (log lines $(wc -l < "$log" 2>/dev/null | tr -d ' '))"
if [ "$mode" = bundled ]; then [ "$n" -eq 0 ] && check ok "no update check" || check no "no update check"; else [ "$n" -ge 1 ] && check ok "stock logs update check" || check no "stock logs update check"; fi
if [ "$mode" = bundled ]; then
  echo "== B4 self-update 거절 (전후 sha256)"
  before=$(shasum -a 256 "$bin" | cut -d' ' -f1)
  out=$(run update 2>&1); code=$?
  after=$(shasum -a 256 "$bin" | cut -d' ' -f1)
  echo "$out"; echo "update exit $code"; echo "sha before $before"; echo "sha after  $after"
  [ "$code" -ne 0 ] && check ok "update refused (exit $code)" || check no "update refused"
  echo "$out" | grep -q "bundled with corral" && check ok "refusal message" || check no "refusal message"
  [ "$before" = "$after" ] && check ok "binary unchanged" || check no "binary unchanged"
fi
echo "== M2 worktree 기본 위치"
repo="$home/repo"
mkdir -p "$repo" && git -C "$repo" init -q && git -C "$repo" -c user.name=l556 -c user.email=l556@example.invalid commit -q --allow-empty -m init
created=$(run worktree create --cwd "$repo" --branch l556-wt 2>&1); echo "$created" | sed "s#$root#<root>#g" | head -5
wt=$(find "$home/$wtroot" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | head -1)
echo "worktree dir: $(echo "${wt:-none}" | sed "s#$root#<root>#g")"
[ -n "$wt" ] && check ok "worktree under ~/$wtroot" || check no "worktree under ~/$wtroot"
if [ "$mode" = bundled ]; then [ -e "$home/.herdr" ] && check no "~/.herdr absent" || check ok "~/.herdr absent"; fi
if [ -n "$wt" ]; then run worktree remove --path "$wt" > /dev/null 2>&1 || git -C "$repo" worktree remove --force "$wt"; fi
echo "worktree after remove: $(git -C "$repo" worktree list | wc -l | tr -d ' ') entries"
echo "== 정리: server stop"
run server stop > /dev/null 2>&1 || true
i=0; while [ $i -lt 40 ] && kill -0 $pid 2>/dev/null; do sleep 0.25; i=$((i+1)); done
if kill -0 $pid 2>/dev/null; then echo "server still alive — SIGKILL"; kill -9 $pid; check no "server stopped"; else check ok "server stopped"; fi
# 이 스크립트 자신(인자에 root 가 실린다)은 빼고 센다 — 1회차(R2-02·03)가 자기 자신 2개를 잔존으로 셌다.
if [ "$mode" = stock ]; then
  orig_after=$(shasum -a 256 "$orig" | cut -d' ' -f1)
  echo "original sha before $orig_before"; echo "original sha after  $orig_after"
  [ "$orig_before" = "$orig_after" ] && check ok "original binary unchanged" || check no "original binary unchanged"
fi
left=$(ps -axo pid=,args= | grep -F "$root" | grep -v -e grep -e isolated-backend.sh | wc -l | tr -d ' ')
[ "$left" -eq 0 ] && check ok "no leftover process" || check no "no leftover process ($left)"
rm -rf "$root"
echo "== fails $fails"
[ "$fails" -eq 0 ]
