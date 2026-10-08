#!/bin/sh
# LIFE-561 최종 관문 보강 ③ — fix1 M1 에서 CORRAL_HERDR_BIN 을 고정한 기동 줄의 해소 출처 확인(격리). 동결 드라이버는 실행하지 않는다 —
# 그 줄과 같은 env 모양(env -i · 최소 PATH · SHELL=/bin/zsh · 바인딩 없음 · CORRAL_HERDR_BIN=/opt/homebrew/bin/herdr)으로 레포 Electron 을 직접 띄운다.
# 다른 점: HOME·XDG·userData·control 소켓·로그는 전부 /tmp/l561-pin/<꼴> 아래(실제 HOME·userData·herdr 폴더 무접촉).
# 서버 자동 기동을 막으려고 격리 폴더의 default session.json 을 깨 둔다(재개 대상 「모름」 → 확인 카드, 자동 기동 없음). 그래도 서버가 뜨면 로그의 pid 만 끈다.
#   pinned-native  : l485·l490·l502 native-app.sh 꼴 → 기대 source env · path /opt/homebrew/bin/herdr
#   pinned-iso     : l485 iso-app.sh 꼴(XDG·CORRAL_RUNTIME_SOCKET 추가) → 같은 기대
#   pinned-k1m1    : k1m1 이 하네스 PATH 에서 고르는 값(command -v herdr) → 같은 기대
#   unpinned (음성 대조) : 같은 env 에서 CORRAL_HERDR_BIN 만 뺌 → 기대 source repo-guard(핀이 실제로 출처를 바꾸는지)
# 판정은 종료코드. 사용: sh scripts/l561/pin-source.sh (app/ 에서)
set -u
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
APP=$(pwd -P); NODE=$(command -v node); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
TOP=/tmp/l561-pin; rm -rf "$TOP"
K1M1_BIN=$(PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin /bin/sh -c 'command -v herdr')
echo "k1m1_pin_value=$K1M1_BIN"
probe() { # $1 = 꼴, $2 = 기대 source, $3 = 기대 path(빈 값이면 검사 안 함), 나머지 = 추가 env
  name=$1; want_src=$2; want_path=$3; shift 3
  R=$TOP/$name; mkdir -p "$R/h" "$R/xdg/herdr" "$R/xdg/herdr-dev" "$R/ud" "$R/shots"; chmod 700 "$R"  # run1: 런타임 소켓 폴더는 0700 이어야 한다(iso-root.sh 와 같게)
  echo 'not json' > "$R/xdg/herdr/session.json"; echo 'not json' > "$R/xdg/herdr-dev/session.json"
  env -i HOME="$R/h" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    XDG_CONFIG_HOME="$R/xdg" CORRAL_USER_DATA="$R/ud" CORRAL_CONTROL_SOCKET="$R/ctl.sock" CORRAL_LOG="$R/corral.ndjson" CORRAL_SHOT_DIR="$R/shots" "$@" \
    "$EL" "$APP" --user-data-dir="$R/ud" > "$R/electron.log" 2>&1 &
  P=$!
  i=0; until grep -q '"herdr.resolve"' "$R/corral.ndjson" 2>/dev/null; do i=$((i+1)); [ $i -gt 200 ] && break; sleep 0.2; done
  sleep 3
  RES=$(grep '"herdr.resolve"' "$R/corral.ndjson" | head -1)
  echo "## $name — app pid $P"; echo "$RES" | sed "s#$TOP#<root>#g; s#$HOME#~#g"
  grep -E '"(backend.status|herdr.server.spawn)"' "$R/corral.ndjson" | sed "s#$TOP#<root>#g; s#$HOME#~#g" | cut -c1-300
  check "${name}_source_$want_src" "$(echo "$RES" | grep -q "\"source\":\"$want_src\"" && echo 1)"
  [ -n "$want_path" ] && check "${name}_path" "$(echo "$RES" | grep -q "\"path\":\"$want_path\"" && echo 1)"
  SPAWNED=$(grep '"herdr.server.spawn"' "$R/corral.ndjson" | sed -E 's/.*"pid":([0-9]+).*/\1/')
  check "${name}_no_server_spawn" "$([ -z "$SPAWNED" ] && echo 1)"
  kill "$P" 2>/dev/null; i=0; while kill -0 "$P" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && kill -9 "$P"; [ $i -gt 60 ] && break; sleep 0.1; done
  for s in $SPAWNED; do [ "$(ps -o pgid= -p "$s" | tr -d ' ')" = "$s" ] && kill -TERM -"$s"; done
}
probe pinned-native env /opt/homebrew/bin/herdr CORRAL_HERDR_BIN=/opt/homebrew/bin/herdr
probe pinned-iso env /opt/homebrew/bin/herdr CORRAL_RUNTIME_SOCKET=$TOP/pinned-iso/rt.sock CORRAL_HERDR_BIN=/opt/homebrew/bin/herdr
probe pinned-k1m1 env "$K1M1_BIN" CORRAL_HERDR_BIN="$K1M1_BIN"
probe unpinned repo-guard ""
sleep 1; LEFT=$(pgrep -fl -- "$TOP/"); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
echo "fails=$FAILS"; [ "$FAILS" = 0 ]
