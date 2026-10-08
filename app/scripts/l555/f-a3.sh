#!/bin/sh
# LIFE-555 A3 — PATH 의 corral 로 ⓐ 기본 셸(node v20) ⓑ node 부재 PATH 각각 --version·open·status exit 0. 끝에 앱을 끈다.
# 사용: sh f-a3.sh <원자료 폴더>   (PATH 를 건드리지 않은 이 세션의 기본 셸에서)
. "$(dirname "$0")/f-lib.sh"
OUT=$1
VER_PLIST=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INST/Contents/Info.plist")
VER_PKG=$("$N" -p "require('$APPDIR/package.json').version")
check plist_eq_package "$VER_PLIST" "$VER_PKG"
check app_off_at_start "$(inst_mains | grep -c .)" 0
leg() {
  NAME=$1
  echo "### [$NAME] PATH=$PATH"
  CV=$(command -v corral); echo "command -v corral = $CV"
  [ -n "$CV" ] && echo "심링크 해소: $(readlink "$CV") · 실경로 $(cd "$(dirname "$CV")" && cd -P "$(dirname "$(readlink "$CV")")" && pwd)/$(basename "$(readlink "$CV")")"
  NV=$(command -v node); echo "command -v node = [$NV] $( [ -n "$NV" ] && node -v)"
  check "$NAME.corral_is_shim_link" "$CV" "$SHIM_LINK"
  check "$NAME.link_target" "$(readlink "$CV")" "$INST/Contents/Resources/bin/corral"
  V=$(corral --version); RC=$?; echo "corral --version → $V (exit $RC)"
  check "$NAME.version_exit0" "$RC" 0; check "$NAME.version_eq_plist" "$V" "$VER_PLIST"
  corral open --json > "$TMPF.open"; RC=$?; cut -c1-500 "$TMPF.open"; echo; check "$NAME.open_exit0" "$RC" 0
  corral status --json > "$TMPF.status"; RC=$?; cut -c1-500 "$TMPF.status"; echo; check "$NAME.status_exit0" "$RC" 0
  echo "runtime pid=$(json_get 'r.result.runtime.pid' < "$TMPF.status") runtimeId=$(json_get 'r.result.runtime.runtimeId' < "$TMPF.status") socket=$(json_get 'r.result.target.socket' < "$TMPF.status")"
}
TMPF=/tmp/l555f-a3; 
echo "## ⓐ 기본 셸"; leg default
check default.node_present "$([ -n "$(command -v node)" ] && echo yes)" yes
PID1=$(json_get 'r.result.runtime.pid' < "$TMPF.status"); RID1=$(json_get 'r.result.runtime.runtimeId' < "$TMPF.status")
echo "## ⓑ node 부재 PATH (양성 대조: 위 ⓐ 의 같은 셸에서 command -v node 는 결과가 있었다)"
OLDPATH=$PATH; PATH=/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin; export PATH
check nonode.node_absent "$(command -v node)" ""
control nonode.node_absent "$(PATH=$OLDPATH command -v node)" ""
leg nonode
PATH=$OLDPATH; export PATH
check nonode.same_runtime "$(json_get 'r.result.runtime.runtimeId' < "$TMPF.status")" "$RID1"
echo "## 앱 main 프로세스"; ps -o pid,ppid,command -p "$PID1"
check app_exe "$(ps -o command= -p "$PID1" | cut -d' ' -f1)" "$INST/Contents/MacOS/corral"
check single_main "$(inst_mains | grep -c .)" 1
echo "## 끄기 (SIGTERM $PID1)"; stop_pid "$PID1"; sleep 1
check app_off_at_end "$(inst_mains | grep -c .)" 0
rm -f "$TMPF".*
echo "fails=$FAILS"; exit $FAILS
