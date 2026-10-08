#!/bin/sh
# LIFE-561 C3ⓒ — 격리 개발 실행 카드 스크린샷 (없음 1 · 낡음 1). 네이티브 관문이 아니다.
# 체크아웃 사본을 /tmp/l561-iso-<mode>/repo 의 새 git 저장소에 두고(빌드한 out/·backend/ 사본, node_modules 는 심링크) 레포 Electron 으로 띄운다 —
# guard 고정 자리는 git 공용 폴더 기준이라, 사본 저장소의 `.git/corral-herdr-dev` 만 본다(실제 레포 자리·HOME 과 무관).
#   none  — 사본 저장소에 자리가 없다. 알려진 위치의 brew herdr 는 sandbox-exec 로 읽기를 막아 「종전 후보도 없음」 을 만든다 → 미설치 카드
#   stale — 실제 guard 바이너리·영수증을 사본 칸에 복사하고 바이너리에 1바이트를 덧붙인다 → 낡음 카드. brew herdr 는 막지 않는다(내려가지 않는지 본다)
# 격리: HOME·XDG_CONFIG_HOME·userData·control 소켓·TMPDIR 모두 <ROOT> 아래, PATH=/usr/bin:/bin, SHELL=/bin/sh. 바인딩 env 없음.
# 판정은 종료코드다 — CHECK 하나라도 fail 이면 exit 1. 사용: sh scripts/l561/iso-card.sh <none|stale> <원자료 디렉터리>  (app/ 에서, node v24 가 PATH 앞에)
set -u
MODE=$1; OUT=$2
APP=$(pwd -P)
NODE=$(command -v node)
ROOT=/tmp/l561-iso-$MODE
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
rm -rf "$ROOT"; mkdir -p "$ROOT/repo/app" "$ROOT/h/.config" "$ROOT/ud" "$ROOT/shots" "$OUT"; chmod 700 "$ROOT"
cp package.json "$ROOT/repo/app/"; cp -R out backend "$ROOT/repo/app/"; ln -s "$APP/node_modules" "$ROOT/repo/app/node_modules"
git -C "$ROOT/repo" init -q
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
echo "mode=$MODE key=$KEY"
ISO_BASE="$ROOT/repo/.git/corral-herdr-dev"
if [ "$MODE" = stale ]; then
  REAL=$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr
  CELL_BIN="$ISO_BASE/$KEY/herdr-0.9.0/target/debug/herdr"
  mkdir -p "$(dirname "$CELL_BIN")"; cp "$REAL" "$CELL_BIN"; cp "$REAL.json" "$CELL_BIN.json"
  printf 'x' >> "$CELL_BIN"
  echo "## 사본 칸 (바이너리 1바이트 덧붙임)"; shasum -a 256 "$REAL" "$CELL_BIN" | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g; s#$HOME#~#g"
fi
echo "## 사본 자리"; ls -R "$ISO_BASE" 2>&1 | head -5 | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g"
export HOME="$ROOT/h" XDG_CONFIG_HOME="$ROOT/h/.config" PATH=/usr/bin:/bin SHELL=/bin/sh TMPDIR="$ROOT" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/c.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots"
unset CORRAL_SESSION CORRAL_BACKEND_SOCKET CORRAL_HERDR_BIN HERDR_CONFIG_DIR
ELECTRON="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ "$MODE" = none ]; then
  PROFILE='(version 1)(allow default)(deny file-read* file-read-metadata (literal "/opt/homebrew/bin/herdr") (subpath "/opt/homebrew/Cellar/herdr"))'
  /usr/bin/sandbox-exec -p "$PROFILE" /bin/sh -c 'test -e /opt/homebrew/bin/herdr && echo "sandbox_probe visible" || echo "sandbox_probe hidden"'
  # 겹친 sandbox 안에서는 Chromium 자식 sandbox 가 초기화되지 못해 GPU 프로세스가 죽는다(run1 원자료) — 이 회차만 --no-sandbox.
  /usr/bin/sandbox-exec -p "$PROFILE" "$ELECTRON" "$ROOT/repo/app" --no-sandbox > "$ROOT/electron.log" 2>&1 &
else
  "$ELECTRON" "$ROOT/repo/app" > "$ROOT/electron.log" 2>&1 &
fi
PID=$!; echo "launcher_pid=$PID"
i=0; until [ -S "$ROOT/c.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
i=0; until grep -q '"herdr.resolve"' "$ROOT/corral.ndjson" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
sleep 4
echo "## herdr.resolve"; grep '"herdr.resolve"' "$ROOT/corral.ndjson" | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g; s#$HOME#~#g"
RES=$(grep '"herdr.resolve"' "$ROOT/corral.ndjson" | head -1)
echo "## backend.status"; grep '"backend.status"' "$ROOT/corral.ndjson" | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g" | cut -c1-600
"$NODE" scripts/l485/ctl.mjs "$ROOT/c.sock" "{\"cmd\":\"shot\",\"name\":\"c3-$MODE-card\"}" | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g"
CARD=$("$NODE" scripts/l485/ctl.mjs "$ROOT/c.sock" '{"cmd":"query","selector":"[data-backend-card]"}'); echo "card=$CARD" | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g; s#$HOME#~#g"
HINT=$("$NODE" scripts/l485/ctl.mjs "$ROOT/c.sock" '{"cmd":"query","selector":".backend-card-hint"}'); echo "hint=$HINT"
SERVERS=$(pgrep -fl -- "herdr.* server" | grep -- "$ROOT" ); echo "iso_servers=${SERVERS:-none}"
check no_server_spawned "$([ -z "$SERVERS" ] && echo 1)"
check hint_has_build_command "$(echo "$HINT" | grep -q 'npm --prefix app run herdr:guard' && echo 1)"
check hint_no_brew_install "$(echo "$CARD$HINT" | grep -q 'brew install' || echo 1)"
if [ "$MODE" = none ]; then
  check resolve_missing "$(echo "$RES" | grep -q '"found":false' && echo "$RES" | grep -q '레포 guard' && echo 1)"
  check card_missing "$(echo "$CARD" | grep -q 'herdr 를 찾지 못했습니다' && echo 1)"
else
  check resolve_stale "$(echo "$RES" | grep -q '"stale":true' && echo "$RES" | grep -q '바이너리 sha256' && echo 1)"
  check no_fallback_to_brew "$(grep '"herdr.resolve"' "$ROOT/corral.ndjson" | grep -q 'login-shell\|known-location' || echo 1)"
  check card_stale "$(echo "$CARD" | grep -q '체크아웃과 맞지 않습니다' && echo 1)"
fi
cp "$ROOT"/shots/*.png "$OUT/" 2>/dev/null
grep -E '"(herdr.resolve|backend.status|sessions.poll|session.select.note)"' "$ROOT/corral.ndjson" | sed "s#/private$ROOT#<root>#g; s#$ROOT#<root>#g; s#$HOME#~#g" > "$OUT/c3-$MODE-log.ndjson"
echo "## 종료"
kill "$PID" 2>/dev/null
for p in $(pgrep -f -- "$ROOT/repo/app"); do kill "$p" 2>/dev/null; done
i=0; while pgrep -f -- "$ROOT/repo/app" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "$ROOT/repo/app"; break; }; sleep 0.2; done
sleep 1; LEFT=$(pgrep -fl -- "$ROOT"); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
echo "fails=$FAILS"
[ "$FAILS" = 0 ]
