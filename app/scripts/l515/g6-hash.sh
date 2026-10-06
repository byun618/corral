#!/bin/sh
# LIFE-515 G6 — 사용자 설정 해시(읽기만). 시작·끝에 같은 목록을 찍어 대조한다.
# ~/.orca/keybindings.json · ~/.claude/settings.json · ~/.claude/hooks/* · ~/.codex/config.toml · ~/.grok/ 최상위 파일 · 사용자 corral settings.json·keybindings.json
UD="$HOME/Library/Application Support/corral"
for f in "$HOME/.orca/keybindings.json" "$HOME/.claude/settings.json" "$HOME"/.claude/hooks/* "$HOME/.codex/config.toml" "$HOME"/.grok/* "$UD/settings.json" "$UD/keybindings.json"; do
  if [ -f "$f" ]; then echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  $(wc -c <"$f" | tr -d ' ')B  ~/${f#$HOME/}"; fi
done
[ -f "$UD/keybindings.json" ] || echo "absent  ~/Library/Application Support/corral/keybindings.json"
