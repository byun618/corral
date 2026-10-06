#!/bin/sh
# LIFE-485 fix1 F1 (r1 R1-01) — 서버는 돌고 링크만 끊길 때 pane 격자가 재마운트되지 않고 배너만 뜨는지(격리).
# 격리 이름 세션 서버(XDG 루트) ← link-proxy(control 만 끊음) ← corral(바인딩 env, 최소 PATH). 워크트리 카드를 실제 클릭해 셸 pane 을 연 뒤
# xterm DOM 노드를 표식으로 잡고(window.__l485x) 링크를 끊었다가 재연결 뒤 같은 노드인지 본다. 사용: sh scenario-f1.sh <ROOT> <app 디렉터리>
ROOT=$1; APPDIR=$2; . "$(dirname "$0")/lib.sh"; APP=$APPDIR
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
REPO="$ROOT/repo"; mkdir -p "$REPO" && git -C "$REPO" init -q && git -C "$REPO" -c user.email=l485@x -c user.name=l485 commit -q --allow-empty -m init
XDG_CONFIG_HOME="$ROOT/xdg" nohup /opt/homebrew/bin/herdr --session l485p server > "$ROOT/server.log" 2>&1 & HS=$!
SD="$ROOT/xdg/herdr/sessions/l485p"; i=0; until [ -S "$SD/herdr.sock" ] && [ -S "$SD/herdr-client.sock" ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
echo "격리 서버 pid $HS"
mkdir -p "$ROOT/px"; "$N" "$H/link-proxy.mjs" "$ROOT/px" "$SD" 6000 > "$ROOT/proxy.log" 2>&1 & PX=$!
i=0; until [ -S "$ROOT/px/herdr.sock" ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
echo "프록시 pid $PX"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_BACKEND_SOCKET="$ROOT/px/herdr.sock" CORRAL_SESSION=l485p
wait_phase live 150 && echo "link live"
ctl "{\"cmd\":\"add-repo\",\"root\":\"$REPO\"}" | cut -c1-160
sleep 1
REPO_REAL=$(cd "$REPO" && pwd -P)  # 레지스트리는 실경로(/private/tmp)로 싣는다(r34 에서 선택자가 빗나갔다)
ctl "{\"cmd\":\"click\",\"selector\":\"[data-worktree=\\\"$REPO_REAL\\\"] [data-worktree-card-surface]\"}" | cut -c1-200
i=0; until [ "$(ctl '{"cmd":"eval","code":"document.querySelectorAll(\"[data-main-area] .xterm\").length"}' | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")" -ge 1 ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
sleep 3  # 첫 마운트 뒤 격자가 한 번 더 그려진다(r35 — 표식 직후 노드가 바뀌었다). 가라앉은 뒤 표식하고 2초 안정을 확인한다
MARK='(() => { window.__l485x = document.querySelector("[data-main-area] .xterm"); return { xterms: document.querySelectorAll("[data-main-area] .xterm").length, marked: !!window.__l485x } })()'
ctl "{\"cmd\":\"eval\",\"code\":$(printf '%s' "$MARK" | "$N" -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')}"
PROBE='(() => { const x = document.querySelector("[data-main-area] .xterm"); return { sameNode: !!window.__l485x && x === window.__l485x, markedConnected: !!window.__l485x && window.__l485x.isConnected, xterms: document.querySelectorAll("[data-main-area] .xterm").length, banner: document.querySelector("[data-backend-banner]")?.innerText ?? null, card: document.querySelector("[data-backend-card]")?.getAttribute("data-backend-card") ?? null } })()'
PJ=$(printf '%s' "$PROBE" | "$N" -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')
probe() { ctl "{\"cmd\":\"eval\",\"code\":$PJ}" | /usr/bin/python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['result'], ensure_ascii=False))"; }
sleep 2; echo "## 끊기 전(표식 2초 뒤)"; probe
check "F1 끊기 전 같은 노드" "$(probe | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['sameNode'])")" True
echo "## 링크만 끊는다 (SIGUSR1 → 프록시, 6초)"; kill -USR1 "$PX"
SEEN_RECON=no; SEEN_BANNER=no; LOST=no; SEEN_CARD=no
i=0; while [ $i -lt 40 ]; do i=$((i+1)); sleep 0.2
  P=$(probe); K=$(st "d['backend']['kind'] + '/' + d['link']['phase']")
  echo "t$i $K $P"
  echo "$K" | grep -q '^reconnecting/' && SEEN_RECON=yes
  echo "$P" | grep -q '"banner": "herdr' && SEEN_BANNER=yes
  echo "$P" | grep -q '"card": "' && SEEN_CARD=yes
  echo "$P" | grep -q '"sameNode": false' && LOST=yes
done
[ "$SEEN_BANNER" = yes ] && ctl '{"cmd":"shot","name":"f1-banner"}' | cut -c1-120
wait_phase live 150 && echo "link live (재연결)"; sleep 1
echo "## 재연결 뒤"; probe
AFTER_SAME=$(probe | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['sameNode'])")
AFTER_BANNER=$(probe | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['banner'])")
ctl '{"cmd":"shot","name":"f1-after"}' | cut -c1-120
echo "요약: 재연결중 관측=$SEEN_RECON · 배너 관측=$SEEN_BANNER · 카드 관측=$SEEN_CARD · 끊긴 동안 노드 바뀜=$LOST · 재연결 뒤 sameNode=$AFTER_SAME · 재연결 뒤 배너=$AFTER_BANNER"
cat "$ROOT/proxy.log" | head -20
app_stop; kill "$PX"; XDG_CONFIG_HOME="$ROOT/xdg" /opt/homebrew/bin/herdr --session l485p server stop >/dev/null 2>&1; sleep 1; kill -0 "$HS" 2>/dev/null && kill "$HS"
echo "정리: 서버 $(kill -0 "$HS" 2>/dev/null && echo alive || echo gone) · 프록시 $(kill -0 "$PX" 2>/dev/null && echo alive || echo gone)"
# 판정은 호출자가 빌드별 기대(구현: 재마운트 0·배너, r1: 재마운트·카드)로 요약 줄을 본다
EXPECT=${L485_F1_EXPECT:-fix}
if [ "$EXPECT" = fix ]; then
  check "F1 재연결 중 관측" "$SEEN_RECON" yes; check "F1 배너" "$SEEN_BANNER" yes; check "F1 카드 없음" "$SEEN_CARD" no; check "F1 재마운트 0(끊긴 동안)" "$LOST" no
  check "F1 재연결 뒤 같은 노드" "$AFTER_SAME" True; check "F1 재연결 뒤 배너 사라짐" "$AFTER_BANNER" None
else
  check "양성 대조 재연결 중 관측" "$SEEN_RECON" yes; check "양성 대조 카드" "$SEEN_CARD" yes; check "양성 대조 재마운트 잡힘(끊긴 동안 또는 재연결 뒤)" "$( [ "$LOST" = yes ] || [ "$AFTER_SAME" = False ] && echo yes || echo no)" yes
fi
echo "FAIL=$FAIL"; exit $FAIL
