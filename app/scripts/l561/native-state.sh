#!/bin/sh
# LIFE-561 최종 관문 C9 — 사용자 기계 상태를 읽기만 해서 남긴다(전후 대조용). 어떤 herdr 서버에도 명령·조회를 보내지 않는다(ps·파일 해시만).
# 출력은 홈 경로를 ~ 로 바꾼다. 사용: sh scripts/l561/native-state.sh > <파일>
H=$HOME
echo "# native-state $(date '+%F %T')"
echo "## herdr·corral 프로세스 (pid ppid lstart command)"
ps -axo pid=,ppid=,lstart=,command= | grep -E '/herdr( |$)|herdr --session|corral\.app/Contents/MacOS|backend/herdr' | grep -v grep | sed "s#$H#~#g" | cut -c1-200
echo "## brew default 서버: $(pgrep -fx '/opt/homebrew/bin/herdr server' | tr '\n' ' ')"
echo "## life417-native 서버: $(pgrep -f 'herdr --session life417-native server' | tr '\n' ' ')"
echo "## 설치본 동봉 서버: $(pgrep -fx '/Applications/corral.app/Contents/Resources/backend/herdr server' | tr '\n' ' ')"
echo "## 설치본 corral 앱: $(pgrep -f '/Applications/corral.app/Contents/MacOS/corral' | tr '\n' ' ')"
echo "## brew 링크"; ls -l /opt/homebrew/bin/herdr 2>&1 | sed "s#$H#~#g" | awk '{$1=$1; print}' | sed 's/^[^ ]* [^ ]* [^ ]* [^ ]* [^ ]* //'
echo "## ~/.config/herdr 파일 해시"; (cd "$H/.config/herdr" 2>/dev/null && find . -type f ! -name '*.log' ! -name '*.log.*' | sort | while read f; do shasum -a 256 "$f"; done)
echo "## ~/.config/herdr 로그 파일(내용이 늘 바뀜 — 목록만)"; (cd "$H/.config/herdr" 2>/dev/null && find . -type f \( -name '*.log' -o -name '*.log.*' \) | sort)
echo "## 사용자 userData profile.json"; shasum -a 256 "$H/Library/Application Support/corral/runtime/profile.json" 2>&1 | sed "s#$H#~#g"
echo "## 설정 파일 해시"; for f in .orca/keybindings.json .claude/settings.json .claude.json .codex/config.toml .zshrc; do shasum -a 256 "$H/$f" 2>&1 | sed "s#$H#~#g"; done
(cd "$H/.grok" 2>/dev/null && find . -maxdepth 1 -type f | sort | while read f; do shasum -a 256 "$f" | sed 's#\./#~/.grok/#'; done)
echo "## ~/.config/herdr-dev/sessions"; ls -1 "$H/.config/herdr-dev/sessions" 2>&1 | sed "s#$H#~#g"
echo "## 고정 자리 칸 목록"; ls -1 "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev" 2>&1 | sed "s#$H#~#g"
echo "## /tmp/l561*"; ls -d /private/tmp/l561* 2>/dev/null
