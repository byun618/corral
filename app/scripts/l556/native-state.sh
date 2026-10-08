#!/bin/sh
# LIFE-556 최종 관문 0·9번 — 사용자 기계 상태를 **읽기만** 해서 한 파일로 낸다(B9·B13 전후 대조).
# 인자: <출력 파일>. 홈 경로는 ~ 로 치환해 쓴다. 쓰는 곳은 출력 파일 하나뿐이다.
set -u
out="$1"
brew=/opt/homebrew/bin/herdr
bh() { env -i HOME="$HOME" PATH=/usr/bin:/bin "$brew" "$@"; }
hashes() { for f in "$@"; do if [ -f "$f" ]; then printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; else printf 'absent  %s\n' "$f"; fi; done; }
tree() { if [ -e "$1" ]; then find "$1" -type f -print0 | xargs -0 shasum -a 256 2>/dev/null | sort -k2; find "$1" -type s -o -type l 2>/dev/null | sed 's/^/special  /' | sort; else echo "absent  $1"; fi; }
{
  echo "== at $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "== corral 설치본 프로세스 (/Applications/corral.app)"
  ps -axo pid=,ppid=,args= | grep -F "/Applications/corral.app/" | grep -v grep || echo "none"
  echo "== brew default 서버 · life417-native · Orca 메인"
  ps -axo pid=,lstart=,args= | grep -E "^ *[0-9]+ .* (/opt/homebrew/bin/herdr server|.*--session life417-native server|/Applications/Orca.app/Contents/MacOS/Orca)$" | grep -v grep
  echo "== 동봉 서버 (corral.app backend/herdr)"
  ps -axo pid=,lstart=,args= | grep -F "corral.app/Contents/Resources/backend/herdr" | grep -v grep || echo "none"
  echo "== 설정 해시"
  hashes "$HOME/.orca/keybindings.json" "$HOME/.claude/settings.json" "$HOME/.claude.json" "$HOME/.codex/config.toml" "$HOME/.zshrc" "$HOME/.config/herdr/config.toml"
  echo "== ~/.grok/* (최상위 파일)"
  if [ -d "$HOME/.grok" ]; then for f in "$HOME"/.grok/*; do [ -f "$f" ] && hashes "$f"; done; else echo "absent ~/.grok"; fi
  echo "== 파일 목록+해시 ~/.config/herdr"; tree "$HOME/.config/herdr"
  echo "== 파일 목록+해시 ~/.local/state/herdr"; tree "$HOME/.local/state/herdr"
  echo "== 파일 목록+해시 ~/.herdr"; tree "$HOME/.herdr"
  echo "== 동봉 폴더 존재"
  for d in .config/corral-herdr .local/state/corral-herdr .corral-herdr; do [ -e "$HOME/$d" ] && echo "present ~/$d" || echo "absent ~/$d"; done
  echo "== brew herdr session list --json"; bh session list --json
  echo; echo "== brew default 탭·pane 수"
  bh tab list | python3 -c 'import json,sys; t=json.load(sys.stdin)["result"]["tabs"]; print("tabs", len(t), "panes", sum(x["pane_count"] for x in t))'
  bh pane list | python3 -c 'import json,sys; p=json.load(sys.stdin)["result"]["panes"]; print("pane_ids", " ".join(sorted(x["pane_id"] for x in p)))'
  echo "== brew 바이너리"
  ls -l "$brew"; printf 'realpath %s\nsha256 %s\n' "$(realpath "$brew")" "$(shasum -a 256 "$(realpath "$brew")" | cut -d' ' -f1)"
  echo "== ~/.local/bin/corral"; ls -l "$HOME/.local/bin/corral" 2>&1
  echo "== /Applications/corral.app"
  codesign -dvvv /Applications/corral.app 2>&1 | grep -E "^(CDHash|Identifier|Format)=" ; /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/corral.app/Contents/Info.plist 2>&1
  stat -f "mtime %Sm" /Applications/corral.app
  echo "== 로그인 셸 command -v herdr / corral"
  /bin/zsh -lc 'command -v herdr; echo "herdr rc $?"; command -v corral; echo "corral rc $?"' 2>&1
} 2>&1 | sed "s#$HOME#~#g" > "$out"
