#!/bin/sh
# LIFE-565 최종 관문 — 렌더러 합성 마우스 회차(실제 xterm Linkifier 경로). app/ 에서, up.sh 뒤: sh scripts/l565/synthetic.sh
set -u
N="$HOME/.nvm/versions/node/v24.14.1/bin/node"; P=$(cat /tmp/l565n/http.port)
show() { "$N" -e "import('./scripts/l565/lib.mjs').then(async (l) => { await l.run(process.argv[1]); await l.pause(1500); const t = await l.termRead(); console.log(t.cols + 'x' + t.rows); console.log(t.lines.filter(x=>x.trim()).map(x=>x.replace(/ +\$/,'')+'|').join('\n')) })" "$1"; }
c() { "$N" scripts/l565/click.mjs "$@"; }
echo "## 평문 · C3ⓐ · C1ⓐ"
show "clear; printf 'C1a plain: http://localhost:$P/l565-c1a-plain done\n'"
c C3a-nomod "localhost:" false 0 5
c C1a-meta "localhost:" true 0 5
echo "## OSC 8 · C2ⓐ(example.com) · ⓒ 라벨≠URI"
show "clear; printf '\033]8;;https://example.com/l565-c2a-osc8\033\\\\c2a-label-zz\033]8;;\033\\\\\n'; printf '\033]8;;http://localhost:$P/l565-c2c-uri\033\\\\http://localhost:$P/l565-c2c-label\033]8;;\033\\\\\n'"
c C2a-osc8 "c2a-label" true 0 4
sleep 2; echo "arc_front_tab(읽기)=$(osascript -e 'tell application "Arc" to get URL of active tab of window 1' 2>&1)"
c C2c-label-ne-uri "l565-c2c-label" true 0 2
echo "## C3ⓑ 허용 밖 스킴 · ⓗ 상대 URI"
show "clear; printf '\033]8;;file:///etc/hosts\033\\\\o-file-lbl\033]8;;\033\\\\\n\033]8;;javascript:window.__l565=1\033\\\\o-js-lbl\033]8;;\033\\\\\n\033]8;;data:text/html,<h1>l565</h1>\033\\\\o-data-lbl\033]8;;\033\\\\\n\033]8;;ftp://example.com/l565-oftp\033\\\\o-ftp-lbl\033]8;;\033\\\\\n\033]8;;l565-relative-uri\033\\\\o-rel-lbl\033]8;;\033\\\\\n'; printf 'p1 file:///etc/hosts x\np2 ftp://example.com/l565-pftp x\np3 javascript://x%%0Awindow.__l565=2 x\n'"
c C3b-osc-file o-file-lbl true 0 1
c C3b-osc-js o-js-lbl true 0 1
c C3b-osc-data o-data-lbl true 0 1
c C3b-osc-ftp o-ftp-lbl true 0 1
c H-osc-relative o-rel-lbl true 0 1
c C3b-plain-file "file:///" true 0 2
c C3b-plain-ftp "ftp://exa" true 0 2
c C3b-plain-js "javascript:" true 0 3
echo "## ⓕ 대문자 스킴 · C4ⓐ/ⓔ 멀티행 둘째 행"
LONG="http://localhost:$P/l565-c4e-$(python3 -c "print('w'*90+'/'+'z'*60)")"; echo "c4e_url=$LONG"
show "clear; printf 'up HTTP://LOCALHOST:$P/l565-upper x\n'; printf '$LONG\n'"
c Cf-upper "HTTP://LOC" true 0 3
c C4e-second-row "zzzzz" true 0 2
c C4a-first-row "l565-c4e" true 0 2
