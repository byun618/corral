#!/bin/sh
# LIFE-490 K8 — l485/card.sh 복사(코드 줄의 l485→l490·L485→L490·ROOT 꼴 /tmp/l490n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 K5 — 카드 상태 DOM 덤프 + main 상태의 backend·link + 스크린샷. 사용: sh card.sh <ROOT> <라벨>
ROOT=$1; L=$2; N="$HOME/.nvm/versions/node/v24.14.1/bin/node"; H=$(dirname "$0")
echo "## DOM [data-backend-card]"
"$N" "$H/ctl.mjs" "$ROOT/ctl.sock" '{"cmd":"eval","code":"(() => { const c = document.querySelector(\"[data-backend-card]\"); if (!c) return {card:null, sidebarRepos: document.querySelectorAll(\"[data-repo]\").length, termEmpty: !!document.querySelector(\"[data-term-empty]\")}; return {card: c.getAttribute(\"data-backend-card\"), text: c.innerText, buttons: Array.from(c.querySelectorAll(\"button\")).map(b => b.innerText), restore: c.querySelector(\"[data-backend-restore]\")?.getAttribute(\"data-backend-restore\") ?? null} })()"}'
echo "## main state.backend / link"
"$N" "$H/ctl.mjs" "$ROOT/ctl.sock" '{"cmd":"state"}' | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin)['state']; print(json.dumps({'backend':d['backend'],'link':{k:d['link'][k] for k in ('phase','sessionName','attempt')},'selected':d['selectedSession'],'sessions':d['sessions']}, ensure_ascii=False))"
echo "## shot"
"$N" "$H/ctl.mjs" "$ROOT/ctl.sock" "{\"cmd\":\"shot\",\"name\":\"$L\"}"
