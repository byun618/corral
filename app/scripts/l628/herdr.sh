#!/bin/sh
# LIFE-628 최종 관문 격리 herdr — XDG 격리(사용자 ~/.config/corral-herdr·herdr-dev 무접촉), 이름 세션, 가짜 claude 를 PATH 앞에.
#   sh herdr.sh start <ROOT> <BIN> <SESSION>   → <ROOT>/herdr-<SESSION>.pid, made.txt
#   sh herdr.sh stop  <ROOT> <BIN> <SESSION>
#   sh herdr.sh sock  <ROOT> <SESSION>
set -u
cmd=$1; ROOT=$2
case "$ROOT" in /tmp/l6g/*) ;; *) echo "ROOT 는 /tmp/l6g/*"; exit 2 ;; esac
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
X=$ROOT/x
sock() { echo "$X/corral-herdr/sessions/$1/herdr.sock"; }
case "$cmd" in
  sock) sock "$3" ;;
  start)
    BIN=$3; S=$4; mkdir -p "$X" "$ROOT/bin" "$ROOT/logs"
    [ -x "$ROOT/bin/claude" ] || cp "$HERE/fake-claude.zsh" "$ROOT/bin/claude"; chmod +x "$ROOT/bin/claude"
    SOCK=$(sock "$S")
    [ -S "$SOCK" ] && { echo "이미 떠 있다 $SOCK"; exit 3; }
    sh "$HERE/../l470/clean.sh" XDG_CONFIG_HOME="$X" L628_ROOT="$ROOT" DISABLE_AUTO_UPDATE=true PATH="$ROOT/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" -- \
      "nohup '$BIN' --session $S server >> '$ROOT/logs/herdr-$S.out' 2>&1 & echo \$! > '$ROOT/herdr-$S.pid'" </dev/null
    i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "소켓 안 뜸"; exit 1; }; sleep 0.2; done
    echo "pid herdr-$S $(cat "$ROOT/herdr-$S.pid") bin=$BIN sha=$(shasum -a 256 "$BIN" | cut -c1-12) at=$(date -u +%FT%TZ)" | tee -a "$ROOT/made.txt" ;;
  stop)
    BIN=$3; S=$4; P=$(cat "$ROOT/herdr-$S.pid" 2>/dev/null)
    sh "$HERE/../l470/clean.sh" XDG_CONFIG_HOME="$X" -- "'$BIN' --session $S server stop" </dev/null > "$ROOT/logs/stop-$S.out" 2>&1
    i=0; while [ -n "$P" ] && kill -0 "$P" 2>/dev/null; do i=$((i+1)); [ $i -gt 75 ] && { kill "$P"; sleep 1; break; }; sleep 0.2; done
    echo "stopped herdr-$S $P alive=$(kill -0 "$P" 2>/dev/null && echo 1 || echo 0) at=$(date -u +%FT%TZ)" | tee -a "$ROOT/made.txt" ;;
esac
