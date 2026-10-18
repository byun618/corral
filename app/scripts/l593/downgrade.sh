#!/bin/sh
# LIFE-593 최종 관문 E5ⓔ — 다운그레이드 안전. 같은 userData(<ROOT>/ud)를 HEAD 빌드 → 기준 빌드(BASE_APP) → HEAD 빌드 순으로 띄운다.
#   1 HEAD: ⌘P 로 target 을 열어 recentFiles 기록(recent-restart open) → 내림 → 기본값 아닌 설정 칸을 심는다(seed-other)
#   2 BASE: 뜨는지(렌더러) · 심은 설정을 읽었는지(getUiPrefs) · 저장 1회(setUiPrefs sidebarWidth 접힘 아님 값) → 내림 → 파일에서 다른 칸 그대로인지
#   (G68 뒤) 대조는 previewTabId: null 과 칸 없음을 같게 본다 — 둘 다 「미리보기 탭 없음」이고 기준 빌드 직렬화가 null 칸을 뺀다(G68 원자료).
#   3 HEAD: 다시 뜨는지 · 다른 칸 그대로인지(recentFiles 는 기준 빌드가 저장하며 버렸을 수 있다 — 기록만)
# 사용(app/ 에서): sh scripts/l593/downgrade.sh <ROOT=/tmp/l593g-*> <FAKE=/tmp/l593g-f*> <BASE_APP=…/app> <OUT 접두사>
set -u
R=$1; F=$2; B=$3; OUT=$4; HEAD_APP=$PWD
case "$R" in /tmp/l593g-*) ;; *) echo "ROOT 는 /tmp/l593g-*"; exit 2 ;; esac
[ -e "$R" ] && { echo "ROOT 가 이미 있다"; exit 2; }
P="$R/ud/ui-prefs.json"
q() { node --input-type=module -e "import { evalJs, until } from '$HEAD_APP/scripts/l577/g-lib.mjs'; const r = process.argv[1]; await until(() => evalJs(r, \"!!document.querySelector('.app-body')\"), { timeoutMs: 30000, label: '렌더러' }); console.log(JSON.stringify(await evalJs(r, process.argv[2])))" "$R" "$1"; }
mkdir -p "$R" && node scripts/l593/fixture.mjs "$R/repo" > /dev/null || exit 3
echo "## 1 HEAD $(git rev-parse --short HEAD)"
sh scripts/l577/g-up.sh "$R" "$F" L577_KEEP_PAINTING=1 | tail -1
node scripts/l593/recent-restart.mjs open "$R" "$OUT-open.json"; a=$?; echo "open_exit=$a"
sh scripts/l577/g-down.sh "$R" term | tail -1
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1]));Object.assign(p,{sidebarWidth:333,explorerShowDotfiles:false,explorerShowIgnored:false,rightPanelWidth:411,pinnedWorktrees:['/tmp/l593-pin-x'],collapsedRepos:['/tmp/l593-col-x']});fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2))" "$P"
cp "$P" "$OUT-1-head.json"
echo "## 2 BASE $(git -C "$B/.." rev-parse --short HEAD 2>/dev/null) at $B"
(cd "$B" && sh scripts/l577/g-up.sh "$R" "$F" L577_KEEP_PAINTING=1 | tail -1)
echo "base_read=$(q "(async () => { const p = await window.corral.getUiPrefs(); return { sidebarWidth: p.sidebarWidth, explorerShowDotfiles: p.explorerShowDotfiles, explorerShowIgnored: p.explorerShowIgnored, rightPanelWidth: p.rightPanelWidth, pinnedWorktrees: p.pinnedWorktrees, collapsedRepos: p.collapsedRepos, hasRecentFiles: 'recentFiles' in p } })()")"
q "(() => { window.corral.setUiPrefs({ sidebarWidth: 334 }); return true })()" > /dev/null; sleep 1
(cd "$B" && sh scripts/l577/g-down.sh "$R" term | tail -1)
cp "$P" "$OUT-2-base.json"
echo "## 3 HEAD again"
sh scripts/l577/g-up.sh "$R" "$F" L577_KEEP_PAINTING=1 | tail -1
echo "head_read=$(q "(async () => { const p = await window.corral.getUiPrefs(); return { sidebarWidth: p.sidebarWidth, explorerShowDotfiles: p.explorerShowDotfiles, explorerShowIgnored: p.explorerShowIgnored, rightPanelWidth: p.rightPanelWidth, pinnedWorktrees: p.pinnedWorktrees, collapsedRepos: p.collapsedRepos, recentFiles: p.recentFiles } })()")"
sh scripts/l577/g-down.sh "$R" term herdr | tail -1
cp "$P" "$OUT-3-head.json"
node -e "
const fs=require('fs');const norm=(t)=>t.replace(/,\\s*\"previewTabId\":\\s*null/g,'');const [h,b,h2]=process.argv.slice(1).map((f)=>JSON.parse(norm(fs.readFileSync(f,'utf8'))));
const keys=Object.keys(h).filter((k)=>k!=='recentFiles'&&k!=='sidebarWidth');
const lost=keys.filter((k)=>JSON.stringify(h[k])!==JSON.stringify(b[k]));
const lost2=keys.filter((k)=>JSON.stringify(h[k])!==JSON.stringify(h2[k]));
console.log('base_changed_other_keys='+JSON.stringify(lost)+' base_sidebarWidth='+b.sidebarWidth+' base_recentFiles='+JSON.stringify(b.recentFiles??null));
console.log('head2_changed_other_keys='+JSON.stringify(lost2)+' head2_sidebarWidth='+h2.sidebarWidth);
process.exit(a=lost.length===0&&b.sidebarWidth===334&&lost2.length===0?0:1)" "$OUT-1-head.json" "$OUT-2-base.json" "$OUT-3-head.json"; c=$?
sleep 1
echo "# leftover_app_pids=[$(pgrep -f -- "--user-data-dir=$R/ud" | tr '\n' ' ')] orphan_ppid1=[$(ps -axo pid=,ppid=,command= | awk -v r="$R" '$2==1 && index($0, r)>0 {print $1}' | tr '\n' ' ')]"
[ $a -eq 0 ] && [ $c -eq 0 ]
