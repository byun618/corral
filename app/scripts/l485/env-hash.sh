#!/bin/sh
# LIFE-485 G6·G7 — 사용자 설정·herdr 루트의 해시와 herdr 상태를 찍는다(읽기만). 사용: sh env-hash.sh
for f in "$HOME/.orca/keybindings.json" "$HOME/.claude/settings.json" "$HOME/.codex/config.toml" "$HOME/.config/herdr/config.toml" "$HOME/.config/herdr/session.json"; do
  if [ -f "$f" ]; then printf '%s\t%s\t%s\n' "$(wc -c < "$f" | tr -d ' ')" "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$f"; else printf 'absent\t-\t%s\n' "$f"; fi
done
echo "## user herdr default socket: $( [ -S "$HOME/.config/herdr/herdr.sock" ] && echo present || echo absent)"
echo "## user herdr default (session list, env -u XDG_CONFIG_HOME):"
env -u XDG_CONFIG_HOME /opt/homebrew/bin/herdr session list --json | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin); print([ (s['name'], s['running']) for s in d['sessions'] if s['default']])"
echo "## herdr server 프로세스 (양성 대조: life417-native 행):"
ps -Ao pid,ppid,pgid,lstart,command | grep -E '/[h]erdr( --session [^ ]+)? server$' || echo '(없음)'
echo "## life417-native pid 44782: $(kill -0 44782 2>/dev/null && echo alive || echo GONE)"
