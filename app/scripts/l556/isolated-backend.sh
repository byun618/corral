#!/bin/sh
# LIFE-556 빠른 관문 B2·B4 — release 동봉 herdr 를 격리 HOME 에서만 돌린다.
# 사용자 HOME·XDG·brew herdr 를 건드리지 않는다: env -i 로 HOME 하나만 /tmp/l556-* 로 준다.
# 인자: <release herdr 바이너리> <격리 root(/tmp/l556-*)>
set -eu
bin="$1"; root="$2"
case "$root" in /tmp/l556-*|/private/tmp/l556-*) ;; *) echo "root must be /tmp/l556-*" >&2; exit 2 ;; esac
rm -rf "$root"; mkdir -p "$root/home"
run() { env -i HOME="$root/home" PATH=/usr/bin:/bin TERM=dumb "$bin" "$@"; }
echo "== B2 session list (격리 HOME, XDG 없음)"
run session list --json
echo "== B2 server 기동 → 폴더 관측"
env -i HOME="$root/home" PATH=/usr/bin:/bin TERM=dumb "$bin" server > "$root/server.log" 2>&1 &
pid=$!
i=0; while [ $i -lt 40 ] && [ ! -S "$root/home/.config/corral-herdr/herdr.sock" ]; do sleep 0.25; i=$((i+1)); done
echo "server pid $pid"
(cd "$root/home" && find . -maxdepth 3 | sort)
run session list --json
echo "== B2 herdr / herdr-dev 폴더 없음"
for d in .config/herdr .config/herdr-dev .local/state/herdr .local/state/herdr-dev; do [ -e "$root/home/$d" ] && echo "PRESENT $d" || echo "absent $d"; done
echo "== B4 self-update 거절 (전후 sha256)"
before=$(shasum -a 256 "$bin" | cut -d' ' -f1)
set +e; run update; code=$?; set -e
after=$(shasum -a 256 "$bin" | cut -d' ' -f1)
echo "update exit $code"; echo "sha before $before"; echo "sha after  $after"
[ "$before" = "$after" ] && echo "binary unchanged" || echo "BINARY CHANGED"
echo "== B4 서버 로그에 update check 흔적 (stdout 로그 · herdr tracing 로그 update.check.start 행 수)"
grep -ci "update" "$root/server.log" || true
grep -c "update.check" "$root/home/.config/corral-herdr/herdr-server.log" || true
echo "tracing 로그 행 수 $(wc -l < "$root/home/.config/corral-herdr/herdr-server.log" | tr -d ' ') (로그가 비지 않았다는 대조)"
echo "== 정리: server stop"
run server stop || true
i=0; while [ $i -lt 40 ] && kill -0 $pid 2>/dev/null; do sleep 0.25; i=$((i+1)); done
kill -0 $pid 2>/dev/null && { echo "server still alive — SIGKILL"; kill -9 $pid; } || echo "server $pid gone"
