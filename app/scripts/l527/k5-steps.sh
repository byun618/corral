#!/bin/zsh
# LIFE-527 K5 — OS 수준 입력 한 단계: 렌더러 이벤트 기록 비우기 → cliclick(os-act 안전 확인) → 결과 한 줄(JSON) 을 out 에 덧붙인다.
# step.sh <port> <pid> <창 번호> <out.jsonl> <라벨> <cliclick 명령…>
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-527-titlebar-claude
S=app/scripts/l527
port=$1 pid=$2 win=$3 out=$4 label=$5; shift 5
$S/ev.sh $port 'Object.assign(window, { __l527: [], __l527move: null }) && true' > /dev/null
act=$($S/act.sh $pid $win "$label" "$@"); code=$?
sleep 0.8
seen=$($S/ev.sh $port '({ events: window.__l527, move: window.__l527move, sidebar: document.querySelector("[data-sidebar-toggle]")?.dataset.sidebarToggle ?? (document.querySelector(".titlebar-left-floating") ? "floating" : null), tabs: [...document.querySelectorAll("[data-main-tab], [data-tab-group-strip-id] [role=tab]")].map((tab) => tab.textContent.trim().slice(0, 24)), menus: [...document.querySelectorAll(".tab-create-menu, .tab-context-menu, .ctx-menu, [role=menu]")].map((menu) => { const b = menu.getBoundingClientRect(); return [menu.className.toString().slice(0, 40), Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }), settings: Boolean(document.querySelector("[data-settings-topbar], .settings-page, [data-settings-page]")), zoom: window.devicePixelRatio })')
echo "{\"label\":$(printf '%s' "$label" | /usr/bin/python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"exit\":$code,\"act\":${act:-null},\"seen\":${seen:-null}}" >> $out
echo "$label exit=$code act=$act"
echo "  seen=$seen" | cut -c1-600
