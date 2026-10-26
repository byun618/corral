#!/bin/sh
# LIFE-532 G6 — 사용자 리소스 해시(읽기만). 같은 목록을 회차 전·후에 찍어 diff 로 대조한다. 사용: sh g6.sh <출력 파일>
# 대상(엄격): 설치본 Info.plist·실행 파일·app.asar / userData 설정·상태(settings·keybindings·Local State·work-connections·work-machine·work-start-pending) /
#   ~/.config/herdr 설정·세션 파일(config.toml·session.json·release-notes.json·sessions/*/ 의 일반 파일) / 설치본 main 프로세스 pid.
# 제외(사유): userData 의 corral.ndjson·herdr-server.log(로그) · Preferences·DIPS·Cookies·캐시 폴더(Chromium 이 돌며 쓴다) ·
#   repos.json·ui-prefs.json·work-activity.json(설치본 앱이 사용 중 계속 쓴다 — 다른 세션의 작업) · runtime/(런타임 소켓·상태) ·
#   ~/.config/herdr/sessions 아래 *.log(로그) · ~/.config/corral-herdr/(설치본 동봉 서버가 돌며 session.json·로그를 쓴다). 제외 목록은 참고로 mtime 만 찍는다(대조 아님).
# 실패하면 exit 3 — 빈 출력이 통과로 읽히지 않게.
set -u
OUT=$1; : > "$OUT" || exit 3
UD="$HOME/Library/Application Support/corral"
h() { if [ -f "$1" ]; then s=$(shasum -a 256 "$1") || exit 3; echo "${s%% *}  $(wc -c < "$1" | tr -d ' ')B  $1" >> "$OUT"; elif [ -e "$1" ]; then echo "g6: 파일 아님 $1" >&2; exit 3; else echo "absent  $1" >> "$OUT"; fi; }
for f in /Applications/corral.app/Contents/Info.plist /Applications/corral.app/Contents/MacOS/corral /Applications/corral.app/Contents/Resources/app.asar \
  "$UD/settings.json" "$UD/keybindings.json" "$UD/Local State" "$UD/work-connections.json" "$UD/work-machine.json" "$UD/work-start-pending.json" \
  "$HOME/.config/herdr/config.toml" "$HOME/.config/herdr/session.json" "$HOME/.config/herdr/release-notes.json"; do h "$f"; done
find "$HOME/.config/herdr/sessions" -type f ! -name "*.log" 2>/dev/null | LC_ALL=C sort > /tmp/l532t/g6-sessions.$$ || exit 3
while IFS= read -r f; do h "$f"; done < /tmp/l532t/g6-sessions.$$
rm -f /tmp/l532t/g6-sessions.$$
# 설치본 main = 실행 파일이 MacOS/corral 이고 PPID 1(launchd) 이며 CLI(app.asar.unpacked/cli/corral.mjs)가 아닌 행. 같은 실행 파일로 도는 CLI 호출
# (코디의 `orchestration check --block` 등)은 수시로 생기고 끝나 대상이 아니다(fg-08 에서 그 행이 섞여 실패했다). 시작 시각을 같이 찍는다.
P=$(ps -Ao pid=,ppid=,command= | awk '$3 == "/Applications/corral.app/Contents/MacOS/corral" && $2 == 1 && $0 !~ /cli\/corral\.mjs/ {print $1}')
[ -n "$P" ] || { echo "g6: 설치본 main 프로세스 없음" >&2; exit 3; }
for p in $P; do echo "pid  설치본 main  $p  시작 $(ps -o lstart= -p "$p")" >> "$OUT"; done
echo "## 참고(대조 아님) — 제외 목록 mtime" >&2
for f in "$UD/repos.json" "$UD/ui-prefs.json" "$UD/work-activity.json" "$HOME/.config/corral-herdr/session.json"; do stat -f '%Sm %N' "$f" >&2; done
[ -s "$OUT" ] || exit 3
echo "g6: $(grep -c . "$OUT")줄"
