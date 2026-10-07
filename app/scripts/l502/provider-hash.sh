#!/bin/sh
# LIFE-502 G5 — provider·herdr·orca 설정 해시(읽기만). 사용: sh provider-hash.sh > <파일>. 없는 파일은 「없음」.
for f in "$HOME/.codex/config.toml" "$HOME/.claude/settings.json" "$HOME/.orca/keybindings.json" "$HOME/.config/herdr/config.toml" "$HOME/.grok/config.toml" "$HOME/.grok/settings.json"; do
  if [ -f "$f" ]; then shasum -a 256 "$f"; else echo "없음  $f"; fi
done
